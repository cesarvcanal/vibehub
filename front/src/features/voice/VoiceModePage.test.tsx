import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderApp } from "@/test/render";
import { VoiceModePage } from "./VoiceModePage";
import { fakeRig, type FakeRig } from "./fakeWebRtc";

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

function status(body: { enabled: boolean; available: boolean }) {
  get.mockImplementation(async (url: string) => {
    if (url === "/voice/live") return { ...body, model: "gpt-live-1" };
    if (url === "/auth/me") return { id: "u", username: "owner", role: "owner" };
    return {};
  });
}

beforeEach(() => {
  rig = fakeRig();
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
});
