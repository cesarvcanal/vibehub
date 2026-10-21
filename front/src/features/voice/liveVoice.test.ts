import { afterEach, describe, expect, it, vi } from "vitest";
import { ACTIVITY_WINDOW_MS, CLOSE_TIMEOUT_MS, LiveVoiceSession, START_TIMEOUT_MS, STATS_INTERVAL_MS, aiActivity, errorMessage } from "./liveVoice";
import { fakeRig, FakeStream } from "./fakeWebRtc";

afterEach(() => {
  vi.useRealTimers();
});

/** Started and confirmed by `session.started`. */
async function liveSession(rig = fakeRig()) {
  const session = new LiveVoiceSession(rig.deps);
  await session.start();
  rig.peer().channel!.emit({ type: "session.started", session: { id: "live_1" } });
  return { session, rig };
}

function released(rig: ReturnType<typeof fakeRig>): boolean {
  return rig.mic().tracks.every((t) => t.stopped) && rig.peer().closed && rig.audio.srcObject === null;
}

describe("LiveVoiceSession — start", () => {
  it("sends the mic, opens oai-events before the offer, and goes live on session.started", async () => {
    const rig = fakeRig();
    const session = new LiveVoiceSession(rig.deps);
    const states: string[] = [];
    session.subscribe(() => {
      const state = session.snapshot().state;
      if (states[states.length - 1] !== state) states.push(state);
    });

    await session.start();
    expect(session.snapshot().state).toBe("connecting");
    expect(rig.peer().channel?.label).toBe("oai-events");
    expect(rig.peer().tracks).toHaveLength(1);
    expect(rig.exchanges[0]?.sdp).toBe("v=0 offer");
    expect(rig.peer().remoteDescription).toEqual({ type: "answer", sdp: "v=0 answer" });

    rig.peer().channel!.emit({ type: "session.started", session: { id: "live_1" } });
    expect(session.snapshot().state).toBe("live");
    expect(states).toEqual(["connecting", "live"]);
    // The HTTP request starts the session: the client never sends session.start.
    expect(rig.peer().channel!.sent.map((e) => e.type)).not.toContain("session.start");
  });

  it("asks for echo cancellation, so the assistant does not interrupt itself", async () => {
    const rig = fakeRig();
    const spy = vi.spyOn(rig.deps, "getUserMedia");
    await new LiveVoiceSession(rig.deps).start();
    expect(spy.mock.calls[0]?.[0]).toMatchObject({ audio: { echoCancellation: true } });
  });

  it("is idempotent: a second start while connecting or live does nothing", async () => {
    const { session, rig } = await liveSession();
    await session.start();
    expect(rig.exchanges).toHaveLength(1);
  });

  it("denied microphone → error state, nothing left open", async () => {
    const rig = fakeRig({ getUserMedia: async () => { throw Object.assign(new Error("denied"), { name: "NotAllowedError" }); } });
    const session = new LiveVoiceSession(rig.deps);
    await session.start();
    expect(session.snapshot()).toMatchObject({ state: "error", error: "voice.err.micDenied" });
  });

  it("back-end refusal → error with the server's message, mic and peer released", async () => {
    const rig = fakeRig({
      exchangeOffer: async () => { throw { response: { data: { error: "OpenAI rejected the API key" } } }; },
    });
    const session = new LiveVoiceSession(rig.deps);
    await session.start();
    expect(session.snapshot()).toMatchObject({ state: "error", error: "OpenAI rejected the API key" });
    expect(released(rig)).toBe(true);
  });

  it("a startup error event fails the session", async () => {
    const rig = fakeRig();
    const session = new LiveVoiceSession(rig.deps);
    await session.start();
    rig.peer().channel!.emit({ type: "error", error: { message: "invalid session" } });
    expect(session.snapshot()).toMatchObject({ state: "error", error: "invalid session" });
    expect(released(rig)).toBe(true);
  });

  it("times out when session.started never comes", async () => {
    vi.useFakeTimers();
    const rig = fakeRig();
    const session = new LiveVoiceSession(rig.deps);
    await session.start();
    vi.advanceTimersByTime(START_TIMEOUT_MS);
    expect(session.snapshot()).toMatchObject({ state: "error", error: "voice.err.startTimeout" });
    expect(released(rig)).toBe(true);
  });

  it("can start again after an error", async () => {
    let fail = true;
    const rig = fakeRig({
      exchangeOffer: async () => {
        if (fail) throw new Error("boom");
        return { sessionId: "live_2", sdp: "v=0 answer" };
      },
    });
    const session = new LiveVoiceSession(rig.deps);
    await session.start();
    expect(session.snapshot().state).toBe("error");
    fail = false;
    await session.start();
    expect(session.snapshot()).toMatchObject({ state: "connecting", error: null });
  });
});

describe("LiveVoiceSession — cancel and stop", () => {
  it("stop while connecting cancels the request in flight and releases the mic", async () => {
    let release!: () => void;
    const rig = fakeRig({
      exchangeOffer: (_sdp, signal) => new Promise((resolve, reject) => {
        release = () => resolve({ sessionId: "late", sdp: "v=0 late" });
        signal.addEventListener("abort", () => reject(new Error("aborted")));
      }),
    });
    const session = new LiveVoiceSession(rig.deps);
    const starting = session.start();
    await vi.waitFor(() => expect(rig.exchanges).toHaveLength(1));

    session.stop();
    expect(rig.exchanges[0]!.signal.aborted).toBe(true);
    await starting;
    release();
    expect(session.snapshot()).toMatchObject({ state: "idle", error: null });
    expect(released(rig)).toBe(true);
  });

  it("stop while the microphone prompt is open releases the mic it gets afterwards", async () => {
    let grant!: (s: FakeStream) => void;
    const late = new FakeStream();
    const rig = fakeRig({ getUserMedia: () => new Promise((resolve) => { grant = resolve; }) });
    const session = new LiveVoiceSession(rig.deps);
    const starting = session.start();
    session.stop();
    grant(late);
    await starting;
    expect(late.tracks.every((t) => t.stopped)).toBe(true);
    expect(session.snapshot().state).toBe("idle");
  });

  it("stop while live sends session.close and tears down on session.closed", async () => {
    const { session, rig } = await liveSession();
    session.stop();
    expect(session.snapshot().state).toBe("closing");
    expect(rig.peer().channel!.sent).toContainEqual({ type: "session.close" });
    // Media stays up while pending work drains.
    expect(rig.peer().closed).toBe(false);

    rig.peer().channel!.emit({ type: "session.closed", reason: "close_requested", usage: { seconds: 12 } });
    expect(session.snapshot()).toMatchObject({ state: "idle", notice: null });
    expect(released(rig)).toBe(true);
  });

  it("tears down anyway when session.closed never arrives", async () => {
    vi.useFakeTimers();
    const { session, rig } = await liveSession();
    session.stop();
    vi.advanceTimersByTime(CLOSE_TIMEOUT_MS);
    expect(session.snapshot()).toMatchObject({ state: "idle", notice: "voice.notice.closeUnconfirmed" });
    expect(released(rig)).toBe(true);
  });

  it("dispose (page left) closes best-effort and releases at once", async () => {
    const { session, rig } = await liveSession();
    const sent = rig.peer().channel!.sent;
    session.dispose();
    expect(sent).toContainEqual({ type: "session.close" });
    expect(released(rig)).toBe(true);
  });
});

describe("LiveVoiceSession — while live", () => {
  it("groups transcript deltas by speaker", async () => {
    const { session, rig } = await liveSession();
    const ch = rig.peer().channel!;
    ch.emit({ type: "session.input_transcript.delta", delta: "Oi, ", start_ms: 0, end_ms: 10 });
    ch.emit({ type: "session.input_transcript.delta", delta: "tudo bem?", start_ms: 10, end_ms: 20 });
    ch.emit({ type: "session.output_transcript.delta", delta: "Tudo ", start_ms: 30, end_ms: 40 });
    ch.emit({ type: "session.output_transcript.delta", delta: "ótimo.", start_ms: 40, end_ms: 50 });
    // Barge-in: the person talks over the assistant, a new turn starts.
    ch.emit({ type: "session.input_transcript.delta", delta: "Espera", start_ms: 45, end_ms: 55 });
    expect(session.snapshot().transcript).toEqual([
      { role: "user", text: "Oi, tudo bem?" },
      { role: "assistant", text: "Tudo ótimo." },
      { role: "user", text: "Espera" },
    ]);
  });

  it("mute silences the track locally and tells the model", async () => {
    const { session, rig } = await liveSession();
    session.setMuted(true);
    expect(rig.mic().tracks[0]!.enabled).toBe(false);
    expect(rig.peer().channel!.sent).toContainEqual({ type: "session.input_audio.mute" });
    expect(session.snapshot().muted).toBe(true);
    session.setMuted(false);
    expect(rig.mic().tracks[0]!.enabled).toBe(true);
    expect(rig.peer().channel!.sent).toContainEqual({ type: "session.input_audio.unmute" });
  });

  it("an error after start is a notice, not the end of the conversation", async () => {
    const { session, rig } = await liveSession();
    rig.peer().channel!.emit({ type: "error", error: { message: "moderation cut the reply" } });
    expect(session.snapshot()).toMatchObject({ state: "live", notice: "moderation cut the reply" });
  });

  it("a failed connection ends in error and releases everything", async () => {
    const { session, rig } = await liveSession();
    rig.peer().fail();
    expect(session.snapshot()).toMatchObject({ state: "error", error: "voice.err.connectionLost" });
    expect(released(rig)).toBe(true);
  });

  it("the channel closing without session.closed is a disconnect", async () => {
    const { session, rig } = await liveSession();
    rig.peer().channel!.close();
    expect(session.snapshot()).toMatchObject({ state: "error", error: "voice.err.disconnected" });
    expect(released(rig)).toBe(true);
  });

  it("the server ending the session says why", async () => {
    const { session, rig } = await liveSession();
    rig.peer().channel!.emit({ type: "session.closed", reason: "expired" });
    expect(session.snapshot()).toMatchObject({ state: "idle", notice: "voice.notice.expired" });
  });

  it("ignores garbage on the channel", async () => {
    const { session, rig } = await liveSession();
    rig.peer().channel!.dispatchEvent(Object.assign(new Event("message"), { data: "{not json" }));
    expect(session.snapshot().state).toBe("live");
  });
});

describe("LiveVoiceSession — diagnostics", () => {
  it("tracks peer, ICE, channel and mic track states", async () => {
    const { session, rig } = await liveSession();
    rig.peer().connect();
    expect(session.snapshot().diag).toMatchObject({ peer: "connected", ice: "connected", channel: "open", micTrack: "live" });
    expect(session.micStream()).toBe(rig.mic());
  });

  it("counts model events by type, keeping no text", async () => {
    const { session, rig } = await liveSession();
    rig.peer().channel!.emit({ type: "session.input_transcript.delta", delta: "segredo" });
    rig.peer().channel!.emit({ type: "session.input_transcript.delta", delta: "particular" });
    rig.peer().channel!.emit({ type: "error", error: { code: "invalid_audio", message: "x" } });
    const { diag } = session.snapshot();
    expect(diag.events).toMatchObject({ "session.started": 1, "session.input_transcript.delta": 2, error: 1 });
    expect(diag.lastErrorCode).toBe("invalid_audio");
    expect(JSON.stringify(diag)).not.toContain("segredo");
  });

  it("reads sent/received audio bytes and the model's level from getStats", async () => {
    vi.useFakeTimers();
    const rig = fakeRig();
    const session = new LiveVoiceSession(rig.deps);
    await session.start();
    rig.peer().stats = [
      { type: "outbound-rtp", kind: "audio", bytesSent: 4096 },
      { type: "inbound-rtp", kind: "audio", bytesReceived: 2048, audioLevel: 0.2 },
      { type: "outbound-rtp", kind: "video", bytesSent: 999999 },
    ];
    await vi.advanceTimersByTimeAsync(STATS_INTERVAL_MS);
    expect(session.snapshot().diag).toMatchObject({ sentBytes: 4096, receivedBytes: 2048, remoteLevel: 0.2 });
    session.dispose();
  });

  it("the model's track playing, or blocked by autoplay with a way to resume", async () => {
    const { session, rig } = await liveSession();
    rig.peer().remoteTrack();
    await vi.waitFor(() => expect(session.snapshot().diag.playback).toBe("playing"));
    expect(session.snapshot().diag.remoteAudio).toBe(true);

    const blocked = fakeRig();
    blocked.audio.play = () => Promise.reject(new Error("NotAllowedError"));
    const s2 = (await liveSession(blocked)).session;
    blocked.peer().remoteTrack();
    await vi.waitFor(() => expect(s2.snapshot().diag.playback).toBe("blocked"));
    blocked.audio.play = async () => undefined;
    s2.resumePlayback();
    await vi.waitFor(() => expect(s2.snapshot().diag.playback).toBe("playing"));
  });

  it("stops polling on teardown", async () => {
    vi.useFakeTimers();
    const { session, rig } = await liveSession();
    const spy = vi.spyOn(rig.peer(), "getStats");
    session.dispose();
    await vi.advanceTimersByTimeAsync(STATS_INTERVAL_MS * 3);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("aiActivity", () => {
  const base = { ...LiveVoiceSession.idleSnapshot.diag };
  it("waiting, hearing (input transcript), speaking (output transcript or remote level)", () => {
    expect(aiActivity(base, 10_000)).toBe("waiting");
    expect(aiActivity({ ...base, lastInputAt: 9_500 }, 10_000)).toBe("hearing");
    expect(aiActivity({ ...base, lastInputAt: 9_500, lastOutputAt: 9_800 }, 10_000)).toBe("speaking");
    expect(aiActivity({ ...base, remoteLevel: 0.3 }, 10_000)).toBe("speaking");
    expect(aiActivity({ ...base, lastInputAt: 10_000 - ACTIVITY_WINDOW_MS - 1 }, 10_000)).toBe("waiting");
  });
});

describe("errorMessage", () => {
  it("prefers the server's message, then known browser errors", () => {
    expect(errorMessage({ response: { data: { error: "too many voice sessions" } } })).toBe("too many voice sessions");
    expect(errorMessage(Object.assign(new Error("x"), { name: "NotFoundError" }))).toBe("voice.err.noMic");
    expect(errorMessage("weird")).toBe("voice.err.generic");
  });
});
