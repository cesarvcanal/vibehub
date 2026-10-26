import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderApp } from "@/test/render";
import { VoiceModePage, livingMode, orbLevels, orbMode } from "./VoiceModePage";
import { LiveVoiceSession } from "./liveVoice";
import { aiVoice, micVoice } from "./living/levels";
import { fakeRig, type FakeRig } from "./fakeWebRtc";
import { fakeAudioContext, sine } from "./micLevel.test";

const get = vi.fn();
const post = vi.fn();
vi.mock("@/lib/api", () => ({
  api: { interceptors: { response: { use: vi.fn() } } },
  setUnauthorizedHandler: vi.fn(),
  get: (...a: unknown[]) => get(...a),
  post: (...a: unknown[]) => post(...a),
  patch: vi.fn(),
  del: vi.fn(),
}));

let rig: FakeRig;
const makeDeps = () => rig.deps;

function status(body: { enabled: boolean; available: boolean }, role: "owner" | "member" = "owner") {
  get.mockImplementation(async (url: string) => {
    if (url === "/voice/live") return { ...body, model: "gpt-live-1" };
    if (url === "/auth/me") return { user: { id: "u", username: "someone", role } };
    if (url === "/setup/state") return { fresh: false };
    return {};
  });
}

beforeEach(() => {
  rig = fakeRig();
  // jsdom has no 2D canvas: the orb draws its CSS fallback (and jsdom stays quiet about it).
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  // jsdom has no WebRTC: the page checks for it before offering the button.
  vi.stubGlobal("RTCPeerConnection", class {});
  Object.defineProperty(navigator, "mediaDevices", { value: {}, configurable: true });
});
afterEach(() => {
  vi.unstubAllGlobals();
  get.mockReset();
  post.mockReset();
});

describe("VoiceModePage", () => {
  it("says the mode is off when the server did not enable it", async () => {
    status({ enabled: false, available: false });
    renderApp(<VoiceModePage makeDeps={makeDeps} />);
    expect(await screen.findByText(/VIBEHUB_VOICE_LIVE=1/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Start conversation" })).not.toBeInTheDocument();
  });

  it("says a key is missing when enabled without one", async () => {
    status({ enabled: true, available: false });
    renderApp(<VoiceModePage makeDeps={makeDeps} />);
    expect(await screen.findByText(/VIBEHUB_VOICE_OPENAI_API_KEY/)).toBeInTheDocument();
  });

  it("the owner stores the key from the page, and it is never shown back", async () => {
    status({ enabled: true, available: false });
    post.mockImplementation(async () => {
      status({ enabled: true, available: true });
      return {};
    });
    const user = userEvent.setup();
    renderApp(<VoiceModePage makeDeps={makeDeps} />);
    const field = await screen.findByLabelText("OpenAI API key (owner)");
    expect(field).toHaveAttribute("type", "password");
    await user.type(field, "sk-real-secret");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(post).toHaveBeenCalledWith("/transcribe/keys", { openaiKey: "sk-real-secret" });
    expect(await screen.findByRole("button", { name: "Start conversation" })).toBeInTheDocument();
    expect(document.body.innerHTML).not.toContain("sk-real-secret");
  });

  it("a member gets no key form", async () => {
    status({ enabled: true, available: false }, "member");
    renderApp(<VoiceModePage makeDeps={makeDeps} />);
    expect(await screen.findByText(/VIBEHUB_VOICE_OPENAI_API_KEY/)).toBeInTheDocument();
    expect(screen.queryByLabelText("OpenAI API key (owner)")).not.toBeInTheDocument();
  });

  it("start → live → transcript → stop, one button", async () => {
    status({ enabled: true, available: true });
    const user = userEvent.setup();
    renderApp(<VoiceModePage makeDeps={makeDeps} />);

    await user.click(await screen.findByRole("button", { name: "Start conversation" }));
    expect(await screen.findByText("Connecting…")).toBeInTheDocument();

    act(() => rig.peer().channel!.emit({ type: "session.started", session: { id: "live_1" } }));
    expect(await screen.findByText("Listening — just talk")).toBeInTheDocument();

    act(() => rig.peer().channel!.emit({ type: "session.output_transcript.delta", delta: "Olá!" }));
    expect(await screen.findByText("Olá!")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Mute microphone" }));
    expect(rig.mic().tracks[0]!.enabled).toBe(false);

    await user.click(screen.getByRole("button", { name: "End conversation" }));
    expect(rig.peer().channel!.sent).toContainEqual({ type: "session.close" });
    act(() => rig.peer().channel!.emit({ type: "session.closed", reason: "close_requested" }));
    expect(await screen.findByRole("button", { name: "Start conversation" })).toBeInTheDocument();
    expect(rig.mic().tracks[0]!.stopped).toBe(true);
  });

  it("shows the failure and lets the person try again", async () => {
    status({ enabled: true, available: true });
    rig = fakeRig({ exchangeOffer: async () => { throw { response: { data: { error: "OpenAI rejected the API key" } } }; } });
    const user = userEvent.setup();
    renderApp(<VoiceModePage makeDeps={makeDeps} />);
    await user.click(await screen.findByRole("button", { name: "Start conversation" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("OpenAI rejected the API key");
    expect(screen.getByRole("button", { name: "Start conversation" })).toBeEnabled();
  });

  it("leaving the page releases the microphone", async () => {
    status({ enabled: true, available: true });
    const user = userEvent.setup();
    const { unmount } = renderApp(<VoiceModePage makeDeps={makeDeps} />);
    await user.click(await screen.findByRole("button", { name: "Start conversation" }));
    await waitFor(() => expect(rig.exchanges).toHaveLength(1));
    unmount();
    expect(rig.mic().tracks[0]!.stopped).toBe(true);
    expect(rig.peer().closed).toBe(true);
  });

  it("live: the local mic meter moves with a synthetic tone, and the diagnostics show the connection", async () => {
    status({ enabled: true, available: true });
    const samples: { current: Uint8Array } = { current: new Uint8Array(1024).fill(128) };
    const ctx = fakeAudioContext(samples);
    const user = userEvent.setup();
    renderApp(<VoiceModePage makeDeps={makeDeps} makeAudioContext={ctx.make} />);
    await user.click(await screen.findByRole("button", { name: "Start conversation" }));
    act(() => rig.peer().channel!.emit({ type: "session.started", session: { id: "live_1" } }));
    act(() => rig.peer().connect());

    expect(await screen.findByText("Microphone on — no sound picked up")).toBeInTheDocument();
    samples.current = sine(0.4);
    expect(await screen.findByText("Your microphone is picking up sound")).toBeInTheDocument();
    expect(Number(screen.getByTestId("mic-meter").dataset.level)).toBeGreaterThan(0.3);

    // The meter is local; the AI line only moves on the model's own events.
    expect(screen.getByTestId("ai-status")).toHaveTextContent("AI: waiting for you to speak");
    act(() => rig.peer().channel!.emit({ type: "session.input_transcript.delta", delta: "oi" }));
    expect(screen.getByTestId("ai-status")).toHaveTextContent("AI: heard you");

    const diag = screen.getByTestId("voice-diag");
    expect(diag).toHaveTextContent("connected");
    expect(diag).toHaveTextContent("session.started ×1");

    await user.click(screen.getByRole("button", { name: "Mute microphone" }));
    expect(await screen.findByText("Microphone muted")).toBeInTheDocument();
  });

  it("shows the orb, and leads back to the card in its URL — a reload keeps the way back", async () => {
    status({ enabled: true, available: true });
    renderApp(<VoiceModePage makeDeps={makeDeps} />, { route: "/voice?project=p1&card=c1" });
    // Outside a conversation the orb is the living Multiverso mark.
    expect(await screen.findByTestId("voice-orb")).toHaveAttribute("data-mode", "logo");
    expect(screen.getByRole("link", { name: /back to the card/i })).toHaveAttribute("href", "/?project=p1&card=c1");
  });

  it("opened directly, the way back is the board", async () => {
    status({ enabled: true, available: true });
    renderApp(<VoiceModePage makeDeps={makeDeps} />);
    expect(await screen.findByRole("link", { name: /back to the board/i })).toHaveAttribute("href", "/");
  });
});

describe("orb state and sound", () => {
  const idle = LiveVoiceSession.idleSnapshot;

  it("orbMode follows the session: idle, connecting, listening, muted, speaking, error", () => {
    expect(orbMode(idle, 0)).toBe("idle");
    expect(orbMode({ ...idle, state: "connecting" }, 0)).toBe("connecting");
    expect(orbMode({ ...idle, state: "live" }, 0)).toBe("listening");
    expect(orbMode({ ...idle, state: "live", muted: true }, 0)).toBe("muted");
    expect(orbMode({ ...idle, state: "live", diag: { ...idle.diag, lastOutputAt: 900 } }, 1000)).toBe("speaking");
    expect(orbMode({ ...idle, state: "error" }, 0)).toBe("error");
  });

  it("the mark outside a conversation, lilac while listening (muted too), blue while replying", () => {
    for (const m of ["idle", "connecting", "error"] as const) expect(livingMode(m)).toBe("logo");
    expect(livingMode("listening")).toBe("listen");
    expect(livingMode("muted")).toBe("listen");
    expect(livingMode("speaking")).toBe("talk");
  });

  it("never takes the assistant's level from the microphone", () => {
    // Listening: the mic drives it.
    expect(orbLevels("listening", 0.1, null, null)).toEqual({ listenLevel: micVoice(0.1), talkLevel: null });
    // Muted: silent, whatever the mic reads.
    expect(orbLevels("muted", 0.3, null, null).listenLevel).toBe(0);
    // Replying: the assistant's own track first, then the RTP level, else nothing (soft fallback).
    expect(orbLevels("speaking", 0.9, 0.05, 0.4)).toEqual({ listenLevel: 0, talkLevel: aiVoice(0.05) });
    expect(orbLevels("speaking", 0.9, null, 0.4).talkLevel).toBe(aiVoice(0.4));
    expect(orbLevels("speaking", 0.9, null, null).talkLevel).toBeNull();
  });
});
