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
    expect(screen.queryByRole("complementary", { name: "Painel de calibração" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Mostrar parâmetros" }));
    expect(screen.getByRole("complementary", { name: "Painel de calibração" })).toBeInTheDocument();
    Object.defineProperty(navigator, "clipboard", { value: { writeText: vi.fn().mockRejectedValue(new Error("no")) }, configurable: true });
    await user.click(screen.getByRole("button", { name: "Copiar parametrização" }));
    expect((screen.getByRole("textbox", { name: "Parametrização" }) as HTMLTextAreaElement).value).toContain("listenSpin: 13");
  });

  it("asks for the microphone once, and releases it when switched off and on leaving", async () => {
    const user = userEvent.setup();
    const { unmount } = renderApp(<VoiceLabPage />, { route: "/voice/lab" });
    await user.click(screen.getByRole("button", { name: "Ativar microfone (escuta)" }));
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    await user.click(await screen.findByRole("button", { name: "Desligar microfone" }));
    expect(stop).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("button", { name: "Ativar microfone (escuta)" }));
    expect(getUserMedia).toHaveBeenCalledTimes(2);
    await screen.findByRole("button", { name: "Desligar microfone" });
    unmount();
    expect(stop).toHaveBeenCalledTimes(2);
  });

  it("leaving while the permission prompt is open still releases the microphone", async () => {
    const user = userEvent.setup();
    let grant!: (s: MediaStream) => void;
    getUserMedia.mockReturnValueOnce(new Promise((r) => (grant = r)));
    const { unmount } = renderApp(<VoiceLabPage />, { route: "/voice/lab" });
    await user.click(screen.getByRole("button", { name: "Ativar microfone (escuta)" }));
    unmount();
    grant({ getTracks: () => [{ stop }], getAudioTracks: () => [] } as unknown as MediaStream);
    await vi.waitFor(() => expect(stop).toHaveBeenCalledTimes(1));
  });

  it("switches modes from its buttons", async () => {
    const user = userEvent.setup();
    renderApp(<VoiceLabPage />, { route: "/voice/lab" });
    await user.click(screen.getByRole("button", { name: "Marca viva" }));
    expect(screen.getByTestId("voice-orb")).toHaveAttribute("data-mode", "logo");
    await user.click(screen.getByRole("button", { name: "IA respondendo" }));
    expect(screen.getByTestId("voice-orb")).toHaveAttribute("data-mode", "talk");
  });
});
