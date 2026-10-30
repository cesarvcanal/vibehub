import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { act } from "react";
import { SdkChatView } from "@/features/board/components/SdkChatView";
import { resetDraftsForTesting } from "@/features/board/components/TerminalComposer";
import { finishedAnswerIds, type SdkEvent, type SdkRow } from "@/features/board/lib/sdkChat";
import { readAloud } from "@/features/voice/readAloud";
import { renderApp } from "@/test/render";
import { api, get } from "@/lib/api";
import { resetLanguage, setLanguage } from "@/i18n";

/**
 * "COPIAR" E "OUVIR" EMBAIXO DA RESPOSTA, como no ChatGPT: só na resposta final de cada rodada, e a
 * da rodada atual só quando a IA parou de vez — sem turno rodando e sem tarefa em segundo plano.
 */

vi.mock("@/lib/api", () => ({
  api: { defaults: { baseURL: "/api" }, interceptors: { response: { use: vi.fn() } }, post: vi.fn() },
  setUnauthorizedHandler: vi.fn(),
  get: vi.fn(),
  post: vi.fn(() => Promise.resolve({})),
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
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(public url: string) {
    FakeSocket.instances.push(this);
  }
  send(): void {}
  close(): void {
    this.readyState = 3;
  }
  accept(): void {
    this.readyState = 1;
    act(() => this.onopen?.());
  }
  deliver(event: SdkEvent | Record<string, unknown>): void {
    act(() => this.onmessage?.({ data: JSON.stringify(event) } as MessageEvent));
    act(() => frames.splice(0).forEach((cb) => cb(performance.now())));
  }
}

class FakeAudio {
  src = "";
  play = vi.fn(() => Promise.resolve());
  pause = vi.fn();
  addEventListener = vi.fn();
  removeEventListener = vi.fn();
}

let frames: FrameRequestCallback[] = [];
let speech = true;
const OWNER = { id: "1", username: "operator", role: "owner" };

beforeEach(() => {
  resetDraftsForTesting();
  localStorage.clear();
  setLanguage("en");
  FakeSocket.instances = [];
  frames = [];
  speech = true;
  vi.stubGlobal("WebSocket", FakeSocket);
  vi.stubGlobal("Audio", FakeAudio);
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => frames.push(cb));
  vi.stubGlobal("cancelAnimationFrame", () => undefined);
  URL.createObjectURL = vi.fn(() => "blob:fake");
  URL.revokeObjectURL = vi.fn();
  vi.mocked(get).mockImplementation(((url: string) => {
    if (url === "/auth/me") return Promise.resolve({ user: OWNER });
    if (url === "/voice/live") return Promise.resolve({ enabled: false, available: false, model: "gpt-live-1", speech });
    return Promise.resolve({ available: false, proofread: false, language: null });
  }) as never);
  vi.mocked(api.post).mockReset();
  vi.mocked(api.post).mockImplementation((() => new Promise(() => undefined)) as never);
});

afterEach(() => {
  readAloud.stop();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
  resetLanguage();
});

async function openChat() {
  const view = renderApp(<SdkChatView cardId="c1" />);
  await waitFor(() => expect(FakeSocket.instances.length).toBeGreaterThan(0));
  const ws = FakeSocket.instances[0]!;
  ws.accept();
  ws.deliver({ type: "ready" });
  return { ws, ...view };
}

const SID = "0d1b3864-4870-4141-8451-79d73de0bd96";

describe("copy and listen under a finished answer", () => {
  it("appear only on the turn's FINAL answer, and only once the turn is over", async () => {
    const { ws } = await openChat();
    ws.deliver({ type: "user", text: "roda os testes" });
    ws.deliver({ type: "assistant_text", text: "Vou rodar os testes." });
    ws.deliver({ type: "tool_use", id: "t1", name: "Bash", input: { command: "npm test" } });
    ws.deliver({ type: "assistant_text", text: "Tudo **verde**." });
    // Turn still running: nothing to copy yet — the answer may still change.
    expect(screen.queryByTestId("sdk-answer-actions")).toBeNull();

    ws.deliver({ type: "result", isError: false, sessionId: SID });
    const actions = await screen.findAllByTestId("sdk-answer-actions");
    expect(actions).toHaveLength(1);
    const answers = screen.getAllByTestId("sdk-assistant");
    expect(within(answers.at(-1)!).getByTestId("sdk-answer-actions")).toBeInTheDocument();
    expect(within(answers[0]!).queryByTestId("sdk-answer-actions")).toBeNull();
    expect(await screen.findByTestId("sdk-answer-listen")).toBeInTheDocument();
  });

  it("a background task still running holds them back, and they show when it ends", async () => {
    const { ws } = await openChat();
    ws.deliver({ type: "user", text: "sobe o deploy" });
    ws.deliver({ type: "assistant_text", text: "Deploy disparado." });
    ws.deliver({ type: "background_tasks", tasks: [{ id: "b1", type: "local_bash", description: "Aguarda o deploy" }] });
    ws.deliver({ type: "result", isError: false, sessionId: SID });
    expect(screen.queryByTestId("sdk-answer-actions")).toBeNull();
    ws.deliver({ type: "background_tasks", tasks: [] });
    expect(await screen.findByTestId("sdk-answer-actions")).toBeInTheDocument();
  });

  it("past answers keep theirs while a new turn runs", async () => {
    const { ws } = await openChat();
    ws.deliver({ type: "user", text: "primeira" });
    ws.deliver({ type: "assistant_text", text: "Resposta um." });
    ws.deliver({ type: "result", isError: false, sessionId: SID });
    ws.deliver({ type: "user", text: "segunda" });
    ws.deliver({ type: "assistant_delta", text: "Escrevendo" });
    const actions = await screen.findAllByTestId("sdk-answer-actions");
    expect(actions).toHaveLength(1);
    expect(actions[0]!.closest("[data-testid=sdk-assistant]")).toHaveTextContent("Resposta um.");
  });

  it("copy puts the whole answer, as written, on the clipboard and confirms", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const { ws } = await openChat();
    ws.deliver({ type: "user", text: "resume" });
    ws.deliver({ type: "assistant_text", text: "## Feito\n\n- item **um**" });
    ws.deliver({ type: "result", isError: false, sessionId: SID });
    await user.click(await screen.findByTestId("sdk-answer-copy"));
    expect(writeText).toHaveBeenCalledWith("## Feito\n\n- item **um**");
    expect(await screen.findByRole("button", { name: "Copied" })).toBeInTheDocument();
  });

  it("listen asks the server for the voice, shows it is preparing, and the same button stops it", async () => {
    const user = userEvent.setup();
    const { ws } = await openChat();
    ws.deliver({ type: "user", text: "resume" });
    ws.deliver({ type: "assistant_text", text: "Deploy **feito**, tudo verde." });
    ws.deliver({ type: "result", isError: false, sessionId: SID });
    const listen = await screen.findByTestId("sdk-answer-listen");
    expect(listen).toHaveAttribute("data-phase", "idle");
    await user.click(listen);
    expect(api.post).toHaveBeenCalledWith(
      "/cards/c1/voice/speech",
      { text: "Deploy feito, tudo verde." },
      expect.objectContaining({ responseType: "blob" }),
    );
    expect(listen).toHaveAttribute("data-phase", "loading");
    await user.click(listen);
    expect(listen).toHaveAttribute("data-phase", "idle");
    const signal = (vi.mocked(api.post).mock.calls[0]![2] as { signal: AbortSignal }).signal;
    expect(signal.aborted).toBe(true);
  });

  it("no speaker when the server has no voice key — copy stays", async () => {
    speech = false;
    const { ws } = await openChat();
    ws.deliver({ type: "user", text: "oi" });
    ws.deliver({ type: "assistant_text", text: "Olá." });
    ws.deliver({ type: "result", isError: false, sessionId: SID });
    expect(await screen.findByTestId("sdk-answer-copy")).toBeInTheDocument();
    await waitFor(() => expect(get).toHaveBeenCalledWith("/voice/live"));
    expect(screen.queryByTestId("sdk-answer-listen")).toBeNull();
  });

  it("closing the chat stops a reading of its answer", async () => {
    const user = userEvent.setup();
    const { ws, unmount } = await openChat();
    ws.deliver({ type: "user", text: "oi" });
    ws.deliver({ type: "assistant_text", text: "Olá." });
    ws.deliver({ type: "result", isError: false, sessionId: SID });
    await user.click(await screen.findByTestId("sdk-answer-listen"));
    expect(readAloud.getState()?.cardId).toBe("c1");
    unmount();
    expect(readAloud.getState()).toBeNull();
  });
});

describe("finishedAnswerIds", () => {
  const user = (id: string): SdkRow => ({ kind: "user", id, text: "q", state: "sent" });
  const said = (id: string, text = "a", extra: Partial<Extract<SdkRow, { kind: "assistant" }>> = {}): SdkRow =>
    ({ kind: "assistant", id, text, streaming: false, ...extra });

  it("one per round: the last main-agent answer before the next message", () => {
    const rows = [user("u1"), said("a1"), said("a2"), user("u2"), said("a3")];
    expect([...finishedAnswerIds(rows, true)]).toEqual(["a2", "a3"]);
    expect([...finishedAnswerIds(rows, false)]).toEqual(["a2"]);
  });

  it("skips subagents, streaming text and blank blocks", () => {
    const rows = [user("u1"), said("a1"), said("sub", "x", { parent: "t1" }), said("blank", "  "), said("live", "x", { streaming: true })];
    expect([...finishedAnswerIds(rows, true)]).toEqual(["a1"]);
  });

  it("a round with no answer gives nothing", () => {
    expect([...finishedAnswerIds([user("u1"), user("u2")], true)]).toEqual([]);
    expect([...finishedAnswerIds([], true)]).toEqual([]);
  });
});
