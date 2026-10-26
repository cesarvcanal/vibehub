import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { act } from "react";
import { SdkChatView } from "@/features/board/components/SdkChatView";
import { resetDraftsForTesting } from "@/features/board/components/TerminalComposer";
import type { SdkEvent } from "@/features/board/lib/sdkChat";
import { renderApp } from "@/test/render";
import { get, post } from "@/lib/api";
import { resetLanguage, setLanguage } from "@/i18n";
import { FakeAudioContext, fakeRig, type FakeRig } from "@/features/voice/fakeWebRtc";
import { setVoiceCallTestHooks } from "@/features/voice/useVoiceCall";

/**
 * VOICE IN THE CARD'S CHAT, end to end at the component level: the call starts from the composer
 * of THIS chat, the spoken turns appear in THIS thread (live, then saved, then echoed once), typing
 * during the call goes through the chat's own flow and the voice is told about it, and leaving the
 * chat, a failure or a reconnect never lose or double anything. WebRTC, Web Audio and the socket are
 * hand-driven fakes; no network.
 */

vi.mock("@/lib/api", () => ({
  api: { defaults: { baseURL: "/api" }, interceptors: { response: { use: vi.fn() } } },
  setUnauthorizedHandler: vi.fn(),
  get: vi.fn(),
  post: vi.fn(() => Promise.resolve({ saved: [], duplicate: [] })),
  patch: vi.fn(),
  del: vi.fn(),
}));
vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), message: vi.fn(), loading: vi.fn(() => "t"), dismiss: vi.fn() }),
}));

class FakeSocket {
  static instances: FakeSocket[] = [];
  static OPEN = 1;
  readyState = 0;
  rawSent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(public url: string) {
    FakeSocket.instances.push(this);
  }
  get frames(): { type: string; text?: string }[] {
    return this.rawSent.map((raw) => JSON.parse(raw)).filter((f) => f.type !== "typing");
  }
  send(data: string): void {
    this.rawSent.push(data);
  }
  close(): void {
    this.readyState = 3;
  }
  accept(): void {
    this.readyState = 1;
    act(() => this.onopen?.());
  }
  drop(): void {
    this.readyState = 3;
    act(() => this.onclose?.());
  }
  deliver(event: SdkEvent | Record<string, unknown>): void {
    act(() => this.onmessage?.({ data: JSON.stringify(event) } as MessageEvent));
    act(() => frames.splice(0).forEach((cb) => cb(performance.now())));
  }
}

let frames: FrameRequestCallback[] = [];
let rig: FakeRig;
let audio: FakeAudioContext;
const OWNER = { id: "1", username: "operator", role: "owner" };

beforeEach(() => {
  resetDraftsForTesting();
  localStorage.clear();
  setLanguage("en");
  FakeSocket.instances = [];
  frames = [];
  vi.stubGlobal("WebSocket", FakeSocket);
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => frames.push(cb));
  vi.stubGlobal("cancelAnimationFrame", () => undefined);
  // jsdom has no 2D canvas: the orb renders its stage and skips drawing (see LivingOrb).
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  vi.mocked(get).mockImplementation(((url: string) => {
    if (url === "/auth/me") return Promise.resolve({ user: OWNER });
    if (url === "/voice/live") return Promise.resolve({ enabled: true, available: true, model: "gpt-live-1" });
    return Promise.resolve({ available: false, proofread: false, language: null });
  }) as never);
  vi.mocked(post).mockReset();
  vi.mocked(post).mockImplementation(() => Promise.resolve({ saved: [], duplicate: [] }) as never);
  rig = fakeRig();
  audio = new FakeAudioContext();
  setVoiceCallTestHooks({ makeDeps: () => rig.deps, makeAudioContext: () => audio as unknown as AudioContext });
});

afterEach(() => {
  setVoiceCallTestHooks({});
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
  resetLanguage();
});

async function openChat(props: Partial<React.ComponentProps<typeof SdkChatView>> = {}) {
  const view = renderApp(<SdkChatView cardId="c1" {...props} />);
  await waitFor(() => expect(FakeSocket.instances.length).toBeGreaterThan(0));
  const ws = FakeSocket.instances[0]!;
  ws.accept();
  ws.deliver({ type: "ready" });
  return { ws, ...view };
}

async function startCall() {
  await userEvent.click(await screen.findByRole("button", { name: /talk by voice/i }));
  await waitFor(() => expect(rig.exchanges.length).toBe(1));
  act(() => rig.peer().channel!.emit({ type: "session.started", session: { id: "live_1" } }));
}

const channel = () => rig.peer().channel!;
const thinkingSent = () =>
  channel().sent.filter((e) => e.type === "session.thinking.append").map((e) => e.content as string);

describe("a voice call inside the card's chat", () => {
  it("starts from the composer, in place: no page change, the thread and the field stay", async () => {
    await openChat();
    await startCall();
    const bar = await screen.findByTestId("voice-call-bar");
    expect(bar).toHaveAttribute("data-phase", "listening");
    expect(within(bar).getByRole("status")).toHaveTextContent("Listening");
    expect(screen.getByTestId("sdk-chat-scroller")).toBeInTheDocument();
    expect(screen.getByRole("textbox")).toBeEnabled();
    // The bar sits OUTSIDE the scrolling thread: it never covers a message.
    expect(screen.getByTestId("sdk-chat-scroller")).not.toContainElement(bar);
    // Attachments and typing are explicitly bridged through the chat.
    expect(bar).toHaveTextContent(/does not see attachments/);
  });

  it("the spoken turns appear in THIS thread as they are said, are saved, and the echo never doubles them", async () => {
    const { ws } = await openChat();
    ws.deliver({ type: "user", text: "mensagem digitada antes", at: 1 });
    await startCall();

    act(() => channel().emit({ type: "session.input_transcript.delta", delta: "qual o status", start_ms: 0, end_ms: 300 }));
    const live = await screen.findByTestId("sdk-voice");
    expect(live).toHaveAttribute("data-role", "user");
    expect(live).toHaveAttribute("data-live", "true");
    // In the same log, AFTER the typed message.
    const log = screen.getByRole("log");
    const typed = within(log).getByText("mensagem digitada antes");
    expect(typed.compareDocumentPosition(live) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    act(() => channel().emit({ type: "session.output_transcript.delta", delta: "Tudo verde.", start_ms: 400, end_ms: 900 }));
    // The assistant's reply closes the person's turn: saved at once.
    await waitFor(() => expect(post).toHaveBeenCalledWith("/cards/c1/voice/turns", expect.anything()));
    const saved = (vi.mocked(post).mock.calls[0]![1] as { turns: { vid: string; role: string; text: string }[] }).turns;
    expect(saved).toEqual([expect.objectContaining({ role: "user", text: "qual o status" })]);

    // The server's echo of the same turn (same vid) replaces the local copy — one bubble, not two.
    ws.deliver({ type: "voice_turn", vid: saved[0]!.vid, role: "user", text: "qual o status", at: 2, from: { kind: "owner", name: "operator" } });
    expect(screen.getAllByTestId("sdk-voice").filter((el) => el.textContent?.includes("qual o status"))).toHaveLength(1);

    // Hang up: the strip goes, the conversation stays.
    await userEvent.click(screen.getByTestId("voice-call-end"));
    act(() => channel().emit({ type: "session.closed", reason: "close_requested" }));
    await waitFor(() => expect(screen.queryByTestId("voice-call-bar")).not.toBeInTheDocument());
    expect(within(log).getByText("qual o status")).toBeInTheDocument();
    expect(within(log).getByText("Tudo verde.")).toBeInTheDocument();
    expect(within(log).getByText("mensagem digitada antes")).toBeInTheDocument();
  });

  it("typing during the call goes through the chat's own flow, and the voice is told — quietly", async () => {
    const { ws } = await openChat();
    await startCall();
    await userEvent.type(screen.getByRole("textbox"), "roda os testes{Enter}");
    await waitFor(() => expect(ws.frames.some((f) => f.type === "user" && f.text === "roda os testes")).toBe(true));
    expect(screen.getByTestId("sdk-user")).toHaveTextContent("roda os testes");
    await waitFor(() => expect(thinkingSent()).toEqual([expect.stringContaining("«roda os testes»")]));
    // Waiting on the agent: the call shows it is processing (the living mark), not a frozen sphere.
    await waitFor(() => expect(screen.getByTestId("voice-call-bar")).toHaveAttribute("data-phase", "thinking"));
    expect(screen.getByTestId("voice-call-orb")).toHaveAttribute("data-orb", "logo");
  });

  it("the agent's answers during the call reach the voice as context — only the new ones", async () => {
    const { ws } = await openChat();
    ws.deliver({ type: "assistant_text", text: "resposta antiga" });
    ws.deliver({ type: "result", isError: false });
    await startCall();
    ws.deliver({ type: "assistant_text", text: "Os 12 testes passaram." });
    ws.deliver({ type: "result", isError: false });
    await waitFor(() => expect(thinkingSent()).toEqual([expect.stringContaining("Os 12 testes passaram.")]));
    expect(thinkingSent().join(" ")).not.toContain("resposta antiga");
  });

  it("leaving the chat (another card, the terminal tab) ends the call and releases the mic", async () => {
    const { rerender } = await openChat();
    await startCall();
    rerender(<SdkChatView cardId="c1" active={false} />);
    await waitFor(() => expect(channel().sent).toContainEqual({ type: "session.close" }));
    act(() => channel().emit({ type: "session.closed", reason: "close_requested" }));
    expect(rig.mic().tracks.every((t) => t.stopped)).toBe(true);
  });

  it("a refused call says why in the strip and can be retried in place", async () => {
    let refuse = true;
    rig = fakeRig({
      exchangeOffer: () =>
        refuse
          ? Promise.reject({ response: { data: { error: "OpenAI rate limit or quota reached" } } })
          : Promise.resolve({ sessionId: "live_2", sdp: "v=0 answer" }),
    });
    await openChat();
    await userEvent.click(await screen.findByRole("button", { name: /talk by voice/i }));
    const bar = await screen.findByTestId("voice-call-bar");
    await waitFor(() => expect(bar).toHaveAttribute("data-phase", "error"));
    expect(within(bar).getByRole("alert")).toHaveTextContent("OpenAI rate limit or quota reached");
    expect(rig.mic().tracks.every((t) => t.stopped)).toBe(true);

    refuse = false;
    await userEvent.click(within(bar).getByTestId("voice-call-retry"));
    await waitFor(() => expect(rig.exchanges.length).toBe(2));
    act(() => rig.peer().channel!.emit({ type: "session.started", session: { id: "live_2" } }));
    await waitFor(() => expect(screen.getByTestId("voice-call-bar")).toHaveAttribute("data-phase", "listening"));
  });

  it("a reconnect mid-call replays the thread without losing or doubling a spoken turn", async () => {
    const { ws } = await openChat();
    await startCall();
    act(() => channel().emit({ type: "session.input_transcript.delta", delta: "primeira frase", start_ms: 0, end_ms: 200 }));
    act(() => channel().emit({ type: "session.output_transcript.delta", delta: "ok", start_ms: 300, end_ms: 400 }));
    await waitFor(() => expect(post).toHaveBeenCalled());
    const vid = (vi.mocked(post).mock.calls[0]![1] as { turns: { vid: string }[] }).turns[0]!.vid;

    ws.drop();
    await waitFor(() => expect(FakeSocket.instances.length).toBe(2), { timeout: 5_000 });
    const again = FakeSocket.instances[1]!;
    again.accept();
    again.deliver({ type: "voice_turn", vid, role: "user", text: "primeira frase", at: 1 });
    again.deliver({ type: "ready" });
    const turns = screen.getAllByTestId("sdk-voice").map((el) => el.textContent);
    expect(turns.filter((t) => t?.includes("primeira frase"))).toHaveLength(1);
    // The reply still being said is on screen too, from the call itself.
    expect(turns.some((t) => t?.includes("ok"))).toBe(true);
    expect(screen.getByTestId("voice-call-bar")).toBeInTheDocument();
  });

  it("the replying sphere is blue and follows the assistant's REAL audio track", async () => {
    await openChat();
    await startCall();
    act(() => rig.peer().remoteTrack());
    audio.play(rig.peer().remoteStream, 0.1);
    act(() => channel().emit({ type: "session.output_transcript.delta", delta: "Claro, vou ver." }));
    const orb = screen.getByTestId("voice-call-orb");
    await waitFor(() => expect(orb).toHaveAttribute("data-orb", "talk"));
    await waitFor(() => expect(orb.dataset.aiSource).toBe("analyser"));
    expect(Number(orb.dataset.aiRms)).toBeGreaterThan(0.05);
    await waitFor(() => expect(Number(orb.dataset.aiVisual)).toBeGreaterThan(0.5));
    expect(screen.getByTestId("voice-call-bar")).toHaveAttribute("data-phase", "ai_speaking");
  });
});
