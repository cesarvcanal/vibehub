import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderApp } from "@/test/render";
import { VoiceLabPage } from "./VoiceLabPage";

vi.mock("@/lib/api", () => ({
  api: { interceptors: { response: { use: vi.fn() } } },
  setUnauthorizedHandler: vi.fn(),
  get: vi.fn(async (url: string) => (url === "/auth/me" ? { user: { id: "u", username: "dev", role: "owner" } } : {})),
  post: vi.fn(),
  patch: vi.fn(),
  del: vi.fn(),
}));

const stop = vi.fn();
const getUserMedia = vi.fn();
beforeEach(() => {
  stop.mockReset();
  getUserMedia.mockReset().mockResolvedValue({ getTracks: () => [{ stop }], getAudioTracks: () => [] });
  Object.defineProperty(navigator, "mediaDevices", { value: { getUserMedia }, configurable: true });
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
});
afterEach(() => vi.restoreAllMocks());

describe("VoiceLabPage", () => {
  it("keeps the tuning panel hidden until asked, and copies the parameters", async () => {
    const user = userEvent.setup();
    renderApp(<VoiceLabPage />, { route: "/voice/lab" });
    expect(screen.queryByRole("complementary", { name: "Calibration panel" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Show parameters" }));
    expect(screen.getByRole("complementary", { name: "Calibration panel" })).toBeInTheDocument();
    Object.defineProperty(navigator, "clipboard", { value: { writeText: vi.fn().mockRejectedValue(new Error("no")) }, configurable: true });
    await user.click(screen.getByRole("button", { name: "Copy parameters" }));
    expect((screen.getByRole("textbox", { name: "Parameters" }) as HTMLTextAreaElement).value).toContain("listenSpin: 13");
  });

  it("asks for the microphone once, and releases it when switched off and on leaving", async () => {
    const user = userEvent.setup();
    const { unmount } = renderApp(<VoiceLabPage />, { route: "/voice/lab" });
    await user.click(screen.getByRole("button", { name: "Turn microphone on (listening)" }));
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    await user.click(await screen.findByRole("button", { name: "Turn microphone off" }));
    expect(stop).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("button", { name: "Turn microphone on (listening)" }));
    expect(getUserMedia).toHaveBeenCalledTimes(2);
    await screen.findByRole("button", { name: "Turn microphone off" });
    unmount();
    expect(stop).toHaveBeenCalledTimes(2);
  });

  it("leaving while the permission prompt is open still releases the microphone", async () => {
    const user = userEvent.setup();
    let grant!: (s: MediaStream) => void;
    getUserMedia.mockReturnValueOnce(new Promise((r) => (grant = r)));
    const { unmount } = renderApp(<VoiceLabPage />, { route: "/voice/lab" });
    await user.click(screen.getByRole("button", { name: "Turn microphone on (listening)" }));
    unmount();
    grant({ getTracks: () => [{ stop }], getAudioTracks: () => [] } as unknown as MediaStream);
    await vi.waitFor(() => expect(stop).toHaveBeenCalledTimes(1));
  });

  it("switches modes from its buttons", async () => {
    const user = userEvent.setup();
    renderApp(<VoiceLabPage />, { route: "/voice/lab" });
    await user.click(screen.getByRole("button", { name: "Living mark" }));
    expect(screen.getByTestId("voice-orb")).toHaveAttribute("data-mode", "logo");
    await user.click(screen.getByRole("button", { name: "AI replying" }));
    expect(screen.getByTestId("voice-orb")).toHaveAttribute("data-mode", "talk");
  });
});
