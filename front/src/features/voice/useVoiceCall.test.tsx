import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { post } from "@/lib/api";
import { FakeAudioContext, FakeStream, fakeRig, type FakeRig } from "./fakeWebRtc";
import { DEAD_ANALYSER_MS, SAVE_RETRY_MS, useVoiceCall } from "./useVoiceCall";

/**
 * The call's glue, with the browser's media stack and Web Audio replaced by hand-driven fakes: the
 * orb follows the MEASURED level of the assistant's track (with an honest fallback when it cannot
 * be measured), the microphone never drives the reply, turns are saved idempotently with retries,
 * and every exit releases what the call held.
 */

vi.mock("@/lib/api", () => ({
  api: { defaults: { baseURL: "/api" }, interceptors: { response: { use: vi.fn() } } },
  setUnauthorizedHandler: vi.fn(),
  get: vi.fn(),
  post: vi.fn(() => Promise.resolve({ saved: [], duplicate: [] })),
  patch: vi.fn(),
  del: vi.fn(),
}));

const mockPost = vi.mocked(post);
let rig: FakeRig;
let audio: FakeAudioContext;

function setup(cardId = "card-1") {
  rig = fakeRig();
  audio = new FakeAudioContext();
  return renderHook((props: { cardId: string }) =>
    useVoiceCall({ cardId: props.cardId, makeDeps: () => rig.deps, makeAudioContext: () => audio as unknown as AudioContext }),
  { initialProps: { cardId } });
}

async function goLive(result: ReturnType<typeof setup>["result"]) {
  await act(async () => {
    result.current.start();
  });
  act(() => rig.peer().channel!.emit({ type: "session.started", session: { id: "live_1" } }));
}

beforeEach(() => {
  // `performance` too: the meters' envelopes run on it, and must age with the fake clock.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date", "performance"] });
  mockPost.mockReset();
  mockPost.mockImplementation(() => Promise.resolve({ saved: [], duplicate: [] }));
});
afterEach(() => {
  vi.useRealTimers();
});

describe("useVoiceCall — what drives the orb", () => {
  it("the BLUE sphere follows the assistant's real audio, measured on its WebRTC track", async () => {
    const { result } = setup();
    await goLive(result);
    act(() => rig.peer().remoteTrack());
    audio.play(rig.peer().remoteStream, 0.1);
    act(() => rig.peer().channel!.emit({ type: "session.output_transcript.delta", delta: "Claro" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(result.current.phase).toBe("ai_speaking");
    const levels = result.current.orbLevels();
    expect(result.current.meterRef.current.aiSource).toBe("analyser");
    expect(result.current.meterRef.current.aiRms).toBeGreaterThan(0.05);
    expect(levels.talk).toBeGreaterThan(0.5);
    expect(levels.listen).toBe(0);

    // The voice falls silent: the sphere settles, with no clock keeping it moving.
    audio.play(rig.peer().remoteStream, 0);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_500);
    });
    for (let i = 0; i < 30; i++) result.current.orbLevels();
    expect(result.current.orbLevels().talk).toBeLessThan(0.05);
  });

  it("never takes the reply's intensity from the microphone (no mic bleed)", async () => {
    const { result } = setup();
    await goLive(result);
    act(() => rig.peer().remoteTrack());
    // The person's mic is loud; the assistant's track is near silence.
    audio.play(rig.mic(), 0.3);
    audio.play(rig.peer().remoteStream, 0.002);
    act(() => rig.peer().channel!.emit({ type: "session.output_transcript.delta", delta: "a" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(result.current.meterRef.current.micVisual).toBeGreaterThan(0.5);
    const { talk } = result.current.orbLevels();
    expect(talk).toBeLessThan(0.35);
  });

  it("the pink sphere follows the microphone while listening, and muting stops it", async () => {
    const { result } = setup();
    await goLive(result);
    audio.play(rig.mic(), 0.2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(result.current.phase).toBe("user_speaking");
    expect(result.current.orbLevels().listen).toBeGreaterThan(0.5);
    act(() => result.current.setMuted(true));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    // Muted right after speaking: the sentence is owed an answer (thinking), and the mic moves nothing.
    expect(result.current.phase).not.toBe("user_speaking");
    expect(result.current.orbLevels().listen).toBe(0);
    expect(result.current.meterRef.current.micVisual).toBe(0);
  });

  it("a track Web Audio cannot hear (exact zeros) falls back to the RTP level — and says so", async () => {
    const { result } = setup();
    await goLive(result);
    act(() => rig.peer().remoteTrack());
    audio.play(rig.peer().remoteStream, "dead");
    rig.peer().stats = [{ type: "inbound-rtp", kind: "audio", bytesReceived: 900, audioLevel: 0.12 }];
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DEAD_ANALYSER_MS + 400);
    });
    // The phase loop needs a couple of ticks on the fallback to call it speech.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    result.current.orbLevels();
    expect(result.current.meterRef.current.aiSource).toBe("rtp");
    expect(result.current.meterRef.current.aiVisual).toBeGreaterThan(0.5);
    expect(result.current.phase).toBe("ai_speaking");
  });

  it("with no audio measurable at all, the model's own speech events keep the sphere alive", async () => {
    const { result } = setup();
    await goLive(result);
    act(() => rig.peer().channel!.emit({ type: "session.output_transcript.delta", delta: "Vou explicar" }));
    result.current.orbLevels();
    expect(result.current.meterRef.current.aiSource).toBe("events");
    expect(result.current.meterRef.current.aiVisual).toBeGreaterThan(0.3);
  });
});

describe("useVoiceCall — turns into the chat", () => {
  it("saves each closed turn once, with retries, and reports the state per turn", async () => {
    mockPost.mockRejectedValueOnce(new Error("network"));
    const { result } = setup();
    await goLive(result);
    act(() => rig.peer().channel!.emit({ type: "session.input_transcript.delta", delta: "oi", start_ms: 0, end_ms: 100 }));
    act(() => rig.peer().channel!.emit({ type: "session.input_transcript.delta", delta: "de novo", start_ms: 5_000, end_ms: 5_200 }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(result.current.turns[0]).toMatchObject({ text: "oi", final: true, save: "failed" });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SAVE_RETRY_MS[0]! + 50);
    });
    expect(mockPost).toHaveBeenCalledTimes(2);
    const [url, body] = mockPost.mock.calls[1]!;
    expect(url).toBe("/cards/card-1/voice/turns");
    expect((body as { turns: { vid: string; text: string }[] }).turns.map((t) => t.text)).toEqual(["oi"]);
    expect(result.current.turns[0]!.save).toBe("saved");
  });

  it("hanging up saves what was still being said", async () => {
    const { result } = setup();
    await goLive(result);
    act(() => rig.peer().channel!.emit({ type: "session.output_transcript.delta", delta: "até mais" }));
    act(() => result.current.stop());
    act(() => rig.peer().channel!.emit({ type: "session.closed", reason: "close_requested" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    const sent = mockPost.mock.calls.flatMap(([, body]) => (body as { turns: { role: string; text: string }[] }).turns);
    expect(sent).toEqual([expect.objectContaining({ role: "assistant", text: "até mais" })]);
  });

  it("a turn the server refuses for good is not retried forever", async () => {
    mockPost.mockRejectedValue({ response: { status: 403 } });
    const { result } = setup();
    await goLive(result);
    act(() => rig.peer().channel!.emit({ type: "session.input_transcript.delta", delta: "x" }));
    act(() => result.current.stop());
    act(() => rig.peer().channel!.emit({ type: "session.closed" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(mockPost).toHaveBeenCalledTimes(1);
    expect(result.current.turns[0]!.save).toBe("failed");
  });
});

describe("useVoiceCall — lifecycle", () => {
  it("the AudioContext is born in the click, and every exit gives the audio back", async () => {
    const { result } = setup();
    await goLive(result);
    expect(audio.resumed).toBeGreaterThan(0);
    act(() => rig.peer().fail());
    expect(result.current.snap.state).toBe("error");
    expect(audio.closed).toBe(true);
    expect(rig.mic().tracks.every((t) => t.stopped)).toBe(true);
  });

  it("asks for the microphone once per call", async () => {
    const getUserMedia = vi.fn(async () => new FakeStream());
    const { result } = setup();
    rig.deps.getUserMedia = getUserMedia as never;
    await act(async () => {
      result.current.start();
      result.current.start();
    });
    expect(getUserMedia).toHaveBeenCalledTimes(1);
  });

  it("leaving the chat (another card) ends the call and releases the mic", async () => {
    const { result, rerender } = setup("card-1");
    await goLive(result);
    const first = rig;
    rerender({ cardId: "card-2" });
    expect(first.peer().channel!.sent).toContainEqual({ type: "session.close" });
    expect(first.mic().tracks.every((t) => t.stopped)).toBe(true);
    expect(result.current.snap.state).toBe("idle");
  });

  it("one call at a time: starting another chat's call ends this one", async () => {
    const a = setup("card-a");
    await goLive(a.result);
    const rigA = rig;
    const b = setup("card-b");
    await act(async () => {
      b.result.current.start();
    });
    expect(rigA.peer().channel!.sent).toContainEqual({ type: "session.close" });
  });
});
