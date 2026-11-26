import { afterEach, describe, expect, it, vi } from "vitest";
import { CLOSE_TIMEOUT_MS, CONTEXT_MAX_CHARS, LiveVoiceSession, RECONNECT_DELAYS_MS, START_TIMEOUT_MS, STATS_INTERVAL_MS, errorMessage } from "./liveVoice";
import { fakeRig, FakeStream } from "./fakeWebRtc";
import type { VoiceDropReport } from "../../api/types";

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

  it("the browser's permission prompt does not count against the startup timeout", async () => {
    vi.useFakeTimers();
    let grant!: () => void;
    const rig = fakeRig({ getUserMedia: () => new Promise((resolve) => { grant = () => resolve(new FakeStream()); }) });
    const session = new LiveVoiceSession(rig.deps);
    const starting = session.start();
    await vi.advanceTimersByTimeAsync(START_TIMEOUT_MS + 5_000);
    expect(session.snapshot().state).toBe("connecting");
    grant();
    await starting;
    rig.peer().channel!.emit({ type: "session.started", session: { id: "live_1" } });
    expect(session.snapshot().state).toBe("live");
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
    const turns = session.snapshot().turns;
    expect(turns.map(({ role, text, final }) => ({ role, text, final }))).toEqual([
      // The reply closed the question; the person talking over the reply closed the reply.
      { role: "user", text: "Oi, tudo bem?", final: true },
      { role: "assistant", text: "Tudo ótimo.", final: true },
      { role: "user", text: "Espera", final: false },
    ]);
    // Stable, distinct ids the server saves idempotently.
    expect(new Set(turns.map((t) => t.vid)).size).toBe(3);
    for (const t of turns) expect(t.vid).toMatch(/^[A-Za-z0-9_-]{6,80}$/);
  });

  it("hands every closed turn to the listeners — by pause, and all open ones when the call ends", async () => {
    const { session, rig } = await liveSession();
    const closed: string[] = [];
    session.onFinalTurn((turn) => closed.push(`${turn.role}:${turn.text}`));
    const ch = rig.peer().channel!;
    ch.emit({ type: "session.input_transcript.delta", delta: "primeira", start_ms: 0, end_ms: 300 });
    // A long pause on the model's timeline: the next words are a new turn.
    ch.emit({ type: "session.input_transcript.delta", delta: "segunda", start_ms: 5_000, end_ms: 5_300 });
    expect(closed).toEqual(["user:primeira"]);
    ch.emit({ type: "session.output_transcript.delta", delta: "resposta", start_ms: 5_500, end_ms: 5_900 });
    expect(closed).toEqual(["user:primeira", "user:segunda"]);
    session.stop();
    rig.peer().channel!.emit({ type: "session.closed", reason: "close_requested" });
    expect(closed).toEqual(["user:primeira", "user:segunda", "assistant:resposta"]);
    expect(session.snapshot().turns.every((t) => t.final)).toBe(true);
  });

  it("closes a turn left idle even without a pause on the timeline (the stats tick)", async () => {
    vi.useFakeTimers();
    const { session, rig } = await liveSession();
    const closed: string[] = [];
    session.onFinalTurn((turn) => closed.push(turn.text));
    rig.peer().channel!.emit({ type: "session.output_transcript.delta", delta: "ok" });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(closed).toEqual(["ok"]);
  });

  it("a connection lost mid-sentence still saves what was said", async () => {
    const { session, rig } = await liveSession();
    const closed: string[] = [];
    session.onFinalTurn((turn) => closed.push(turn.text));
    rig.peer().channel!.emit({ type: "session.input_transcript.delta", delta: "estava falando" });
    rig.peer().fail();
    expect(closed).toEqual(["estava falando"]);
  });

  it("tells the model quiet context with session.thinking.append — clipped, never while not live", async () => {
    const { session, rig } = await liveSession();
    const ch = rig.peer().channel!;
    expect(session.appendContext("  A pessoa   escreveu: oi ")).toBe(true);
    expect(ch.sent).toContainEqual({ type: "session.thinking.append", delegation_id: null, content: "A pessoa escreveu: oi" });
    session.appendContext("x".repeat(5_000));
    const long = ch.sent[ch.sent.length - 1] as { content: string };
    expect(long.content.length).toBe(CONTEXT_MAX_CHARS);
    expect(session.appendContext("   ")).toBe(false);
    ch.emit({ type: "session.thinking.appended", client_event_id: "e1" });
    expect(session.snapshot().diag).toMatchObject({ contextSent: 2, contextAcked: 1 });
    session.dispose();
    expect(session.appendContext("depois")).toBe(false);
  });

  it("announces what the model must say aloud with session.commentary.append, tied to no delegation", async () => {
    const { session, rig } = await liveSession();
    const ch = rig.peer().channel!;
    expect(session.announceContext("  Chegou uma   mensagem ")).toBe(true);
    expect(ch.sent).toContainEqual({ type: "session.commentary.append", delegation_id: null, content: "Chegou uma mensagem" });
    session.dispose();
    expect(session.announceContext("depois")).toBe(false);
  });

  it("a delegation nobody can take is answered at once — GPT-Live would otherwise wait for it forever", async () => {
    const { session, rig } = await liveSession();
    const ch = rig.peer().channel!;
    ch.emit({ type: "session.delegation.created", delegation: { id: "item_2", type: "delegation", target: "client" } });
    expect(ch.sent).toContainEqual(expect.objectContaining({ type: "session.commentary.append", delegation_id: "item_2" }));
    // A malformed one (no id) has nothing to answer to: ignored, not thrown.
    ch.emit({ type: "session.delegation.created", delegation: {} });
    expect(session.snapshot().state).toBe("live");
  });

  it("each spoken fragment pulses the fallback envelope (the orb's last resort)", async () => {
    const { session, rig } = await liveSession();
    expect(session.speech.read(0)).toBe(0);
    rig.peer().channel!.emit({ type: "session.output_transcript.delta", delta: "uma frase" });
    expect(session.speech.read(16)).toBeGreaterThan(0.3);
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

describe("LiveVoiceSession — dropped connection", () => {
  it("a connection lost mid-call reconnects on its own with a new session", async () => {
    vi.useFakeTimers();
    const { session, rig } = await liveSession();
    const droppedPeer = rig.peer();
    const droppedMic = rig.mic();
    droppedPeer.fail();
    expect(session.snapshot()).toMatchObject({ state: "connecting", error: null, notice: "voice.notice.reconnecting" });
    expect(droppedPeer.closed).toBe(true);
    expect(droppedMic.tracks.every((track) => track.stopped)).toBe(true);

    await vi.advanceTimersByTimeAsync(RECONNECT_DELAYS_MS[0]!);
    expect(rig.exchanges).toHaveLength(2);
    expect(rig.peer()).not.toBe(droppedPeer);
    rig.peer().channel!.emit({ type: "session.started", session: { id: "live_2" } });
    expect(session.snapshot()).toMatchObject({ state: "live", error: null, notice: null });
  });

  it("the channel closing without session.closed reconnects too", async () => {
    vi.useFakeTimers();
    const { session, rig } = await liveSession();
    rig.peer().channel!.close();
    expect(session.snapshot()).toMatchObject({ state: "connecting", notice: "voice.notice.reconnecting" });
    await vi.advanceTimersByTimeAsync(RECONNECT_DELAYS_MS[0]!);
    expect(rig.exchanges).toHaveLength(2);
  });

  it("gives up after every reconnect attempt failed, showing the last failure", async () => {
    vi.useFakeTimers();
    const answers = [{ sessionId: "live_1", sdp: "v=0 answer" }];
    const rig = fakeRig({
      exchangeOffer: async () => {
        const answer = answers.shift();
        if (!answer) throw { response: { data: { error: "could not reach OpenAI" } } };
        return answer;
      },
    });
    const { session } = await liveSession(rig);
    rig.peer().fail();
    for (const delay of RECONNECT_DELAYS_MS.slice(0, -1)) {
      await vi.advanceTimersByTimeAsync(delay);
      expect(session.snapshot()).toMatchObject({ state: "connecting", notice: "voice.notice.reconnecting" });
    }
    await vi.advanceTimersByTimeAsync(RECONNECT_DELAYS_MS[RECONNECT_DELAYS_MS.length - 1]!);
    expect(rig.exchanges).toHaveLength(1 + RECONNECT_DELAYS_MS.length);
    expect(session.snapshot()).toMatchObject({ state: "error", error: "could not reach OpenAI", notice: null });
    expect(released(rig)).toBe(true);
  });

  it("a reconnect that never confirms the session counts as a failed attempt", async () => {
    vi.useFakeTimers();
    const { session, rig } = await liveSession();
    rig.peer().fail();
    await vi.advanceTimersByTimeAsync(RECONNECT_DELAYS_MS[0]! + START_TIMEOUT_MS);
    expect(session.snapshot()).toMatchObject({ state: "connecting", notice: "voice.notice.reconnecting" });
    await vi.advanceTimersByTimeAsync(RECONNECT_DELAYS_MS[1]!);
    expect(rig.exchanges).toHaveLength(3);
  });

  it("a call that came back gets every reconnect attempt again on the next drop", async () => {
    vi.useFakeTimers();
    const { session, rig } = await liveSession();
    for (const round of [2, 3, 4]) {
      rig.peer().fail();
      await vi.advanceTimersByTimeAsync(RECONNECT_DELAYS_MS[0]!);
      expect(rig.exchanges).toHaveLength(round);
      rig.peer().channel!.emit({ type: "session.started", session: { id: `live_${round}` } });
      expect(session.snapshot().state).toBe("live");
    }
  });

  it("a muted call stays muted across the reconnect: the new mic track is off and the model is told", async () => {
    vi.useFakeTimers();
    const { session, rig } = await liveSession();
    session.setMuted(true);
    rig.peer().fail();
    await vi.advanceTimersByTimeAsync(RECONNECT_DELAYS_MS[0]!);
    expect(rig.mic().tracks.every((track) => !track.enabled)).toBe(true);
    rig.peer().channel!.emit({ type: "session.started", session: { id: "live_2" } });
    expect(session.snapshot().muted).toBe(true);
    expect(rig.peer().channel!.sent).toContainEqual({ type: "session.input_audio.mute" });
  });

  it("the turns said before the drop stay in the call while it reconnects and after it is back", async () => {
    vi.useFakeTimers();
    const { session, rig } = await liveSession();
    rig.peer().channel!.emit({ type: "session.input_transcript.delta", delta: "antes da queda" });
    rig.peer().fail();
    await vi.advanceTimersByTimeAsync(RECONNECT_DELAYS_MS[0]!);
    expect(session.snapshot().turns.map((turn) => turn.text)).toEqual(["antes da queda"]);
    rig.peer().channel!.emit({ type: "session.started", session: { id: "live_2" } });
    rig.peer().channel!.emit({ type: "session.input_transcript.delta", delta: "depois da volta" });
    expect(session.snapshot().turns.map((turn) => turn.text)).toEqual(["antes da queda", "depois da volta"]);
  });

  it("a new call starts with no turns from the previous one", async () => {
    const { session, rig } = await liveSession();
    rig.peer().channel!.emit({ type: "session.input_transcript.delta", delta: "chamada anterior" });
    rig.peer().channel!.emit({ type: "session.closed", reason: "close_requested" });
    await session.start();
    expect(session.snapshot().turns).toEqual([]);
  });

  it("ending the call while it waits to reconnect opens no new session", async () => {
    vi.useFakeTimers();
    const { session, rig } = await liveSession();
    rig.peer().fail();
    session.stop();
    await vi.advanceTimersByTimeAsync(RECONNECT_DELAYS_MS[0]!);
    expect(rig.exchanges).toHaveLength(1);
    expect(session.snapshot()).toMatchObject({ state: "idle", notice: null });
  });

  it("the connection failing before session.started is a startup error, not a reconnect", async () => {
    const rig = fakeRig();
    const session = new LiveVoiceSession(rig.deps);
    await session.start();
    rig.peer().fail();
    expect(session.snapshot()).toMatchObject({ state: "error", error: "voice.err.connectionLost" });
  });

  it("each drop is reported with what the connection looked like when it went", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const { session, rig } = await liveSession();
    const reports: VoiceDropReport[] = [];
    session.onDrop((report) => reports.push(report));
    const peer = rig.peer();
    peer.stats = [
      { type: "outbound-rtp", kind: "audio", bytesSent: 5_000 },
      { type: "inbound-rtp", kind: "audio", bytesReceived: 9_000, audioLevel: 0 },
    ];
    peer.channel!.emit({ type: "session.input_transcript.delta", delta: "oi" });
    await vi.advanceTimersByTimeAsync(60_000);
    peer.iceConnectionState = "disconnected";
    peer.dispatchEvent(new Event("iceconnectionstatechange"));
    await vi.advanceTimersByTimeAsync(30_000);
    peer.fail();

    expect(reports).toEqual([{
      cause: "peer_failed",
      sessionId: "live_1",
      liveForMs: 90_000,
      peer: "failed",
      ice: "disconnected",
      channel: "open",
      iceDisconnectedForMs: 30_000,
      sentBytes: 5_000,
      receivedBytes: 9_000,
      lastInputAgoMs: 90_000,
      lastOutputAgoMs: null,
    }]);
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

describe("errorMessage", () => {
  it("prefers the server's message, then known browser errors", () => {
    expect(errorMessage({ response: { data: { error: "too many voice sessions" } } })).toBe("too many voice sessions");
    expect(errorMessage(Object.assign(new Error("x"), { name: "NotFoundError" }))).toBe("voice.err.noMic");
    expect(errorMessage("weird")).toBe("voice.err.generic");
  });
});

function functionCallEvent(callId: string, name: string, args: string) {
  return {
    type: "response.event",
    delegation_id: "item_9",
    event: { type: "response.output_item.done", item: { id: "fc_1", type: "function_call", status: "completed", call_id: callId, name, arguments: args } },
  };
}

describe("LiveVoiceSession — chamadas de ferramenta do backend", () => {
  it("entrega a chamada de função ao ouvinte com callId, nome, argumentos e o que já foi dito", async () => {
    const { session, rig } = await liveSession();
    const ch = rig.peer().channel!;
    const calls: unknown[] = [];
    session.onToolCall((call) => calls.push({ ...call, turns: call.turns.map((turn) => turn.text) }));
    ch.emit({ type: "session.input_transcript.delta", delta: "cria o card X" });
    ch.emit({ type: "response.event", delegation_id: "item_9", event: { type: "response.output_item.done", item: { type: "reasoning", id: "rs_1" } } });
    ch.emit(functionCallEvent("call_1", "create_card", '{"projectId":"p1","title":"X"}'));
    expect(calls).toEqual([{ callId: "call_1", name: "create_card", argumentsJson: '{"projectId":"p1","title":"X"}', turns: ["cria o card X"] }]);
  });

  it("responde com function_call_output seguido de response.create", async () => {
    const { session, rig } = await liveSession();
    const ch = rig.peer().channel!;
    expect(session.answerToolCall("call_1", { cardId: "c1" })).toBe(true);
    expect(ch.sent.slice(-2)).toEqual([
      { type: "response.item.create", item: { type: "function_call_output", call_id: "call_1", output: '{"cardId":"c1"}' } },
      { type: "response.create" },
    ]);
  });

  it("sem ouvinte, responde na hora com erro", async () => {
    const { rig } = await liveSession();
    const ch = rig.peer().channel!;
    ch.emit(functionCallEvent("call_2", "create_card", "{}"));
    const output = ch.sent.find((event) => (event as { type: string }).type === "response.item.create") as { item: { call_id: string; output: string } };
    expect(output.item.call_id).toBe("call_2");
    expect(JSON.parse(output.item.output)).toHaveProperty("error");
    expect(ch.sent[ch.sent.length - 1]).toEqual({ type: "response.create" });
  });

  it("delegação responses não recebe resposta de delegação client", async () => {
    const { session, rig } = await liveSession();
    const ch = rig.peer().channel!;
    const sentBefore = ch.sent.length;
    ch.emit({ type: "session.delegation.created", delegation: { id: "item_9", type: "delegation", target: "responses", response_id: "resp_1" } });
    expect(ch.sent.length).toBe(sentBefore);
    expect(session.snapshot().state).toBe("live");
  });

  it("depois do fim da chamada, responder não envia nada e devolve false", async () => {
    const { session, rig } = await liveSession();
    const ch = rig.peer().channel!;
    session.dispose();
    const sentBefore = ch.sent.length;
    expect(session.answerToolCall("call_3", { ok: true })).toBe(false);
    expect(ch.sent.length).toBe(sentBefore);
  });
});
