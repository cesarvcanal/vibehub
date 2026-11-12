import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Profiler, act } from "react";
import { OUTBOX_TICK_MS, SdkChatView, resetQuestionDraftsForTesting } from "@/features/board/components/SdkChatView";
import { AUTO_RESEND_DELAYS_MS, AUTO_RESEND_MAX_AGE_MS, OUTBOX_ACK_TIMEOUT_MS } from "@/features/board/lib/sdkOutbox";
import { RECONNECT_MAX_MS } from "@/features/board/lib/reconnect";
import { PEER_TYPING_TTL_MS } from "@/features/board/lib/peerTyping";
import { renderApp } from "@/test/render";
import type { SdkEvent, SdkRow } from "@/features/board/lib/sdkChat";
import { resetLanguage, setLanguage } from "@/i18n";
import { resetReasoningTranslatorForTesting } from "@/features/board/lib/reasoningTranslation";
import { get } from "@/lib/api";
import { LinkifiedText, Markdown } from "@/features/board/components/ChatView";
import { resetDraftsForTesting } from "@/features/board/components/TerminalComposer";
import { ME_KEY } from "@/providers/auth";
import { ACTION_POLL_MS, fleetPropsEqual } from "@/features/board/components/SdkDetail";

vi.mock("@/lib/api", () => ({
  api: { interceptors: { response: { use: vi.fn() } } },
  setUnauthorizedHandler: vi.fn(),
  get: vi.fn(() => Promise.resolve({ available: false, proofread: false, language: null })),
  post: vi.fn(() => Promise.resolve({ ok: true })),
  patch: vi.fn(),
  del: vi.fn(),
}));

// Passthrough with a counter: the rendering is the real one, and how many times a bubble was redrawn
// becomes observable (the transcript cost test, further below). `Markdown` is a memo: the counter
// lives INSIDE it, so it counts only real parses, not the renders the memo skipped.
vi.mock("@/features/board/components/ChatView", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/features/board/components/ChatView")>();
  const { memo } = await import("react");
  const parse: unknown = (actual.Markdown as unknown as { type?: unknown }).type;
  if (typeof parse !== "function") {
    throw new Error(
      "mock do ChatView: o `Markdown` deixou de ser um React.memo (sem `.type` função) — "
      + "o contador de parses deste arquivo precisa ser refeito para o novo formato.",
    );
  }
  // Checked above that it is a function; the signature is that of the component the memo wraps.
  const render = parse as (props: { text: string }) => React.ReactElement;
  return { ...actual, LinkifiedText: vi.fn(actual.LinkifiedText), Markdown: memo(vi.fn(render)) };
});

// Same passthrough with a counter, for the subagent card: a token from the main agent must not
// redraw it.
vi.mock("@/features/board/components/SdkAgentCard", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/features/board/components/SdkAgentCard")>();
  return actual;
});

vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), {
    success: vi.fn(),
    error: vi.fn(),
    message: vi.fn(),
    loading: vi.fn(() => "toast-id"),
    dismiss: vi.fn(),
  }),
}));

/* -------------------------------------------------------- websocket stub */

class FakeSocket {
  static instances: FakeSocket[] = [];
  static OPEN = 1;

  readyState = 0;
  /** EVERYTHING that went out through the socket, handshake included — what the handshake tests read. */
  rawSent: string[] = [];
  /**
   * The CONVERSATION frames. `typing` is an ephemeral signal between tabs, nobody's speech: counting it here
   * would make every test that measures "ONE message went out" measure two.
   */
  get sent(): string[] {
    return this.rawSent.filter((raw) => {
      try {
        const type = (JSON.parse(raw) as { type?: string }).type;
        return type !== "typing";
      } catch { return true; }
    });
  }
  /** Only the "está digitando" signals this tab sent, in order. */
  get typingSent(): boolean[] {
    return this.rawSent.flatMap((raw) => {
      try {
        const frame = JSON.parse(raw) as { type?: string; active?: boolean };
        return frame.type === "typing" ? [frame.active === true] : [];
      } catch { return []; }
    });
  }
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;

  constructor(public url: string) {
    FakeSocket.instances.push(this);
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
  /** A socket frame followed by an animation frame — the normal rhythm of a real socket. */
  deliver(event: SdkEvent): void {
    this.receive(event);
    runAnimationFrames();
  }
  /** Only the socket frame: whatever arrives this way stays in the same animation frame until `runAnimationFrames`. */
  receive(event: SdkEvent): void {
    act(() => this.onmessage?.({ data: JSON.stringify(event) } as MessageEvent));
  }
}

/**
 * Animation frames are in the test's hands: jsdom fires them on the real clock, which
 * would leave every assertion right after a `deliver` depending on whether 16ms had passed or not.
 */
let animationFrames = new Map<number, FrameRequestCallback>();
let nextAnimationFrame = 1;
function runAnimationFrames(): void {
  const due = [...animationFrames.values()];
  animationFrames = new Map();
  if (due.length > 0) act(() => due.forEach((callback) => callback(performance.now())));
}

const originalWebSocket = globalThis.WebSocket;

beforeEach(() => {
  vi.clearAllMocks();
  // The composer keeps each card's draft in a MODULE-level map (it survives a remount on
  // purpose) — and every test here is card "c1": what one test left in the field got typed into the
  // next one ("vai pelo A mesmoinstrução longa", with the order scrambled).
  resetDraftsForTesting();
  resetQuestionDraftsForTesting();
  FakeSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeSocket);
  animationFrames = new Map();
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    const id = nextAnimationFrame++;
    animationFrames.set(id, callback);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => {
    animationFrames.delete(id);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  globalThis.WebSocket = originalWebSocket;
  // `setLanguage` writes the choice to localStorage and `resetLanguage` RE-READS it from there — and the setup's
  // storage cleanup only runs after this hook. Without clearing first, a test in pt-BR left the
  // whole file in pt-BR for whoever came next.
  localStorage.clear();
  resetLanguage();
});

async function socket(): Promise<FakeSocket> {
  await waitFor(() => expect(FakeSocket.instances.length).toBeGreaterThan(0));
  return FakeSocket.instances[0] as FakeSocket;
}

function renderSdkChat(props: Partial<React.ComponentProps<typeof SdkChatView>> = {}) {
  return renderApp(<SdkChatView cardId="c1" {...props} />);
}

describe("SdkChatView", () => {
  it("o slot footer fica logo acima do composer (é onde o card põe o que é do card, não da conversa)", async () => {
    renderSdkChat({ footer: <div data-testid="sdk-footer-slot">PR #553</div> });
    await socket();

    const footer = screen.getByTestId("sdk-footer-slot");
    expect(footer.nextElementSibling).toBe(screen.getByTestId("terminal-composer"));
  });

  it("opens the SDK socket for the card and reports its state", async () => {
    const onStatus = vi.fn();
    renderSdkChat({ onStatus });
    const ws = await socket();
    expect(ws.url).toContain("/api/cards/c1/sdk");
    ws.accept();
    expect(onStatus).toHaveBeenCalledWith("open");
  });

  it("spins the running tool's icon without a transform utility fighting the animation", async () => {
    // `animate-spin` animates `transform`; a `translate-*` on the same element became the
    // animation's starting point and the spinner just slid 2px and back, without spinning.
    renderSdkChat();
    const ws = await socket();
    ws.accept();
    ws.deliver({ type: "ready" });
    ws.deliver({ type: "tool_use", id: "t1", name: "Bash", input: { command: "npm test" } });

    const tool = screen.getByTestId("sdk-tool");
    expect(tool).toHaveAttribute("data-status", "running");
    const spinners = Array.from(document.querySelectorAll("svg.animate-spin"));
    expect(spinners.length).toBeGreaterThan(0);
    expect(tool.querySelector("svg.animate-spin")).not.toBeNull();
    for (const svg of spinners) {
      expect(svg.getAttribute("class")).not.toMatch(/(^|\s)-?(translate|rotate|scale|skew)-/);
    }
  });

  it("renders the streamed answer and the tool calls as compact lines", async () => {
    renderSdkChat();
    const ws = await socket();
    ws.accept();
    ws.deliver({ type: "ready" });
    ws.deliver({ type: "assistant_delta", text: "Rodando os " });
    ws.deliver({ type: "assistant_delta", text: "testes…" });
    ws.deliver({ type: "tool_use", id: "t1", name: "Bash", input: { command: "npm test" } });
    ws.deliver({ type: "assistant_text", text: "Tudo **verde**." });
    ws.deliver({ type: "result", isError: false, sessionId: "0d1b3864-4870-4141-8451-79d73de0bd96" });

    expect(screen.getByTestId("sdk-tool")).toHaveTextContent("Bash");
    expect(screen.getByTestId("sdk-tool")).toHaveTextContent("npm test");
    const answers = screen.getAllByTestId("sdk-assistant");
    expect(answers[answers.length - 1]).toHaveTextContent("Tudo verde.");
    expect(screen.getByText("verde").tagName).toBe("STRONG");
    // the footer shows the session (resume key)
    expect(screen.getByTestId("sdk-chat-footer")).toHaveTextContent("0d1b3864");
  });

  it("sends the composed message over the socket and draws it as sent", async () => {
    renderSdkChat();
    const ws = await socket();
    ws.accept();
    ws.deliver({ type: "ready" });

    const box = screen.getByRole("textbox");
    await userEvent.type(box, "roda os testes{Enter}");

    await waitFor(() => expect(ws.sent.length).toBe(1));
    // The frame now carries a RECEIPT id (`cid`) — the back answers it with `user_ack` once the
    // message is on disk (see lib/sdkOutbox.ts).
    expect(JSON.parse(ws.sent[0]!)).toMatchObject({ type: "user", text: "roda os testes" });
    expect((JSON.parse(ws.sent[0]!) as { cid?: string }).cid).toBeTruthy();
    expect(screen.getByTestId("sdk-user")).toHaveTextContent("roda os testes");
  });

  it("a URL in a user message is clickable; javascript: never becomes a link", async () => {
    renderSdkChat();
    const ws = await socket();
    ws.accept();
    ws.deliver({ type: "ready" });

    const box = screen.getByRole("textbox");
    await userEvent.type(box, "abre /preview/3100/ ou javascript:alert(1){Enter}");

    const bubble = await screen.findByTestId("sdk-user");
    const anchors = bubble.querySelectorAll("a");
    expect(anchors).toHaveLength(1);
    expect(anchors[0]).toHaveAttribute("href", "/preview/3100/");
    expect(anchors[0]).toHaveAttribute("target", "_blank");
    expect(anchors[0]?.getAttribute("rel")).toContain("noopener");
    expect(bubble).toHaveTextContent("javascript:alert(1)");
  });

  it("draws an AGENT's message as the green robot bubble, named and linked to its card", async () => {
    renderSdkChat();
    const ws = await socket();
    ws.accept();
    ws.deliver({
      type: "user", text: "roda os testes",
      from: { kind: "agent", name: "card preview", sourceCardId: "c9", sourceProjectId: "p1" },
    });

    const bubble = await screen.findByTestId("sdk-user");
    expect(bubble).toHaveAttribute("data-role", "agent");
    expect(screen.getByTestId("chat-sender")).toHaveTextContent("card preview");
    expect(screen.getByTestId("chat-sender-link")).toHaveAttribute("href", "/?project=p1&card=c9");
  });

  it("draws another person's replayed message with their name; an unattributed one stays plain", async () => {
    renderSdkChat();
    const ws = await socket();
    ws.accept();
    ws.deliver({ type: "user", text: "fala alex", from: { kind: "user", name: "alex" } });
    ws.deliver({ type: "user", text: "minha própria" });

    await screen.findByText("fala alex");
    const bubbles = screen.getAllByTestId("sdk-user");
    expect(bubbles[0]).toHaveAttribute("data-role", "user");
    expect(screen.getByTestId("chat-sender")).toHaveTextContent("alex");
    expect(bubbles[1]).not.toHaveAttribute("data-role");
    expect(screen.getAllByTestId("chat-sender")).toHaveLength(1);
  });

  it("a permission request shows Allow/Deny; Allow sends the decision and settles the card", async () => {
    renderSdkChat();
    const ws = await socket();
    ws.accept();
    ws.deliver({ type: "ready" });
    ws.deliver({ type: "permission_request", id: "perm_1", tool: "Bash", input: { command: "rm -rf ." } });

    const card = screen.getByTestId("sdk-permission");
    expect(card).toHaveAttribute("data-outcome", "pending");
    expect(card).toHaveTextContent("rm -rf .");

    await userEvent.click(screen.getByTestId("sdk-permission-allow"));
    await waitFor(() => expect(ws.sent.length).toBe(1));
    expect(JSON.parse(ws.sent[0]!)).toEqual({ type: "permission_decision", id: "perm_1", allow: true });
    expect(screen.getByTestId("sdk-permission")).toHaveAttribute("data-outcome", "allowed");
    // the buttons are gone — no second answer
    expect(screen.queryByTestId("sdk-permission-allow")).toBeNull();
  });

  it("Deny sends allow:false", async () => {
    renderSdkChat();
    const ws = await socket();
    ws.accept();
    ws.deliver({ type: "permission_request", id: "perm_2", tool: "KillShell" });

    await userEvent.click(screen.getByTestId("sdk-permission-deny"));
    expect(JSON.parse(ws.sent[0]!)).toEqual({ type: "permission_decision", id: "perm_2", allow: false });
    expect(screen.getByTestId("sdk-permission")).toHaveAttribute("data-outcome", "denied");
  });

  it("the interrupt button appears while a turn runs and sends the interrupt", async () => {
    renderSdkChat();
    const ws = await socket();
    ws.accept();
    expect(screen.queryByTestId("sdk-interrupt")).toBeNull();
    // A live turn only exists after `ready` — replayed events must not arm the button.
    ws.deliver({ type: "ready" });
    ws.deliver({ type: "assistant_delta", text: "trabalhando…" });

    await userEvent.click(screen.getByTestId("sdk-interrupt"));
    expect(JSON.parse(ws.sent[0]!)).toEqual({ type: "interrupt" });

    ws.deliver({ type: "result", isError: false });
    expect(screen.queryByTestId("sdk-interrupt")).toBeNull();
  });

  it("draws the server's replay — the conversation survives a remount instead of 'sumindo'", async () => {
    renderSdkChat();
    const ws = await socket();
    ws.accept();
    // What the back replays from the per-card history log (and the TUI transcript) on connect:
    ws.deliver({ type: "user", text: "manda a primeira" });
    ws.deliver({ type: "tool_use", id: "t1", name: "Bash", input: { command: "npm test" } });
    ws.deliver({ type: "assistant_text", text: "Feito." });
    ws.deliver({ type: "ready", resume: "bfe63d25-95df-4c86-bf34-047b1366cc02" });

    expect(screen.getByTestId("sdk-user")).toHaveTextContent("manda a primeira");
    expect(screen.getByTestId("sdk-assistant")).toHaveTextContent("Feito.");
    // a replayed tail never leaves the working spinner on: the fresh driver runs nothing yet
    expect(screen.queryByTestId("sdk-chat-working")).toBeNull();
  });

  it("mounting mid-turn shows 'Trabalhando…' — the `ready` carries the manager's turn state", async () => {
    // Terminal↔Chat with a turn running: the remounted view replays, reattaches to the LIVE
    // driver, and the synthesized `ready` says a turn is in flight — the spinner must be on
    // from the mount, and go out on the result.
    renderSdkChat();
    const ws = await socket();
    ws.accept();
    ws.deliver({ type: "user", text: "faz a coisa" });
    ws.deliver({ type: "assistant_text", text: "começando…" });
    ws.deliver({ type: "ready", turnActive: true });
    expect(screen.getByTestId("sdk-chat-working")).toBeInTheDocument();
    expect(screen.getByTestId("sdk-interrupt")).toBeInTheDocument();

    ws.deliver({ type: "result", isError: false });
    expect(screen.queryByTestId("sdk-chat-working")).toBeNull();
  });

  it("resets the slate on every open — a reconnect's full replay is drawn once, not twice", async () => {
    renderSdkChat();
    const ws = await socket();
    ws.accept();
    ws.deliver({ type: "user", text: "manda a primeira" });
    ws.deliver({ type: "assistant_text", text: "Feito." });
    expect(screen.getAllByTestId("sdk-user")).toHaveLength(1);

    // the socket re-opens (reconnect): the server replays the WHOLE history again
    ws.accept();
    ws.deliver({ type: "user", text: "manda a primeira" });
    ws.deliver({ type: "assistant_text", text: "Feito." });
    ws.deliver({ type: "ready" });

    expect(screen.getAllByTestId("sdk-user")).toHaveLength(1);
    expect(screen.getAllByTestId("sdk-assistant")).toHaveLength(1);
  });

  it("a driver error is visible — including the flag-off refusal, translated", async () => {
    renderSdkChat();
    const ws = await socket();
    ws.accept();
    ws.deliver({ type: "error", message: "the SDK driver is off (enable the sdkDriver setting)" });
    expect(screen.getByTestId("sdk-error")).toHaveTextContent(/SDK driver is off/i);
  });

  it("'Trabalhando…' dies with the socket — a dead driver cannot be working", async () => {
    // The production incident: the back redeployed mid-turn, the socket dropped without a result,
    // and the spinner stayed frozen on screen while the conversation moved on in the terminal.
    renderSdkChat();
    const ws = await socket();
    ws.accept();
    ws.deliver({ type: "ready" });
    ws.deliver({ type: "assistant_delta", text: "meio de fra" });
    expect(screen.getByTestId("sdk-chat-working")).toBeInTheDocument();

    act(() => ws.onclose?.());
    expect(screen.queryByTestId("sdk-chat-working")).toBeNull();
  });

  /**
   * THE HANDSHAKE IS NOT HEALTH. The back accepts the websocket and only AFTERWARDS finds out it cannot
   * serve it (driver turned off, card deleted, install failed): it sends the error and closes. Resetting the
   * backoff in `onopen` turned that into a reconnect at ~2Hz forever — each one paying the server's whole
   * setup (session, settings, and on install, SSH+docker). Only `ready` proves the connection.
   */
  it("aceitar e recusar em seguida não zera o backoff — só o `ready` do servidor zera", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      renderSdkChat();
      const refuse = (ws: FakeSocket): void => {
        ws.accept();
        ws.deliver({ type: "error", message: "the SDK driver is off (enable the sdkDriver setting)" });
        act(() => { ws.readyState = 3; ws.onclose?.(); });
      };
      refuse(await socket());
      await act(async () => { await vi.advanceTimersByTimeAsync(600); });
      expect(FakeSocket.instances).toHaveLength(2);

      refuse(FakeSocket.instances[1] as FakeSocket);
      // the second refusal waits LONGER than the first (the backoff advanced), it does not go back to 400ms
      await act(async () => { await vi.advanceTimersByTimeAsync(600); });
      expect(FakeSocket.instances).toHaveLength(2);
      await act(async () => { await vi.advanceTimersByTimeAsync(600); });
      expect(FakeSocket.instances).toHaveLength(3);

      // a connection the server TOOK OVER (`ready`) resets it: the next drop is a blink again
      const healthy = FakeSocket.instances[2] as FakeSocket;
      healthy.accept();
      healthy.deliver({ type: "ready" });
      act(() => { healthy.readyState = 3; healthy.onclose?.(); });
      await act(async () => { await vi.advanceTimersByTimeAsync(600); });
      expect(FakeSocket.instances).toHaveLength(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it("terminal-mirrored events draw the conversation with an 'activity in the terminal' note — no spinner", async () => {
    renderSdkChat();
    const ws = await socket();
    ws.accept();
    ws.deliver({ type: "ready" });
    ws.deliver({ type: "user", text: "ok boa como a gnt segue?", source: "terminal" });
    ws.deliver({ type: "assistant_text", text: "Seguimos assim…", source: "terminal" });

    expect(screen.getByTestId("sdk-note")).toHaveTextContent(/terminal/i);
    expect(screen.getByTestId("sdk-user")).toHaveTextContent("ok boa como a gnt segue?");
    expect(screen.getByTestId("sdk-assistant")).toHaveTextContent("Seguimos assim…");
    expect(screen.queryByTestId("sdk-chat-working")).toBeNull();
  });

  /**
   * THE TURN RUNNING IN THE TERMINAL. After a deploy the card may continue in the `claude` of the Terminal tab
   * (card "POC modo de voz", 2026-10-21): the chat only mirrors, no driver event lights the
   * indicator, and the screen looked idle with the AI working. What knows it is working is the card's
   * status (hooks): with it on "working", the mirror lights the indicator and names the tool.
   */
  it("turno no terminal com o card trabalhando acende o indicador com a ferramenta; apaga quando o card para", async () => {
    const view = renderSdkChat({ terminalWorking: true });
    const ws = await socket();
    ws.accept();
    ws.deliver({ type: "ready" });
    ws.deliver({ type: "user", text: "segue", source: "terminal" });
    ws.deliver({ type: "tool_use", id: "t1", name: "Bash", input: { command: "npm test", description: "Rodando os testes" }, source: "terminal" });

    expect(screen.getByTestId("sdk-chat-working")).toHaveTextContent("Rodando os testes");

    view.rerender(<SdkChatView cardId="c1" terminalWorking={false} />);
    expect(screen.queryByTestId("sdk-chat-working")).toBeNull();
  });

  it("card trabalhando sem atividade do terminal não acende nada — o driver ocioso não está trabalhando", async () => {
    renderSdkChat({ terminalWorking: true });
    const ws = await socket();
    ws.accept();
    ws.deliver({ type: "user", text: "manda" });
    ws.deliver({ type: "assistant_text", text: "Feito." });
    ws.deliver({ type: "ready" });
    expect(screen.queryByTestId("sdk-chat-working")).toBeNull();
  });
});

describe("SdkChatView — perguntas com opções (AskUserQuestion)", () => {
  const QUESTION = {
    type: "user_question" as const,
    id: "q_1",
    questions: [
      {
        question: "Como formatar a saída?",
        header: "Formato",
        options: [
          { label: "Resumo", description: "Visão geral" },
          { label: "Detalhado", description: "Explicação completa" },
        ],
      },
    ],
  };

  it("renders the question card and a CLICK on an option answers it (single choice)", async () => {
    renderSdkChat();
    const ws = await socket();
    ws.accept();
    ws.deliver({ type: "ready" });
    ws.deliver(QUESTION);

    const card = screen.getByTestId("sdk-question");
    expect(card).toHaveAttribute("data-outcome", "pending");
    expect(card).toHaveTextContent("Como formatar a saída?");

    await userEvent.click(screen.getByRole("button", { name: "Resumo" }));
    const frame = ws.sent.map((s) => JSON.parse(s)).find((f) => f.type === "question_answer");
    expect(frame).toEqual({ type: "question_answer", id: "q_1", answers: [{ selected: ["Resumo"] }] });
    // optimistic settle — and the driver's echo cannot flip it
    expect(screen.getByTestId("sdk-question")).toHaveAttribute("data-outcome", "answered");
    expect(screen.getByTestId("sdk-question")).toHaveTextContent("Resumo");
    ws.deliver({ type: "question_result", id: "q_1", answers: [{ selected: ["Resumo"] }] });
    expect(screen.getByTestId("sdk-question")).toHaveAttribute("data-outcome", "answered");
  });

  it("multiSelect collects the picks and sends them together on 'Answer'", async () => {
    renderSdkChat();
    const ws = await socket();
    ws.accept();
    ws.deliver({ type: "ready" });
    ws.deliver({
      type: "user_question",
      id: "q_2",
      questions: [
        {
          question: "Quais seções?",
          options: [{ label: "Intro" }, { label: "Meio" }, { label: "Fim" }],
          multiSelect: true,
        },
      ],
    });

    const send = screen.getByTestId("sdk-question-send");
    expect(send).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Intro" }));
    await userEvent.click(screen.getByRole("button", { name: "Fim" }));
    expect(send).toBeEnabled();
    await userEvent.click(send);

    const frame = ws.sent.map((s) => JSON.parse(s)).find((f) => f.type === "question_answer");
    expect(frame).toEqual({ type: "question_answer", id: "q_2", answers: [{ selected: ["Intro", "Fim"] }] });
    expect(screen.getByTestId("sdk-question")).toHaveAttribute("data-outcome", "answered");
  });

  it("the free-text 'other answer' rides as the answer", async () => {
    renderSdkChat();
    const ws = await socket();
    ws.accept();
    ws.deliver({ type: "ready" });
    ws.deliver(QUESTION);

    await userEvent.type(screen.getByTestId("sdk-question-other"), "nenhum dos dois, faz em tabela");
    await userEvent.click(screen.getByTestId("sdk-question-send"));

    const frame = ws.sent.map((s) => JSON.parse(s)).find((f) => f.type === "question_answer");
    expect(frame).toEqual({
      type: "question_answer",
      id: "q_1",
      answers: [{ selected: ["nenhum dos dois, faz em tabela"] }],
    });
  });

  it("REPLAY: a pending question replayed before `ready` comes back CLICKABLE (survives F5)", async () => {
    renderSdkChat();
    const ws = await socket();
    ws.accept();
    // replay lands BEFORE ready — the exact reconnect order
    ws.deliver(QUESTION);
    ws.deliver({ type: "ready", turnActive: true });

    expect(screen.getByTestId("sdk-question")).toHaveAttribute("data-outcome", "pending");
    await userEvent.click(screen.getByRole("button", { name: "Detalhado" }));
    const frame = ws.sent.map((s) => JSON.parse(s)).find((f) => f.type === "question_answer");
    expect(frame).toEqual({ type: "question_answer", id: "q_1", answers: [{ selected: ["Detalhado"] }] });
  });

  /**
   * TWO PEOPLE, ONE QUESTION: only the first answer counts, and whoever was answering did not know there was
   * another person writing something else. The card shows, in real time, what the other one is doing.
   */
  describe("rascunho de outra pessoa em tempo real", () => {
    const MULTI = {
      type: "user_question" as const,
      id: "q_peer",
      questions: [
        { question: "Quem abre o PR?", options: [{ label: "Albert" }, { label: "Mussa" }] },
        { question: "E o review?", options: [{ label: "Mussa" }] },
      ],
    };

    it("mostra o que a outra pessoa marca e escreve, e apaga quando ela apaga", async () => {
      renderSdkChat();
      const ws = await socket();
      ws.accept();
      ws.deliver({ type: "ready" });
      ws.deliver(MULTI);
      expect(screen.queryByTestId("sdk-question-peer-presence")).toBeNull();

      ws.deliver({ type: "peer_question_draft", id: "q_peer", name: "albert", picked: [["Albert"], []], other: ["", "mussa faz review"] });
      expect(screen.getByTestId("sdk-question-peer-presence")).toHaveTextContent("Albert");
      // only the question where he WROTE gets his field; the selection stays on the option's dot
      const lines = screen.getAllByTestId("sdk-question-peer-draft");
      expect(lines).toHaveLength(1);
      expect(lines[0]).toHaveTextContent("mussa faz review");
      // with nothing written by me, no conflict warning
      expect(screen.queryByTestId("sdk-question-peer-clash")).toBeNull();
      const [albertOption] = screen.getAllByRole("button", { name: "Albert" });
      expect(albertOption).toHaveAttribute("data-peer-picked", "true");
      expect(albertOption).toHaveAttribute("aria-pressed", "false"); // selected by HIM, not by me

      ws.deliver({ type: "peer_question_draft", id: "q_peer", name: "albert", picked: [[], []], other: ["", ""] });
      expect(screen.queryByTestId("sdk-question-peer-presence")).toBeNull();
      expect(screen.queryAllByTestId("sdk-question-peer-draft")).toHaveLength(0);
    });

    it("\"Usar esta\" copia a resposta da outra pessoa para o meu cartão — e aí sim aparece o aviso de conflito", async () => {
      renderSdkChat();
      const ws = await socket();
      ws.accept();
      ws.deliver({ type: "ready" });
      ws.deliver(MULTI);
      ws.deliver({ type: "peer_question_draft", id: "q_peer", name: "albert", picked: [["Albert"], []], other: ["", "mussa faz review"] });
      await userEvent.click(screen.getByTestId("sdk-question-peer-use"));
      expect(screen.getAllByTestId("sdk-question-other")[1]).toHaveValue("mussa faz review");
      expect(screen.getByTestId("sdk-question-peer-clash")).toHaveTextContent("Albert");
    });

    it("o que EU marco e escrevo vai para as outras abas, com o último estado", async () => {
      renderSdkChat();
      const ws = await socket();
      ws.accept();
      ws.deliver({ type: "ready" });
      ws.deliver(MULTI);
      const drafts = () => ws.sent.map((x) => JSON.parse(x)).filter((f) => f.type === "question_draft");
      expect(drafts()).toEqual([]); // an empty card announces nothing when it is born

      await userEvent.click(screen.getAllByRole("button", { name: "Mussa" })[0]!);
      await userEvent.type(screen.getAllByTestId("sdk-question-other")[1]!, "albert revisa");
      await waitFor(() =>
        expect(drafts().at(-1)).toEqual({ type: "question_draft", id: "q_peer", picked: [["Mussa"], []], other: ["", "albert revisa"], at: expect.any(Number) }),
      );
      expect(drafts().length).toBeLessThan("albert revisa".length + 1); // it is not one frame per keystroke
      expect(ws.sent.map((x) => JSON.parse(x)).some((f) => f.type === "question_answer")).toBe(false);
    });

    /**
     * HALF EACH (production, 2026-11-03): Albert answered the first question, I the second — the
     * whole card had an answer, but "Responder" stayed locked because it only counted what I selected.
     * The back already merges the others' drafts into what goes to the model (`mergePeerAnswers`).
     */
    it("\"Responder\" libera quando cada pergunta tem resposta de alguém, mesmo metade minha e metade da outra pessoa", async () => {
      renderSdkChat();
      const ws = await socket();
      ws.accept();
      ws.deliver({ type: "ready" });
      ws.deliver(MULTI);
      const send = screen.getByTestId("sdk-question-send");
      ws.deliver({ type: "peer_question_draft", id: "q_peer", name: "albert", picked: [[], []], other: ["o caminhão define", ""] });
      expect(send).toBeDisabled(); // the second still without an answer from anyone

      await userEvent.click(screen.getAllByRole("button", { name: "Mussa" })[1]!);
      expect(send).toBeEnabled();
      await userEvent.click(send);
      const frame = ws.sent.map((s) => JSON.parse(s)).find((f) => f.type === "question_answer");
      // what I selected goes; the back adds Albert's part with his name
      expect(frame).toEqual({ type: "question_answer", id: "q_peer", answers: [{ selected: [] }, { selected: ["Mussa"] }] });
    });

    it("rascunho da outra pessoa que ela apagou não libera mais o \"Responder\"", async () => {
      renderSdkChat();
      const ws = await socket();
      ws.accept();
      ws.deliver({ type: "ready" });
      ws.deliver(MULTI);
      ws.deliver({ type: "peer_question_draft", id: "q_peer", name: "albert", picked: [["Albert"], []], other: ["", ""] });
      await userEvent.click(screen.getAllByRole("button", { name: "Mussa" })[1]!);
      expect(screen.getByTestId("sdk-question-send")).toBeEnabled();
      ws.deliver({ type: "peer_question_draft", id: "q_peer", name: "albert", picked: [[], []], other: ["", "  "] });
      expect(screen.getByTestId("sdk-question-send")).toBeDisabled();
    });

    it("a pergunta respondida (por quem for) tira o aviso", async () => {
      renderSdkChat();
      const ws = await socket();
      ws.accept();
      ws.deliver({ type: "ready" });
      ws.deliver(MULTI);
      ws.deliver({ type: "peer_question_draft", id: "q_peer", name: "albert", picked: [["Albert"], ["Mussa"]], other: ["", ""] });
      ws.deliver({ type: "question_result", id: "q_peer", answers: [{ selected: ["Albert"] }, { selected: ["Mussa"] }] });
      expect(screen.getByTestId("sdk-question")).toHaveAttribute("data-outcome", "answered");
      expect(screen.queryByTestId("sdk-question-peer-presence")).toBeNull();
    });

    it("cancelada porque alguém parou o turno: o cartão diz quem, não \"sem resposta\"", async () => {
      renderSdkChat();
      const ws = await socket();
      ws.accept();
      ws.deliver({ type: "ready" });
      ws.deliver(MULTI);
      ws.deliver({ type: "question_result", id: "q_peer", timedOut: false, superseded: false, cancelledBy: "albert", cancelledHow: "edit" });
      const card = screen.getByTestId("sdk-question");
      expect(card).toHaveAttribute("data-outcome", "cancelled");
      expect(card).toHaveTextContent("Albert");
      expect(card).not.toHaveTextContent(/no answer/i);
    });

    it("rascunho de outra pergunta não aparece neste cartão", async () => {
      renderSdkChat();
      const ws = await socket();
      ws.accept();
      ws.deliver({ type: "ready" });
      ws.deliver(MULTI);
      ws.deliver({ type: "peer_question_draft", id: "q_outra", name: "albert", picked: [["Albert"]], other: [""] });
      expect(screen.queryByTestId("sdk-question-peer-presence")).toBeNull();
    });
  });

  /**
   * THE RECONNECT WIPED THE CARD (production, 2026-10-07). Every connect clears the screen and the replay
   * redraws it from disk — the card unmounts and remounts, and what the person had already selected and written
   * lived in its local state. A deploy in the middle of three questions = everything again, from scratch.
   */
  it("o que foi marcado e escrito no cartão sobrevive ao reconnect", async () => {
    renderSdkChat();
    const first = await socket();
    first.accept();
    first.deliver({ type: "ready" });
    const MULTI = {
      type: "user_question" as const,
      id: "q_3_1791402112898",
      questions: [
        { question: "Onde entra a busca?", options: [{ label: "No cabeçalho" }, { label: "No item" }] },
        { question: "Como conto o prazo?", options: [{ label: "72h corridas" }] },
      ],
    };
    first.deliver(MULTI);
    await userEvent.click(screen.getByRole("button", { name: "No item" }));
    await userEvent.type(screen.getAllByTestId("sdk-question-other")[1]!, "72h pulando domingo");

    act(() => { first.readyState = 3; first.onclose?.(); }); // the deploy drops the wire
    await waitFor(() => expect(FakeSocket.instances.length).toBe(2), { timeout: RECONNECT_MAX_MS });
    const second = FakeSocket.instances[1] as FakeSocket;
    second.accept();
    second.deliver(MULTI); // the replay redraws the card from disk
    second.deliver({ type: "ready" });

    expect(screen.getByRole("button", { name: "No item" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getAllByTestId("sdk-question-other")[1]).toHaveValue("72h pulando domingo");
  });

  /**
   * THE DEPLOY RELOADS THE TAB (production, 2026-11-03): the new version makes the tab reload by itself
   * (lib/versionCheck.ts) and the module's memory dies with the F5. Four questions answered = zero.
   */
  it("o que foi marcado e escrito no cartão sobrevive ao F5 (a recarga da versão nova)", async () => {
    const view = renderSdkChat();
    const first = await socket();
    first.accept();
    first.deliver({ type: "ready" });
    const MULTI = {
      type: "user_question" as const,
      id: "q_5_1793740462180",
      questions: [
        { question: "Como marcamos o trucado?", options: [{ label: "Tipo no cadastro" }, { label: "Faixa de capacidade" }] },
        { question: "Produto sem peso?", options: [{ label: "Bloqueia o envio" }, { label: "Avisa e deixa seguir" }] },
      ],
    };
    first.deliver(MULTI);
    await userEvent.click(screen.getByRole("button", { name: "Faixa de capacidade" }));
    await userEvent.type(screen.getAllByTestId("sdk-question-other")[0]!, "pela");

    view.unmount();
    resetQuestionDraftsForTesting(); // the F5: the tab's memory is gone, localStorage stays

    renderSdkChat();
    const second = FakeSocket.instances.at(-1) as FakeSocket;
    second.accept();
    second.deliver(MULTI); // the replay redraws the card from disk
    second.deliver({ type: "ready" });

    expect(screen.getByRole("button", { name: "Faixa de capacidade" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getAllByTestId("sdk-question-other")[0]).toHaveValue("pela");
  });

  /** Finding F3 from the review of PR #98: the answer went out, the driver died before receiving it. */
  it("respondeu e o fio caiu antes da confirmação: o cartão volta pendente COM o que foi marcado", async () => {
    renderSdkChat();
    const first = await socket();
    first.accept();
    first.deliver({ type: "ready" });
    const MULTI = {
      type: "user_question" as const,
      id: "q_4_1",
      questions: [
        { question: "Onde entra a busca?", options: [{ label: "No cabeçalho" }, { label: "No item" }] },
        { question: "Como conto o prazo?", options: [{ label: "72h corridas" }] },
      ],
    };
    first.deliver(MULTI);
    await userEvent.click(screen.getByRole("button", { name: "No item" }));
    await userEvent.type(screen.getAllByTestId("sdk-question-other")[1]!, "72h pulando domingo");
    await userEvent.click(screen.getByTestId("sdk-question-send"));

    act(() => { first.readyState = 3; first.onclose?.(); }); // no question_result came back
    await waitFor(() => expect(FakeSocket.instances.length).toBe(2), { timeout: RECONNECT_MAX_MS });
    const second = FakeSocket.instances[1] as FakeSocket;
    second.accept();
    second.deliver(MULTI);
    second.deliver({ type: "ready" });

    expect(screen.getByRole("button", { name: "No item" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getAllByTestId("sdk-question-other")[1]).toHaveValue("72h pulando domingo");
  });

  it("a timed-out question replays settled as unanswered", async () => {
    renderSdkChat();
    const ws = await socket();
    ws.accept();
    ws.deliver(QUESTION);
    ws.deliver({ type: "question_result", id: "q_1", timedOut: true });
    ws.deliver({ type: "ready" });
    expect(screen.getByTestId("sdk-question")).toHaveAttribute("data-outcome", "unanswered");
    expect(screen.queryByTestId("sdk-question-send")).toBeNull();
  });
});

describe("SdkChatView — a conversa não estica a página", () => {
  it("o scroller é o bloco de contenção de tudo que é absoluto dentro dele", async () => {
    // The diff card's `sr-only` is `position: absolute`. With the scroller lacking `relative`, it
    // anchored to the outer wrapper, sat at its height in the conversation and created empty scrolling across the
    // whole page — a screen of nothing below the composer.
    renderSdkChat();
    await socket();
    expect(screen.getByTestId("sdk-chat-scroller")).toHaveClass("relative");
  });
});

describe("SdkChatView — 'ir pro fim' flutuante", () => {
  function fakeScrollMetrics(el: HTMLElement, { scrollTop = 0 } = {}) {
    Object.defineProperty(el, "scrollHeight", { configurable: true, value: 1000 });
    Object.defineProperty(el, "clientHeight", { configurable: true, value: 200 });
    let top = scrollTop;
    Object.defineProperty(el, "scrollTop", {
      configurable: true,
      get: () => top,
      set: (v: number) => { top = v; },
    });
  }

  it("appears when scrolled up, badges on a NEW message (no auto-scroll), and a click returns to the end", async () => {
    renderSdkChat();
    const ws = await socket();
    ws.accept();
    ws.deliver({ type: "ready" });
    ws.deliver({ type: "assistant_text", text: "primeira resposta" });

    // at the bottom: no button
    expect(screen.queryByTestId("jump-latest")).toBeNull();

    // the reader scrolls UP
    const scroller = screen.getByTestId("sdk-chat-scroller");
    fakeScrollMetrics(scroller, { scrollTop: 0 });
    fireEvent.scroll(scroller);
    expect(screen.getByTestId("jump-latest")).toBeInTheDocument();
    expect(screen.queryByTestId("jump-latest-new")).toBeNull();

    // a new message lands: the badge lights, the view does NOT jump
    ws.deliver({ type: "assistant_text", text: "mensagem nova" });
    expect(screen.getByTestId("jump-latest-new")).toBeInTheDocument();
    expect(scroller.scrollTop).toBe(0);

    // the click scrolls to the end and the button goes away
    const scrollTo = vi.fn(function (this: HTMLElement, opts: { top: number }) { this.scrollTop = opts.top; });
    Object.defineProperty(scroller, "scrollTo", { configurable: true, value: scrollTo });
    await userEvent.click(screen.getByTestId("jump-latest"));
    expect(scrollTo).toHaveBeenCalledWith({ top: 1000, behavior: "smooth" });
    expect(screen.queryByTestId("jump-latest")).toBeNull();
  });

  it("disappears when the reader scrolls back to the end on their own", async () => {
    renderSdkChat();
    const ws = await socket();
    ws.accept();
    ws.deliver({ type: "ready" });
    ws.deliver({ type: "assistant_text", text: "oi" });

    const scroller = screen.getByTestId("sdk-chat-scroller");
    fakeScrollMetrics(scroller, { scrollTop: 0 });
    fireEvent.scroll(scroller);
    expect(screen.getByTestId("jump-latest")).toBeInTheDocument();

    scroller.scrollTop = 900; // 1000 - 900 - 200 < 120 → at the bottom again
    fireEvent.scroll(scroller);
    expect(screen.queryByTestId("jump-latest")).toBeNull();
  });
});

describe("SdkChatView — bandeja de decisões pendentes", () => {
  const QUESTION = {
    type: "user_question" as const,
    id: "q_1",
    questions: [{ question: "Formato do relatório?", options: [{ label: "Resumo" }, { label: "Detalhado" }] }],
  };

  it("lists pending decisions (estruturada + prosa) with the count, and answering clears them", async () => {
    renderSdkChat();
    const ws = await socket();
    ws.accept();
    ws.deliver({ type: "ready" });

    // nothing pending, no tray
    expect(screen.queryByTestId("pending-tray")).toBeNull();

    ws.deliver(QUESTION);
    ws.deliver({ type: "assistant_text", text: "Além disso:\n\nQual banco você prefere?" });

    expect(screen.getByTestId("pending-tray")).toBeInTheDocument();
    expect(screen.getByTestId("pending-tray-count")).toHaveTextContent("2");
    const items = screen.getAllByTestId("pending-tray-item");
    expect(items[0]).toHaveTextContent("Formato do relatório?");
    expect(items[1]).toHaveTextContent("Qual banco você prefere?");

    // a plain user message deals with the PROSE one…
    ws.deliver({ type: "user", text: "postgres", from: { kind: "user", name: "alex" } });
    expect(screen.getByTestId("pending-tray-count")).toHaveTextContent("1");

    // …and answering the structured one empties (and removes) the tray
    await userEvent.click(screen.getByRole("button", { name: "Resumo" }));
    expect(screen.queryByTestId("pending-tray")).toBeNull();
  });

  it("clicking an item scrolls to the message, flashes it and focuses the composer", async () => {
    const scrolled = vi.fn();
    Element.prototype.scrollIntoView = scrolled;
    renderSdkChat();
    const ws = await socket();
    ws.accept();
    ws.deliver({ type: "ready" });
    ws.deliver(QUESTION);

    await userEvent.click(screen.getByTestId("pending-tray-item"));
    expect(scrolled).toHaveBeenCalledWith({ behavior: "smooth", block: "center" });
    const flashed = document.querySelector("[data-flash]");
    expect(flashed).not.toBeNull();
    expect(flashed!.textContent).toContain("Formato do relatório?");
    expect(document.activeElement?.tagName).toBe("TEXTAREA");
  });

  it("REPLAY: a pending question replayed before `ready` fills the tray (sobrevive F5)", async () => {
    renderSdkChat();
    const ws = await socket();
    ws.accept();
    ws.deliver(QUESTION); // replayed history, before ready
    ws.deliver({ type: "ready", turnActive: true });
    expect(screen.getByTestId("pending-tray-count")).toHaveTextContent("1");

    // a replayed ANSWERED pair never shows a tray
    ws.deliver({ type: "question_result", id: "q_1", answers: [{ selected: ["Resumo"] }] });
    expect(screen.queryByTestId("pending-tray")).toBeNull();
  });

  it("highlights a final prose question inside the assistant message", async () => {
    renderSdkChat();
    const ws = await socket();
    ws.accept();
    ws.deliver({ type: "ready" });
    ws.deliver({ type: "assistant_text", text: "Fiz A e B.\n\nQual dos dois você prefere?" });

    const highlight = screen.getByTestId("sdk-prose-question");
    expect(highlight).toHaveTextContent("Qual dos dois você prefere?");
    // the body stays outside the highlight
    expect(highlight).not.toHaveTextContent("Fiz A e B.");

    // an undirected message gets no highlight
    ws.deliver({ type: "assistant_text", text: "Tudo verde. Faz sentido?" });
    expect(screen.getAllByTestId("sdk-prose-question")).toHaveLength(1);
  });
});

describe("SdkChatView — editar mensagem enviada (supersede)", () => {
  async function textbox(): Promise<HTMLTextAreaElement> {
    return (await screen.findByLabelText(/Enter/)) as HTMLTextAreaElement;
  }

  it("the pencil puts the original in the composer; Enter sends ONE edit_user frame and settles the rows", async () => {
    renderSdkChat();
    const ws = await socket();
    ws.accept();
    ws.deliver({ type: "ready" });
    ws.deliver({ type: "user", text: "sobe pra prod" }); // replayed own message (no from = self)

    await userEvent.click(screen.getByTestId("sdk-edit"));
    expect(screen.getByTestId("composer-editing")).toBeInTheDocument();
    const box = await textbox();
    expect(box.value).toBe("sobe pra prod");

    await userEvent.clear(box);
    await userEvent.type(box, "sobe pra dev{Enter}");

    await waitFor(() => expect(ws.sent.length).toBe(1));
    expect(JSON.parse(ws.sent[0]!)).toMatchObject({ type: "edit_user", original: "sobe pra prod", text: "sobe pra dev" });
    // the bubble CHANGES: one bubble, the new words, with the badge — no greyed copy above it
    const bubbles = screen.getAllByTestId("sdk-user");
    expect(bubbles).toHaveLength(1);
    expect(bubbles[0]).toHaveTextContent("sobe pra dev");
    expect(bubbles[0]).toHaveAttribute("data-revision", "true");
    expect(screen.getByTestId("sdk-user-edited")).toHaveTextContent(/editada|edited/);
    expect(screen.queryByText("sobe pra prod")).not.toBeInTheDocument();
    expect(screen.queryByTestId("composer-editing")).not.toBeInTheDocument();
  });

  /**
   * CÉSAR'S REQUEST (2026-09-28): "I click edit, change my mind, and the turn got interrupted".
   *
   * The pencil opened the field AND KILLED the turn on the spot — before a single character of the new
   * version existed. But clicking edit is not a decision: it is opening the possibility of one. Whoever
   * gave up asked for nothing, and a cut turn cannot be uncut — the screen kept offering
   * "continue where it left off" to fix damage it had done itself, and the history
   * gained a note explaining an interruption nobody wanted.
   *
   * The rule now: what stops the turn is the SENT CORRECTION, never the gesture of opening the field. The price
   * is known and is the smaller of the two: between the pencil and Enter the agent keeps working on the
   * old message. Extra work is recoverable; a turn killed by mistake is not.
   */
  it("o lápis MID-TURN não para o turno — abrir o campo não é uma decisão", async () => {
    renderSdkChat();
    const ws = await socket();
    ws.accept();
    ws.deliver({ type: "ready" });

    const box = await textbox();
    await userEvent.type(box, "sobe pra prod{Enter}");
    await waitFor(() => expect(ws.sent.length).toBe(1));
    ws.deliver({ type: "assistant_delta", text: "Subindo…" }); // the turn is visibly running

    await userEvent.click(screen.getByTestId("sdk-edit"));

    expect(ws.sent.length).toBe(1); // nothing went out besides the message itself: no interrupt
    expect(screen.getByTestId("composer-editing")).toBeInTheDocument(); // the field opened
    expect(screen.getByTestId("sdk-chat-working")).toBeInTheDocument(); // and the turn is still standing
  });

  it("clicar em editar e DESISTIR não interrompe nada — não há estrago, nem o que continuar", async () => {
    renderSdkChat();
    const ws = await socket();
    ws.accept();
    ws.deliver({ type: "ready" });

    const box = await textbox();
    await userEvent.type(box, "sobe pra prod{Enter}");
    await waitFor(() => expect(ws.sent.length).toBe(1));
    ws.deliver({ type: "assistant_delta", text: "Subindo…" });
    await userEvent.click(screen.getByTestId("sdk-edit"));

    fireEvent.keyDown(box, { key: "Escape" }); // changed my mind

    expect(ws.sent.length).toBe(1); // the turn was never touched
    expect(screen.getByTestId("sdk-chat-working")).toBeInTheDocument(); // and keeps running
    expect(screen.queryByTestId("composer-editing")).not.toBeInTheDocument();
    // …and no "continue" offer is left over: there was nothing to interrupt.
    expect(screen.queryByTestId("sdk-interrupted-banner")).toBeNull();
  });

  it("é a correção ENVIADA que para o turno — e ela só vai depois do result da interrupção", async () => {
    renderSdkChat();
    const ws = await socket();
    ws.accept();
    ws.deliver({ type: "ready" });

    const box = await textbox();
    await userEvent.type(box, "sobe pra prod{Enter}");
    await waitFor(() => expect(ws.sent.length).toBe(1));
    ws.deliver({ type: "assistant_delta", text: "Subindo…" });

    await userEvent.click(screen.getByTestId("sdk-edit"));
    await userEvent.clear(box);
    await userEvent.type(box, "sobe pra dev{Enter}");

    // NOW yes: the decision was made, and it stops the turn answering the superseded message.
    await waitFor(() => expect(ws.sent.length).toBe(2));
    expect(JSON.parse(ws.sent[1]!)).toEqual({ type: "interrupt", reason: "edit" });

    ws.deliver({ type: "result", isError: false, subtype: "aborted" });
    await waitFor(() => expect(ws.sent.length).toBe(3));
    expect(JSON.parse(ws.sent[2]!)).toMatchObject({ type: "edit_user", original: "sobe pra prod", text: "sobe pra dev" });
    // the correction replaced the interrupted turn: no offer to continue the old one
    expect(screen.queryByTestId("sdk-interrupted-banner")).toBeNull();
  });

  it("editing with NO turn running touches nothing — no stop, no offer", async () => {
    renderSdkChat();
    const ws = await socket();
    ws.accept();
    ws.deliver({ type: "ready" });
    ws.deliver({ type: "user", text: "sobe pra prod" });

    await userEvent.click(screen.getByTestId("sdk-edit"));
    expect(ws.sent.length).toBe(0);
    fireEvent.keyDown(await textbox(), { key: "Escape" });
    expect(screen.queryByTestId("sdk-interrupted-banner")).toBeNull();
  });

  it("Esc cancels the edit and brings the interrupted draft back", async () => {
    renderSdkChat();
    const ws = await socket();
    ws.accept();
    ws.deliver({ type: "ready" });
    ws.deliver({ type: "user", text: "sobe pra prod" });

    const box = await textbox();
    await userEvent.type(box, "rascunho em progresso");
    await userEvent.click(screen.getByTestId("sdk-edit"));
    await waitFor(() => expect(box.value).toBe("sobe pra prod"));

    fireEvent.keyDown(box, { key: "Escape" });
    expect(box.value).toBe("rascunho em progresso");
    expect(screen.queryByTestId("composer-editing")).not.toBeInTheDocument();
    expect(ws.sent.length).toBe(0); // nothing went anywhere
  });

  it("Esc on an EMPTY field steps into editing the last message of one's own (terminal parity)", async () => {
    renderSdkChat();
    const ws = await socket();
    ws.accept();
    ws.deliver({ type: "ready" });
    ws.deliver({ type: "user", text: "primeira" });
    ws.deliver({ type: "user", text: "última" });

    const box = await textbox();
    await userEvent.clear(box); // a draft restored from another test's storage is not "empty"
    fireEvent.keyDown(box, { key: "Escape" });
    await waitFor(() => expect(screen.getByTestId("composer-editing")).toBeInTheDocument());
    expect(box.value).toBe("última");
  });

  it("a REPLAYED message_edited settles the original as editada (persistence across F5)", async () => {
    renderSdkChat();
    const ws = await socket();
    ws.accept();
    ws.deliver({ type: "user", text: "sobe pra prod" });
    ws.deliver({ type: "message_edited", originalText: "sobe pra prod" });
    ws.deliver({ type: "user", text: "sobe pra dev" });
    ws.deliver({ type: "ready" });

    // after an F5 too: only the standing version, badged — the superseded one is not drawn
    const bubbles = screen.getAllByTestId("sdk-user");
    expect(bubbles).toHaveLength(1);
    expect(bubbles[0]).toHaveTextContent("sobe pra dev");
    expect(bubbles[0]).toHaveAttribute("data-revision", "true");
    expect(screen.getAllByTestId("sdk-edit")).toHaveLength(1);
  });

  it("a supersede the driver could NOT rewind still shows ONE bubble (the reported screen)", async () => {
    renderSdkChat();
    const ws = await socket();
    ws.accept();
    ws.deliver({ type: "ready" });
    ws.deliver({ type: "user", text: "seja mais claro" });
    ws.deliver({ type: "result", isError: true, subtype: "error_during_execution", result: "No conversation found" });

    await userEvent.click(screen.getByTestId("sdk-edit"));
    const box = await textbox();
    await userEvent.clear(box);
    await userEvent.type(box, "seja mais claro, por favor{Enter}");
    await waitFor(() => expect(ws.sent.length).toBe(1));
    ws.deliver({ type: "rewound", ok: false, reason: "no-fork-point" });

    const bubbles = screen.getAllByTestId("sdk-user");
    expect(bubbles).toHaveLength(1);
    expect(bubbles[0]).toHaveTextContent("seja mais claro, por favor");
  });

  it("only the edit's new version carries the badge — a later message does not", async () => {
    renderSdkChat();
    const ws = await socket();
    ws.accept();
    ws.deliver({ type: "user", text: "a" });
    ws.deliver({ type: "message_edited", originalText: "a" });
    ws.deliver({ type: "user", text: "b" });
    ws.deliver({ type: "user", text: "c" });
    ws.deliver({ type: "ready" });

    const bubbles = screen.getAllByTestId("sdk-user");
    expect(bubbles.map((b) => b.textContent)).toEqual([expect.stringContaining("b"), "c"]);
    expect(bubbles[0]).toHaveAttribute("data-revision", "true");
    expect(bubbles[1]).not.toHaveAttribute("data-revision");
  });
});

describe("SdkChatView — mensagem dobrada no turno por OUTRO remetente (turn_absorbed)", () => {
  /**
   * The field itself no longer folds anything into a running turn — what it writes WAITS in the queue (see the
   * "fila" block). But folding still exists for whoever sends from outside (the maestro, the MCP, another
   * tab): the bubble goes up in the conversation, WITHOUT a label. Whoever is on the screen sees the message enter the turn
   * in progress; the written "entrou no turno em andamento" only repeated what was already in sight.
   */
  it("shows the folded bubble WITHOUT an 'entrou no turno em andamento' label", async () => {
    renderSdkChat();
    const ws = await socket();
    ws.accept();
    ws.deliver({ type: "ready" });

    const box = (await screen.findByLabelText(/Enter/)) as HTMLTextAreaElement;
    await userEvent.type(box, "faz a tarefa{Enter}");
    await waitFor(() => expect(ws.sent.length).toBe(1));
    ws.deliver({ type: "assistant_delta", text: "Fazendo…" }); // the turn is visibly running

    // another source sent mid-turn, and the driver folded it into the turn already running
    ws.deliver({ type: "user", text: "aproveita e ajusta o título", from: { kind: "agent", name: "maestro" } });
    ws.deliver({ type: "turn_absorbed" });

    const bubbles = await screen.findAllByTestId("sdk-user");
    expect(bubbles[1]).toHaveTextContent("aproveita e ajusta o título");
    expect(screen.queryByTestId("sdk-user-absorbed")).toBeNull();
    expect(screen.queryByText(/entrou no turno em andamento|joined the running turn/)).toBeNull();
  });
});

describe("SdkChatView — escada de estados (Preparando → Pensando → Respondendo)", () => {
  it("cold driver: the send WAITS in the queue, ready sends it as Pensando…, the first token is Respondendo…", async () => {
    renderSdkChat();
    const ws = await socket();
    ws.accept(); // socket open, driver still booting (no ready yet)

    const box = (await screen.findByLabelText(/Enter/)) as HTMLTextAreaElement;
    await userEvent.type(box, "oi{Enter}");
    // The back would only keep the frame in a buffer that an F5 throws away: the queue is what survives.
    expect(ws.sent).toHaveLength(0);
    expect(screen.getByTestId("sdk-queued")).toHaveTextContent("oi");

    ws.deliver({ type: "ready" });
    await waitFor(() => expect(ws.sent.length).toBe(1));
    expect(screen.getByTestId("sdk-chat-working")).toHaveAttribute("data-phase", "thinking");

    // The first token ALREADY IS the answer being written — the indicator says so, instead of the
    // generic "Trabalhando…" that did not tell thinking apart from answering.
    ws.deliver({ type: "assistant_delta", text: "olá" });
    expect(screen.getByTestId("sdk-chat-working")).toHaveAttribute("data-phase", "answering");

    ws.deliver({ type: "result", isError: false });
    expect(screen.queryByTestId("sdk-chat-working")).not.toBeInTheDocument();
  });

  /**
   * What César lacked: visual feedback. "Trabalhando…" is the same word at second 2 and at
   * minute 9 — the indicator now carries the clock and the status note, and it ESCALATES.
   */
  it("carrega o relógio e a nota de estado, e a nota escala com o tempo", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      renderSdkChat();
      const ws = await socket();
      ws.accept();
      ws.deliver({ type: "ready" });

      const box = (await screen.findByLabelText(/Enter/)) as HTMLTextAreaElement;
      await userEvent.type(box, "oi{Enter}");
      await waitFor(() => expect(ws.sent.length).toBe(1));

      // The server confirms receipt, otherwise the outbox declares the message undelivered in the middle
      // of the clock and the indicator disappears — what this test measures is the live turn, not the outbox.
      const cid = (JSON.parse(ws.sent[0]!) as { cid: string }).cid;
      ws.deliver({ type: "user_ack", cid });

      const note = await screen.findByTestId("sdk-working-note");
      expect(note).toHaveTextContent(/0s/);
      expect(note).toHaveTextContent(/pensando|thinking/);

      // After 30s the same turn starts saying it is STILL at it.
      await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
      expect(screen.getByTestId("sdk-working-note")).toHaveTextContent(/30s/);
      expect(screen.getByTestId("sdk-working-note")).toHaveTextContent(/ainda pensando|still thinking/);
    } finally {
      vi.useRealTimers();
    }
  });

  it("warm driver: the send goes straight to Pensando… (one indicator, never stacked)", async () => {
    renderSdkChat();
    const ws = await socket();
    ws.accept();
    ws.deliver({ type: "ready" });

    const box = (await screen.findByLabelText(/Enter/)) as HTMLTextAreaElement;
    await userEvent.type(box, "oi{Enter}");
    await waitFor(() => expect(ws.sent.length).toBe(1));

    const indicators = screen.getAllByTestId("sdk-chat-working");
    expect(indicators).toHaveLength(1);
    expect(indicators[0]).toHaveAttribute("data-phase", "thinking");
  });
});

/* ------------------------------------------------- answering a decision */

describe("SdkChatView — responder A decisão (não um recado solto)", () => {
  const QUESTION = {
    type: "user_question" as const,
    id: "q_1",
    questions: [{ question: "Formato do relatório?", options: [{ label: "Resumo" }, { label: "Detalhado" }] }],
  };

  async function chatWithProseQuestion() {
    renderSdkChat();
    const ws = await socket();
    ws.accept();
    ws.deliver({ type: "ready" });
    ws.deliver({ type: "assistant_text", text: "Fiz A e B.\n\nQual dos dois você prefere?" });
    // The question CLOSES the turn — that is what makes Claude sit waiting. Without this the chat thinks it
    // still has work running and a loose note would go to the QUEUE, which is another test.
    ws.deliver({ type: "result", isError: false });
    return ws;
  }

  it("a bandeja aponta o composer PRA decisão: o banner mostra a pergunta e o envio vai ancorado nela", async () => {
    const ws = await chatWithProseQuestion();
    expect(screen.queryByTestId("sdk-reply-banner")).toBeNull();

    await userEvent.click(screen.getByTestId("pending-tray-item"));
    const banner = screen.getByTestId("sdk-reply-banner");
    expect(banner).toHaveTextContent("Qual dos dois você prefere?");
    expect(screen.getByTestId("pending-tray-item")).toHaveAttribute("data-active", "true");

    await userEvent.type(screen.getByRole("textbox"), "o B{Enter}");
    await waitFor(() => expect(ws.sent.length).toBe(1));
    const frame = JSON.parse(ws.sent[0]!);
    expect(frame.type).toBe("user");
    // what reaches the MODEL quotes the question — "o B" alone would be a riddle two turns later
    expect(frame.text).toContain("Qual dos dois você prefere?");
    expect(frame.text).toContain("o B");

    // …the aim is released, the tray is empty and the answer is anchored to its question
    expect(screen.queryByTestId("sdk-reply-banner")).toBeNull();
    expect(screen.queryByTestId("pending-tray")).toBeNull();
    expect(screen.getByTestId("sdk-prose-question")).toHaveAttribute("data-answered", "true");
    expect(screen.getByTestId("sdk-prose-answered")).toHaveTextContent("o B");
    // and the bubble reads as an answer, not as a loose message
    expect(screen.getByTestId("sdk-user-reply")).toHaveTextContent("Qual dos dois você prefere?");
    expect(screen.getByTestId("sdk-user")).toHaveTextContent("o B");
  });

  it("o botão 'Responder' na própria pergunta arma o mesmo alvo", async () => {
    await chatWithProseQuestion();
    await userEvent.click(screen.getByTestId("sdk-prose-reply"));
    expect(screen.getByTestId("sdk-reply-banner")).toHaveTextContent("Qual dos dois você prefere?");
  });

  it("o X SAI da resposta: a mesma frase vira recado solto", async () => {
    const ws = await chatWithProseQuestion();
    await userEvent.click(screen.getByTestId("pending-tray-item"));
    await userEvent.click(screen.getByTestId("sdk-reply-cancel"));
    expect(screen.queryByTestId("sdk-reply-banner")).toBeNull();

    await userEvent.type(screen.getByRole("textbox"), "depois eu penso{Enter}");
    await waitFor(() => expect(ws.sent.length).toBe(1));
    expect(JSON.parse(ws.sent[0]!)).toMatchObject({ type: "user", text: "depois eu penso" });
    expect(screen.queryByTestId("sdk-user-reply")).toBeNull();
  });

  it("REPLAY: a resposta continua ancorada na pergunta depois do F5", async () => {
    renderSdkChat();
    const ws = await socket();
    ws.accept();
    // exactly what the history replays: the question, then the wrapped answer
    ws.deliver({ type: "assistant_text", text: "Fiz A e B.\n\nQual dos dois você prefere?" });
    ws.deliver({
      type: "user",
      text: "[resposta à decisão pendente:\n«Qual dos dois você prefere?»]\n\no B",
      from: { kind: "user", name: "alex" },
    });
    ws.deliver({ type: "ready" });

    expect(screen.getByTestId("sdk-prose-answered")).toHaveTextContent("o B");
    expect(screen.getByTestId("sdk-user-reply")).toHaveTextContent("Qual dos dois você prefere?");
  });

  it("decisão ESTRUTURADA: o que se digita responde a pergunta (vai como question_answer)", async () => {
    renderSdkChat();
    const ws = await socket();
    ws.accept();
    ws.deliver({ type: "ready" });
    ws.deliver(QUESTION);

    await userEvent.click(screen.getByTestId("pending-tray-item"));
    expect(screen.getByTestId("sdk-reply-banner")).toHaveTextContent("Formato do relatório?");

    const composer = screen.getByTestId("terminal-composer").querySelector("textarea")!;
    await userEvent.type(composer, "em tabela, por filial{Enter}");
    const frame = ws.sent.map((s) => JSON.parse(s)).find((f) => f.type === "question_answer");
    expect(frame).toEqual({ type: "question_answer", id: "q_1", answers: [{ selected: ["em tabela, por filial"] }] });
    // the card itself says what it got — nothing to guess
    expect(screen.getByTestId("sdk-question")).toHaveAttribute("data-outcome", "answered");
    expect(screen.getByTestId("sdk-question")).toHaveTextContent("em tabela, por filial");
    expect(screen.queryByTestId("sdk-reply-banner")).toBeNull();
  });

  it("OUTRA ABA respondeu: o alvo cai e o aviso aparece (o Enter seguinte não vira resposta muda)", async () => {
    const { toast } = await import("sonner");
    renderSdkChat();
    const ws = await socket();
    ws.accept();
    ws.deliver({ type: "ready" });
    ws.deliver(QUESTION);
    await userEvent.click(screen.getByTestId("pending-tray-item"));
    expect(screen.getByTestId("sdk-reply-banner")).toBeInTheDocument();

    // the driver echoes the answer someone else clicked
    ws.deliver({ type: "question_result", id: "q_1", answers: [{ selected: ["Resumo"] }] });
    await waitFor(() => expect(screen.queryByTestId("sdk-reply-banner")).toBeNull());
    expect(toast.message).toHaveBeenCalled();
  });

  it("VÁRIAS pendentes: o banner diz em qual você está, e clicar na outra troca o alvo", async () => {
    renderSdkChat();
    const ws = await socket();
    ws.accept();
    ws.deliver({ type: "ready" });
    ws.deliver(QUESTION);
    ws.deliver({ type: "assistant_text", text: "Além disso:\n\nQual banco você prefere?" });

    const items = screen.getAllByTestId("pending-tray-item");
    await userEvent.click(items[0]!);
    expect(screen.getByTestId("sdk-reply-banner")).toHaveTextContent("Formato do relatório?");
    await userEvent.click(screen.getAllByTestId("pending-tray-item")[1]!);
    expect(screen.getByTestId("sdk-reply-banner")).toHaveTextContent("Qual banco você prefere?");
  });

  it("card com VÁRIAS perguntas: a bandeja leva até ele, mas não arma o composer", async () => {
    renderSdkChat();
    const ws = await socket();
    ws.accept();
    ws.deliver({ type: "ready" });
    ws.deliver({
      type: "user_question",
      id: "q_9",
      questions: [
        { question: "Formato?", options: [{ label: "Resumo" }] },
        { question: "Idioma?", options: [{ label: "pt-BR" }] },
      ],
    });

    await userEvent.click(screen.getByTestId("pending-tray-item"));
    expect(screen.queryByTestId("sdk-reply-banner")).toBeNull();
  });

  it("o AGENTE seguiu sozinho: a pergunta antiga sai da bandeja e o alvo cai junto", async () => {
    const ws = await chatWithProseQuestion();
    await userEvent.click(screen.getByTestId("pending-tray-item"));
    expect(screen.getByTestId("sdk-reply-banner")).toBeInTheDocument();

    ws.deliver({ type: "assistant_text", text: "Fui de A e já terminei." });
    await waitFor(() => expect(screen.queryByTestId("pending-tray")).toBeNull());
    expect(screen.queryByTestId("sdk-reply-banner")).toBeNull();
    // and the stale question stops offering "Responder" — it would arm a dead target
    expect(screen.queryByTestId("sdk-prose-reply")).toBeNull();
  });
});

/**
 * CÉSAR'S BUG (production, 2026-09-17, three times on the same day): "I write a long instruction,
 * press Enter, the chat goes into a loading loop — sometimes for hours. If I press F5, or open the
 * same conversation on another computer, the message simply is not there, as if I had never
 * sent it. I copy the text, send it again, and then it works."
 *
 * Two causes, the two sides of the same hole: (1) on the server, the idle sweep hibernated the card the
 * person was using — killing the driver — and the next message was written to a dead stdin
 * inside a `try {} catch {}`, recorded in the history and answered by no one; (2) here, the bubble
 * was drawn because `socket.send()` did not complain, and a half-open socket accepts `send()` into the
 * void — with no receipt from the server and no copy on disk, the F5 erased the only witness.
 *
 * What these tests pin down is the browser side: EVERY message goes out with a receipt, and without a receipt it
 * shows up flagged (with the full text, resendable) instead of spinning forever.
 */
describe("SdkChatView — recibo de entrega (a mensagem que sumia no F5)", () => {
  beforeEach(() => localStorage.clear());

  it("o socket aceitou mas o servidor nunca confirmou: a bolha admite 'não entregue' e oferece reenviar", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      renderSdkChat();
      const ws = await socket();
      ws.accept();
      ws.deliver({ type: "ready" });
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      await user.type(screen.getByRole("textbox"), "instrução longa{Enter}");
      await waitFor(() => expect(ws.sent.length).toBe(1));
      // Before the deadline it is honest to say "sending" — the server may just be slow.
      expect(screen.getByTestId("sdk-user")).toHaveAttribute("data-state", "sending");

      await act(async () => { await vi.advanceTimersByTimeAsync(OUTBOX_ACK_TIMEOUT_MS + OUTBOX_TICK_MS); });

      expect(screen.getByTestId("sdk-user")).toHaveAttribute("data-state", "undelivered");
      expect(screen.getByTestId("sdk-user-undelivered")).toBeInTheDocument();
      expect(screen.getByTestId("sdk-user")).toHaveTextContent("instrução longa");
      // …and the socket that swallowed the message is dropped: only the reconnect reveals whether it was alive.
      expect(ws.readyState).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * ALBERT'S BUG (production, 2026-11-06): the message stayed "não entregue", Reenviar returned the
   * generic "Sem conexão — a mensagem não foi enviada. Ela fica no campo." and it only went out by itself a
   * minute later. The watchdog drops the socket with `close()`, but a half-open socket does not finish
   * closing: the browser waits for the closing handshake (in Chrome, up to 60s) and only then
   * fires `onclose` — which is what schedules the reconnect. During that minute the wire was neither OPEN nor
   * coming back, and every click fell into the error. (`FakeSocket.close()` is exactly that: it does not call
   * `onclose`.)
   */
  it("o watchdog condena o socket e reconecta JÁ, sem esperar o navegador terminar de fechá-lo", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      renderSdkChat();
      const ws = await socket();
      ws.accept();
      ws.deliver({ type: "ready" });
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      await user.type(screen.getByRole("textbox"), "instrução longa{Enter}");
      await waitFor(() => expect(ws.sent.length).toBe(1));
      // The handler the browser would call when the condemned socket finished closing.
      const lateClose = ws.onclose;

      await act(async () => { await vi.advanceTimersByTimeAsync(OUTBOX_ACK_TIMEOUT_MS + OUTBOX_TICK_MS); });
      expect(screen.getByTestId("sdk-user")).toHaveAttribute("data-state", "undelivered");
      // The condemned socket no longer talks to the screen: the handlers left along with it.
      expect(ws.onclose).toBeNull();
      expect(ws.onmessage).toBeNull();
      // Only the backoff time of the first attempt — never the minute of the closing handshake.
      await act(async () => { await vi.advanceTimersByTimeAsync(RECONNECT_MAX_MS); });
      expect(FakeSocket.instances).toHaveLength(2);

      const fresh = FakeSocket.instances[1]!;
      fresh.accept();
      fresh.deliver({ type: "ready" });
      // The new connection is good: the resend goes out through it and the server confirms.
      await waitFor(() => expect(fresh.sent).toHaveLength(1));
      fresh.deliver({ type: "user_ack", cid: (JSON.parse(fresh.sent[0]!) as { cid: string }).cid } as SdkEvent);
      fresh.deliver({ type: "result", subtype: "success" } as SdkEvent);
      // Even if the late close of the condemned one arrived, it does not drop the new connection: the screen
      // still knows it is online, and what is written goes out through it right away (it does not stay in the queue).
      act(() => { lateClose?.(); });
      await act(async () => { await vi.advanceTimersByTimeAsync(RECONNECT_MAX_MS); });
      expect(FakeSocket.instances).toHaveLength(2);
      const before = fresh.sent.length;
      await user.type(screen.getByRole("textbox"), "segue o baile{Enter}");
      await waitFor(() => expect(fresh.sent.slice(before).some((raw) => raw.includes("segue o baile"))).toBe(true));
    } finally {
      vi.useRealTimers();
    }
  });

  it("Reenviar com o fio caído não dá erro: a mensagem sai sozinha assim que o chat volta", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const { toast } = await import("sonner");
      renderSdkChat();
      const ws = await socket();
      ws.accept();
      ws.deliver({ type: "ready" });
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      await user.type(screen.getByRole("textbox"), "instrução longa{Enter}");
      await waitFor(() => expect(ws.sent.length).toBe(1));
      const cid = (JSON.parse(ws.sent[0]!) as { cid: string }).cid;
      await act(async () => { await vi.advanceTimersByTimeAsync(OUTBOX_ACK_TIMEOUT_MS + OUTBOX_TICK_MS); });

      // The wire has not come back yet (the reconnect is in backoff or in setup): the click is a request.
      await user.click(screen.getByTestId("sdk-user-resend"));
      expect(toast.error).not.toHaveBeenCalled();

      await act(async () => { await vi.advanceTimersByTimeAsync(RECONNECT_MAX_MS); });
      const fresh = FakeSocket.instances.at(-1)!;
      expect(fresh).not.toBe(ws);
      fresh.accept();
      fresh.deliver({ type: "ready" });

      // At the moment of `ready`, without waiting for the automatic resend's interval — the person already asked.
      await waitFor(() => expect(fresh.sent).toHaveLength(1));
      expect(JSON.parse(fresh.sent[0]!)).toMatchObject({ type: "user", text: "instrução longa", cid });
      expect(screen.getByTestId("sdk-user")).toHaveAttribute("data-state", "sending");
    } finally {
      vi.useRealTimers();
    }
  });

  it("user_ack: o servidor gravou — a bolha vira 'sent' e o navegador esquece a cópia", async () => {
    renderSdkChat();
    const ws = await socket();
    ws.accept();
    ws.deliver({ type: "ready" });
    await userEvent.type(screen.getByRole("textbox"), "roda os testes{Enter}");
    await waitFor(() => expect(ws.sent.length).toBe(1));
    const cid = (JSON.parse(ws.sent[0]!) as { cid: string }).cid;

    ws.deliver({ type: "user_ack", cid } as SdkEvent);

    await waitFor(() => expect(screen.getByTestId("sdk-user")).toHaveAttribute("data-state", "sent"));
    expect(localStorage.getItem("vibehub.sdkOutbox.c1")).toBeNull();
  });

  it("user_nack (o driver do card tinha morrido): marca na hora, sem esperar prazo nenhum", async () => {
    renderSdkChat();
    const ws = await socket();
    ws.accept();
    ws.deliver({ type: "ready" });
    await userEvent.type(screen.getByRole("textbox"), "instrução longa{Enter}");
    await waitFor(() => expect(ws.sent.length).toBe(1));
    const cid = (JSON.parse(ws.sent[0]!) as { cid: string }).cid;

    ws.deliver({ type: "user_nack", cid, reason: "driver-gone" } as SdkEvent);

    await waitFor(() => expect(screen.getByTestId("sdk-user")).toHaveAttribute("data-state", "undelivered"));
    // The spinner STOPS promising work nobody received (it was what "kept loading").
    expect(screen.queryByTestId("sdk-chat-working")).not.toBeInTheDocument();
  });

  it("F5 com mensagem não confirmada: ela volta pra fila e sai sozinha quando o chat carrega", async () => {
    // What the previous browser left on disk, with no receipt and no verdict.
    localStorage.setItem(
      "vibehub.sdkOutbox.c1",
      JSON.stringify([{ cid: "c-antigo", text: "a instrução longa que sumia", at: Date.now() }]),
    );
    renderSdkChat();
    const ws = await socket();
    ws.accept();
    ws.deliver({ type: "ready" }); // the server's replay does not bring the message — it never received it

    await waitFor(() => expect(ws.sent).toHaveLength(1));
    expect(JSON.parse(ws.sent[0]!)).toMatchObject({ type: "user", text: "a instrução longa que sumia" });
    const bubble = screen.getByTestId("sdk-user");
    expect(bubble).toHaveTextContent("a instrução longa que sumia");
    expect(bubble).toHaveAttribute("data-state", "sending");
    expect(screen.queryByTestId("sdk-user-undelivered")).not.toBeInTheDocument();
  });

  it("F5 com mensagem que JÁ levou veredito (recusa/prazo): volta marcada, com reenviar — sem laço", async () => {
    localStorage.setItem(
      "vibehub.sdkOutbox.c1",
      JSON.stringify([{ cid: "c-antigo", text: "a instrução recusada", at: Date.now(), undelivered: true }]),
    );
    renderSdkChat();
    const ws = await socket();
    ws.accept();
    ws.deliver({ type: "ready" });

    const bubble = await screen.findByTestId("sdk-user");
    expect(bubble).toHaveTextContent("a instrução recusada");
    expect(bubble).toHaveAttribute("data-state", "undelivered");
    // Nothing right away: the automatic resend waits for its interval (see "o reenvio automático").
    expect(ws.sent).toHaveLength(0);
  });

  it("F5 quando a mensagem TINHA sido gravada: o replay manda, a bolha é normal e não duplica", async () => {
    localStorage.setItem(
      "vibehub.sdkOutbox.c1",
      JSON.stringify([{ cid: "c-antigo", text: "essa chegou", at: Date.now() }]),
    );
    renderSdkChat();
    const ws = await socket();
    ws.accept();
    ws.deliver({ type: "user", text: "essa chegou" }); // came from the server's history
    ws.deliver({ type: "ready" });

    await waitFor(() => expect(screen.getAllByTestId("sdk-user")).toHaveLength(1));
    expect(screen.getByTestId("sdk-user")).toHaveAttribute("data-state", "sent");
    expect(screen.queryByTestId("sdk-user-undelivered")).not.toBeInTheDocument();
    await waitFor(() => expect(localStorage.getItem("vibehub.sdkOutbox.c1")).toBeNull());
  });

  it("o 'sim' de ANTES no replay não dá por entregue o 'sim' que se perdeu agora", async () => {
    renderSdkChat();
    const first = await socket();
    first.accept();
    first.deliver({ type: "user", text: "sim" }); // the conversation already had a "sim" (the history)
    first.deliver({ type: "ready" });
    await userEvent.type(screen.getByRole("textbox"), "sim{Enter}");
    await waitFor(() => expect(first.sent.length).toBe(1));
    // the half-open socket swallowed the send: no receipt, and the wire drops
    act(() => { first.readyState = 3; first.onclose?.(); });

    await waitFor(() => expect(FakeSocket.instances.length).toBe(2));
    const second = FakeSocket.instances[1] as FakeSocket;
    second.accept();
    second.deliver({ type: "user", text: "sim" }); // the server only has the "sim" from before
    second.deliver({ type: "ready" });

    // the "sim" from now GOES OUT AGAIN, by itself — instead of vanishing as if it had arrived
    await waitFor(() => expect(second.sent).toHaveLength(1));
    expect(JSON.parse(second.sent[0]!)).toMatchObject({ type: "user", text: "sim" });
    expect(screen.getAllByTestId("sdk-user")).toHaveLength(2);
    expect(screen.getAllByTestId("sdk-user")[1]).toHaveAttribute("data-state", "sending");
    expect(localStorage.getItem("vibehub.sdkOutbox.c1")).toContain("sim");
  });

  /**
   * THE LONG CONVERSATION. The replay is a WINDOW (the last few hundred events of the history), and it moves:
   * six "ok" on screen at send time, and on reconnect only the two most recent still fit — plus the new
   * "ok". Counting "how many 'ok' there were" on the whole screen gave 6 against 3 in the replay: the DELIVERED message
   * came back "não entregue", and Reenviar duplicated the turn. The replay carries the server's `at` on
   * each message: what proves delivery is an occurrence recorded AFTER the last one the screen
   * knew — server clock against server clock, and the window moving does not change that.
   */
  it("conversa longa: a janela do replay andou, e o 'ok' entregue NÃO volta como não entregue", async () => {
    renderSdkChat();
    const first = await socket();
    first.accept();
    for (let at = 1; at <= 6; at += 1) first.deliver({ type: "user", text: "ok", at });
    first.deliver({ type: "ready" });
    await waitFor(() => expect(screen.getAllByTestId("sdk-user")).toHaveLength(6));
    await userEvent.type(screen.getByRole("textbox"), "ok{Enter}");
    await waitFor(() => expect(first.sent.length).toBe(1));
    // the receipt was lost along with the wire — but the server recorded it
    act(() => { first.readyState = 3; first.onclose?.(); });

    await waitFor(() => expect(FakeSocket.instances.length).toBe(2));
    const second = FakeSocket.instances[1] as FakeSocket;
    second.accept();
    second.deliver({ type: "user", text: "ok", at: 5 }); // the four oldest left the window
    second.deliver({ type: "user", text: "ok", at: 6 });
    second.deliver({ type: "user", text: "ok", at: 100 }); // the one from now, recorded
    second.deliver({ type: "ready" });

    await waitFor(() => expect(localStorage.getItem("vibehub.sdkOutbox.c1")).toBeNull());
    expect(screen.getAllByTestId("sdk-user")).toHaveLength(3);
    expect(screen.queryByTestId("sdk-user-undelivered")).not.toBeInTheDocument();
  });

  it("conversa longa: a janela andou e o 'ok' de agora NÃO está nela — sai de novo, sozinho", async () => {
    renderSdkChat();
    const first = await socket();
    first.accept();
    for (let at = 1; at <= 6; at += 1) first.deliver({ type: "user", text: "ok", at });
    first.deliver({ type: "ready" });
    await waitFor(() => expect(screen.getAllByTestId("sdk-user")).toHaveLength(6));
    await userEvent.type(screen.getByRole("textbox"), "ok{Enter}");
    await waitFor(() => expect(first.sent.length).toBe(1));
    act(() => { first.readyState = 3; first.onclose?.(); });

    await waitFor(() => expect(FakeSocket.instances.length).toBe(2));
    const second = FakeSocket.instances[1] as FakeSocket;
    second.accept();
    second.deliver({ type: "user", text: "ok", at: 5 });
    second.deliver({ type: "user", text: "ok", at: 6 });
    second.deliver({ type: "ready" });

    await waitFor(() => expect(second.sent).toHaveLength(1));
    expect(JSON.parse(second.sent[0]!)).toMatchObject({ type: "user", text: "ok" });
    expect(screen.getAllByTestId("sdk-user")).toHaveLength(3);
    expect(screen.getAllByTestId("sdk-user")[2]).toHaveAttribute("data-state", "sending");
  });

  it("Reenviar manda as MESMAS palavras (mesmo recibo: o servidor nunca teve a primeira)", async () => {
    renderSdkChat();
    const ws = await socket();
    ws.accept();
    ws.deliver({ type: "ready" });
    await userEvent.type(screen.getByRole("textbox"), "instrução longa{Enter}");
    await waitFor(() => expect(ws.sent.length).toBe(1));
    const cid = (JSON.parse(ws.sent[0]!) as { cid: string }).cid;
    ws.deliver({ type: "user_nack", cid, reason: "driver-gone" } as SdkEvent);
    await screen.findByTestId("sdk-user-resend");

    await userEvent.click(screen.getByTestId("sdk-user-resend"));

    await waitFor(() => expect(ws.sent.length).toBe(2));
    expect(JSON.parse(ws.sent[1]!)).toMatchObject({ type: "user", text: "instrução longa", cid });
    expect(screen.getByTestId("sdk-user")).toHaveAttribute("data-state", "sending");
  });

  it("Descartar apaga a bolha e a cópia em disco — desistir é uma escolha, não um sumiço", async () => {
    renderSdkChat();
    const ws = await socket();
    ws.accept();
    ws.deliver({ type: "ready" });
    await userEvent.type(screen.getByRole("textbox"), "deixa pra depois{Enter}");
    await waitFor(() => expect(ws.sent.length).toBe(1));
    const cid = (JSON.parse(ws.sent[0]!) as { cid: string }).cid;
    ws.deliver({ type: "user_nack", cid, reason: "driver-gone" } as SdkEvent);
    await screen.findByTestId("sdk-user-discard");

    await userEvent.click(screen.getByTestId("sdk-user-discard"));

    await waitFor(() => expect(screen.queryByTestId("sdk-user")).not.toBeInTheDocument());
    await waitFor(() => expect(localStorage.getItem("vibehub.sdkOutbox.c1")).toBeNull());
  });

  /**
   * THE HOTFIX BUG (production, 2026-09-17, right after the receipt went live): with ONE message
   * undelivered on screen, the chat went into a loop every ~2 seconds — "chat → Iniciando o
   * agente… → whole history back → chat", blinking nonstop until it became unusable.
   *
   * The cause: the undelivered message STAYS in the outbox on purpose (it is the copy that
   * "reenviar/descartar" offers), and its `at` never changes — so it stayed overdue on EVERY
   * watchdog tick, which on each tick dropped the socket "to find out whether it was alive".
   * The verdict is now given once per send; only a resend arms the clock again.
   */
  describe("o veredito é dado UMA vez (o loop de reconexão)", () => {
    /** How many ticks a loop would need to reveal itself — plenty for several deadlines to expire. */
    const MANY_TICKS = (OUTBOX_ACK_TIMEOUT_MS + OUTBOX_TICK_MS) * 5;

    it("user_nack e o tempo passando: o socket VIVO não é derrubado (sem loop de reconexão)", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        renderSdkChat();
        const ws = await socket();
        ws.accept();
        ws.deliver({ type: "ready" });
        const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
        await user.type(screen.getByRole("textbox"), "instrução longa{Enter}");
        await waitFor(() => expect(ws.sent.length).toBe(1));
        const cid = (JSON.parse(ws.sent[0]!) as { cid: string }).cid;
        ws.deliver({ type: "user_nack", cid, reason: "driver-gone" } as SdkEvent);
        await waitFor(() => expect(screen.getByTestId("sdk-user")).toHaveAttribute("data-state", "undelivered"));

        // The automatic resend tries again (spaced out), and this server keeps responding — refusing.
        for (let elapsed = 0; elapsed < MANY_TICKS; elapsed += OUTBOX_TICK_MS) {
          const before = ws.sent.length;
          await act(async () => { await vi.advanceTimersByTimeAsync(OUTBOX_TICK_MS); });
          if (ws.sent.length > before) ws.deliver({ type: "user_nack", cid, reason: "driver-gone" } as SdkEvent);
        }

        expect(ws.readyState).not.toBe(3); // the socket that just responded is not suspect
        expect(FakeSocket.instances).toHaveLength(1); // no reconnect: nothing blinks
        expect(screen.getByTestId("sdk-user-undelivered")).toBeInTheDocument(); // and the bubble is still there
        // The resends follow the plan (intervals from seconds to minutes), never the watchdog tick.
        expect(ws.sent.length - 1).toBeLessThanOrEqual(3);
      } finally {
        vi.useRealTimers();
      }
    });

    it("sem recibo: derruba UMA vez, e a conexão nova fica de pé com a bolha marcada", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        renderSdkChat();
        const first = await socket();
        first.accept();
        first.deliver({ type: "ready" });
        const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
        await user.type(screen.getByRole("textbox"), "instrução longa{Enter}");
        await waitFor(() => expect(first.sent.length).toBe(1));

        // The deadline expires: the suspect socket drops (that is correct) and the browser reconnects.
        await act(async () => { await vi.advanceTimersByTimeAsync(OUTBOX_ACK_TIMEOUT_MS + OUTBOX_TICK_MS); });
        expect(first.readyState).toBe(3);
        act(() => first.onclose?.());
        await act(async () => { await vi.advanceTimersByTimeAsync(RECONNECT_MAX_MS); });
        await waitFor(() => expect(FakeSocket.instances.length).toBe(2));
        const second = FakeSocket.instances[1] as FakeSocket;
        second.accept();
        second.deliver({ type: "ready" }); // the replay does not bring the message: the server never had it
        await waitFor(() => expect(screen.getAllByTestId("sdk-user")).toHaveLength(1));
        const cid = (JSON.parse(first.sent[0]!) as { cid: string }).cid;

        // The new connection responds (the automatic resend gets a "no" — the driver still starting).
        let answered = 0;
        for (let elapsed = 0; elapsed < MANY_TICKS; elapsed += OUTBOX_TICK_MS) {
          if (second.sent.length > answered) {
            answered = second.sent.length;
            second.deliver({ type: "user_nack", cid, reason: "driver-gone" } as SdkEvent);
          }
          await act(async () => { await vi.advanceTimersByTimeAsync(OUTBOX_TICK_MS); });
        }

        expect(screen.getByTestId("sdk-user")).toHaveAttribute("data-state", "undelivered");
        expect(second.readyState).not.toBe(3); // the new connection is not dropped again
        expect(FakeSocket.instances).toHaveLength(2); // and no third one is born
      } finally {
        vi.useRealTimers();
      }
    });

    it("F5 com a mensagem antiga (já com veredito) em disco: a bolha volta marcada e a conexão fica quieta", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        localStorage.setItem(
          "vibehub.sdkOutbox.c1",
          // With the automatic resend plan already exhausted: all that is left is the old verdict.
          JSON.stringify([{
            cid: "c-antigo",
            text: "a instrução longa que sumia",
            at: Date.now() - 60_000,
            undelivered: true,
            autoRetries: AUTO_RESEND_DELAYS_MS.length,
          }]),
        );
        renderSdkChat();
        const ws = await socket();
        ws.accept();
        ws.deliver({ type: "ready" });
        await waitFor(() => expect(screen.getByTestId("sdk-user")).toHaveAttribute("data-state", "undelivered"));

        await act(async () => { await vi.advanceTimersByTimeAsync(MANY_TICKS); });

        expect(ws.readyState).not.toBe(3);
        expect(FakeSocket.instances).toHaveLength(1);
        expect(ws.sent).toHaveLength(0);
      } finally {
        vi.useRealTimers();
      }
    });

    it("Reenviar volta a armar o relógio: o novo envio também é cobrado (o watchdog não fica mudo)", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        renderSdkChat();
        const ws = await socket();
        ws.accept();
        ws.deliver({ type: "ready" });
        const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
        await user.type(screen.getByRole("textbox"), "instrução longa{Enter}");
        await waitFor(() => expect(ws.sent.length).toBe(1));
        const cid = (JSON.parse(ws.sent[0]!) as { cid: string }).cid;
        ws.deliver({ type: "user_nack", cid, reason: "driver-gone" } as SdkEvent);
        await screen.findByTestId("sdk-user-resend");

        await user.click(screen.getByTestId("sdk-user-resend"));
        await waitFor(() => expect(ws.sent.length).toBe(2));
        expect(screen.getByTestId("sdk-user")).toHaveAttribute("data-state", "sending");

        await act(async () => { await vi.advanceTimersByTimeAsync(OUTBOX_ACK_TIMEOUT_MS + OUTBOX_TICK_MS); });

        expect(screen.getByTestId("sdk-user")).toHaveAttribute("data-state", "undelivered");
        expect(ws.readyState).toBe(3); // this time nobody responded: the socket is suspect again
      } finally {
        vi.useRealTimers();
      }
    });
  });

  /**
   * THE MANUAL RESEND BUG (production, 2026-10-27): the message failed, the bubble stayed "não entregue"
   * with Reenviar, and the person — who had already left — only found it the next day, waiting for
   * a click. The good connection had come back within moments.
   *
   * The screen now resends by itself, with the same words and the same receipt (the back treats the repeated cid
   * as a reminder, never as a second turn), at growing intervals and with an end — counted
   * attempts and an age ceiling. What these tests pin down: it goes out by itself, does not become a loop, a dropped wire does not
   * spend an attempt, an old message does not go out without the person, and the conversation's order does not get scrambled.
   */
  describe("o reenvio automático (a mensagem que esperou um clique a noite toda)", () => {
    /** A send the server refused: the bubble is "não entregue" and the cid is returned. */
    async function refusedSend(ws: FakeSocket, text: string, user: ReturnType<typeof userEvent.setup>): Promise<string> {
      await user.type(screen.getByRole("textbox"), `${text}{Enter}`);
      await waitFor(() => expect(ws.sent.length).toBeGreaterThan(0));
      const cid = (JSON.parse(ws.sent[ws.sent.length - 1]!) as { cid: string }).cid;
      ws.deliver({ type: "user_nack", cid, reason: "driver-gone" } as SdkEvent);
      await waitFor(() => expect(screen.getByTestId("sdk-user")).toHaveAttribute("data-state", "undelivered"));
      return cid;
    }

    it("recusada: sem clique nenhum, sai de novo sozinha depois do intervalo — mesmas palavras, mesmo recibo", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        renderSdkChat();
        const ws = await socket();
        ws.accept();
        ws.deliver({ type: "ready" });
        const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
        const cid = await refusedSend(ws, "roda a migração", user);
        // The bubble says it needs no one: the screen will try again.
        expect(screen.getByTestId("sdk-user-retrying")).toBeInTheDocument();
        expect(ws.sent).toHaveLength(1); // nothing right away: the first interval is seconds

        await act(async () => { await vi.advanceTimersByTimeAsync(AUTO_RESEND_DELAYS_MS[0]!); });

        expect(ws.sent).toHaveLength(2);
        expect(JSON.parse(ws.sent[1]!)).toEqual({ type: "user", text: "roda a migração", cid });
        expect(screen.getByTestId("sdk-user")).toHaveAttribute("data-state", "sending");
        ws.deliver({ type: "user_ack", cid } as SdkEvent);
        await waitFor(() => expect(screen.getByTestId("sdk-user")).toHaveAttribute("data-state", "sent"));
        expect(localStorage.getItem("vibehub.sdkOutbox.c1")).toBeNull();
        expect(screen.getAllByTestId("sdk-user")).toHaveLength(1); // only one bubble, never two
      } finally {
        vi.useRealTimers();
      }
    });

    it("o socket meio-aberto engoliu a mensagem: na conexão nova ela sai sozinha (sem ninguém na tela)", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        renderSdkChat();
        const first = await socket();
        first.accept();
        first.deliver({ type: "ready" });
        const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
        await user.type(screen.getByRole("textbox"), "instrução longa{Enter}");
        await waitFor(() => expect(first.sent.length).toBe(1));
        const cid = (JSON.parse(first.sent[0]!) as { cid: string }).cid;

        // No receipt: the watchdog gives the verdict and drops the socket; the browser reconnects.
        await act(async () => { await vi.advanceTimersByTimeAsync(OUTBOX_ACK_TIMEOUT_MS + OUTBOX_TICK_MS); });
        expect(first.readyState).toBe(3);
        act(() => first.onclose?.());
        await act(async () => { await vi.advanceTimersByTimeAsync(RECONNECT_MAX_MS); });
        await waitFor(() => expect(FakeSocket.instances.length).toBe(2));
        const second = FakeSocket.instances[1] as FakeSocket;
        second.accept();
        second.deliver({ type: "ready" }); // the replay does not bring it: the server never had it

        await waitFor(() => expect(second.sent).toHaveLength(1));
        expect(JSON.parse(second.sent[0]!)).toEqual({ type: "user", text: "instrução longa", cid });
        second.deliver({ type: "user_ack", cid } as SdkEvent);
        await waitFor(() => expect(screen.getByTestId("sdk-user")).toHaveAttribute("data-state", "sent"));
        expect(screen.getAllByTestId("sdk-user")).toHaveLength(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it("SEM LAÇO: um servidor que recusa sempre recebe só as tentativas do plano, espaçadas — depois, silêncio", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        renderSdkChat();
        const ws = await socket();
        ws.accept();
        ws.deliver({ type: "ready" });
        const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
        const cid = await refusedSend(ws, "instrução longa", user);
        const sentAt: number[] = [Date.now()];

        // The server refuses every attempt, right away. The screen must not hammer.
        for (let step = 0; step < AUTO_RESEND_DELAYS_MS.length + 3; step += 1) {
          const before = ws.sent.length;
          await act(async () => { await vi.advanceTimersByTimeAsync(AUTO_RESEND_DELAYS_MS[step] ?? 30 * 60_000); });
          if (ws.sent.length > before) {
            sentAt.push(Date.now());
            ws.deliver({ type: "user_nack", cid, reason: "driver-gone" } as SdkEvent);
          }
        }

        // 1 send by the person + 1 per plan interval. Not one more, however much time passes.
        expect(ws.sent).toHaveLength(1 + AUTO_RESEND_DELAYS_MS.length);
        // …each one waiting longer than the previous (never several per second).
        const gaps = sentAt.slice(1).map((t, i) => t - sentAt[i]!);
        gaps.forEach((gap, i) => expect(gap).toBeGreaterThanOrEqual(AUTO_RESEND_DELAYS_MS[i]!));
        // Plan exhausted: the bubble goes back to being just Reenviar (the person decides), and the socket stays quiet.
        expect(screen.getByTestId("sdk-user")).toHaveAttribute("data-state", "undelivered");
        expect(screen.queryByTestId("sdk-user-retrying")).not.toBeInTheDocument();
        expect(screen.getByTestId("sdk-user-resend")).toBeInTheDocument();
        expect(FakeSocket.instances).toHaveLength(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it("fio caído não gasta tentativa: a mensagem sai quando a conexão volta, mesmo depois de muito tempo", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        renderSdkChat();
        const first = await socket();
        first.accept();
        first.deliver({ type: "ready" });
        const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
        const cid = await refusedSend(first, "instrução longa", user);
        act(() => { first.readyState = 3; first.onclose?.(); });

        // The VPN was down longer than the whole plan added up: the reconnects never complete.
        const outage = AUTO_RESEND_DELAYS_MS.reduce((a, b) => a + b, 0) + 10 * 60_000;
        await act(async () => { await vi.advanceTimersByTimeAsync(outage); });
        const back = FakeSocket.instances[FakeSocket.instances.length - 1] as FakeSocket;
        expect(back).not.toBe(first);
        back.accept();
        back.deliver({ type: "ready" });

        await waitFor(() => expect(back.sent).toHaveLength(1));
        expect(JSON.parse(back.sent[0]!)).toEqual({ type: "user", text: "instrução longa", cid });
      } finally {
        vi.useRealTimers();
      }
    });

    it("a mensagem VELHA (acima do teto de idade) volta marcada e NÃO sai sozinha — a pessoa decide", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        localStorage.setItem(
          "vibehub.sdkOutbox.c1",
          JSON.stringify([{ cid: "c-ontem", text: "sobe pra prod", at: Date.now() - AUTO_RESEND_MAX_AGE_MS - 1, undelivered: true }]),
        );
        renderSdkChat();
        const ws = await socket();
        ws.accept();
        ws.deliver({ type: "ready" });
        await waitFor(() => expect(screen.getByTestId("sdk-user")).toHaveAttribute("data-state", "undelivered"));

        await act(async () => { await vi.advanceTimersByTimeAsync(60 * 60_000); });

        expect(ws.sent).toHaveLength(0);
        expect(screen.queryByTestId("sdk-user-retrying")).not.toBeInTheDocument();
        expect(screen.getByTestId("sdk-user-resend")).toBeInTheDocument();
      } finally {
        vi.useRealTimers();
      }
    });

    it("F5 com a mensagem recusada há pouco: volta marcada e sai sozinha quando o intervalo vence", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        localStorage.setItem(
          "vibehub.sdkOutbox.c1",
          JSON.stringify([{ cid: "c-antigo", text: "a instrução recusada", at: Date.now() - 60_000, undelivered: true, autoRetries: 1 }]),
        );
        renderSdkChat();
        const ws = await socket();
        ws.accept();
        ws.deliver({ type: "ready" });

        await waitFor(() => expect(ws.sent).toHaveLength(1));
        expect(JSON.parse(ws.sent[0]!)).toEqual({ type: "user", text: "a instrução recusada", cid: "c-antigo" });
        // The spent attempt goes to disk: an F5 now does not restart the count.
        await waitFor(() => expect(JSON.parse(localStorage.getItem("vibehub.sdkOutbox.c1")!)[0]).toMatchObject({ autoRetries: 2 }));
      } finally {
        vi.useRealTimers();
      }
    });

    it("a ordem da conversa: a que falhou sai ANTES da que foi escrita depois (e esperou na fila)", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        renderSdkChat();
        const first = await socket();
        first.accept();
        first.deliver({ type: "ready" });
        const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
        const cid = await refusedSend(first, "primeiro isso", user);
        // The driver had died: the back closes the socket. With the wire down, the next one waits in the queue.
        act(() => { first.readyState = 3; first.onclose?.(); });
        await user.type(screen.getByRole("textbox"), "depois isso{Enter}");
        await act(async () => { await vi.advanceTimersByTimeAsync(AUTO_RESEND_DELAYS_MS[0]! + RECONNECT_MAX_MS); });
        const second = FakeSocket.instances[FakeSocket.instances.length - 1] as FakeSocket;
        second.accept();
        second.deliver({ type: "ready" });

        await waitFor(() => expect(second.sent.length).toBeGreaterThanOrEqual(1));
        expect(JSON.parse(second.sent[0]!)).toMatchObject({ type: "user", text: "primeiro isso", cid });
      } finally {
        vi.useRealTimers();
      }
    });

    it("o Reenviar na mão continua valendo na hora, sem esperar o intervalo", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        renderSdkChat();
        const ws = await socket();
        ws.accept();
        ws.deliver({ type: "ready" });
        const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
        const cid = await refusedSend(ws, "instrução longa", user);

        await user.click(screen.getByTestId("sdk-user-resend"));

        expect(ws.sent).toHaveLength(2);
        expect(JSON.parse(ws.sent[1]!)).toMatchObject({ type: "user", text: "instrução longa", cid });
        // …and the automatic one does not send a third copy on top: this one is "enviando", with the receipt armed.
        await act(async () => { await vi.advanceTimersByTimeAsync(AUTO_RESEND_DELAYS_MS[0]!); });
        expect(ws.sent).toHaveLength(2);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  /**
   * CÉSAR'S BUG (production, 2026-09-28): "all the time" some message, in the middle of a
   * normal conversation, is born flagged "não entregue ao servidor" — with the server up 24h.
   *
   * The cause is not the server being down: it is the RECEIPT CLOCK running at a moment when the
   * server has no way to respond yet. The browser's `onopen` fires on the websocket's
   * handshake, but the back only reaches `dispatchClientFrame` AFTER a setup that takes seconds —
   * `installCardSdkDriver` (two `docker exec` over SSH, with `npm install` when the version changed), the
   * transcript probe (15s timeout, alone longer than the receipt deadline), reading and replaying
   * the history, spawning the driver. Until then the frame stays in `pendingFrames` (routes/cardSdk.ts), and
   * it is delivered FOR REAL when the setup finishes.
   *
   * In other words: the bubble flagged as "não entregue" a message the server received — and the "Reenviar"
   * the person clicks sends the second copy. Worse, the watchdog dropped that socket in the middle of
   * setup, and the reconnect pays the whole setup again: that is the "all the time".
   *
   * The rule these tests pin down: the absence of a receipt is only PROOF when the connection was in
   * a position to respond. The deadline counts from `ready` — the moment the server
   * took over this socket —, never from before it.
   */
  describe("o prazo do recibo só corre quando o servidor pode responder", () => {
    it("escrita enquanto o back ainda monta a conexão: espera na fila, nada vence, nada é condenado", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        renderSdkChat();
        const ws = await socket();
        ws.accept(); // the handshake finished — but the back is still in setup, without `ready`
        const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
        await user.type(screen.getByRole("textbox"), "instrução longa{Enter}");

        await act(async () => { await vi.advanceTimersByTimeAsync(OUTBOX_ACK_TIMEOUT_MS + OUTBOX_TICK_MS); });

        // Nothing went out (an F5 here loses nothing) and nothing is flagged: the server did not even get to hear.
        expect(ws.sent).toHaveLength(0);
        expect(screen.getByTestId("sdk-queued")).toHaveTextContent("instrução longa");
        expect(screen.queryByTestId("sdk-user-undelivered")).not.toBeInTheDocument();
        expect(ws.readyState).not.toBe(3); // and the socket of the setup in progress is NOT dropped
      } finally {
        vi.useRealTimers();
      }
    });

    it("o setup demorou e terminou: o recibo chega e a bolha vira 'sent', sem falso negativo", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        renderSdkChat();
        const ws = await socket();
        ws.accept();
        const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
        await user.type(screen.getByRole("textbox"), "instrução longa{Enter}");

        // The back's setup (transcript probe + replay + spawn) took longer than the deadline…
        await act(async () => { await vi.advanceTimersByTimeAsync(OUTBOX_ACK_TIMEOUT_MS * 2); });
        // …and then it serves the socket: the queue moves, and the receipt comes.
        ws.deliver({ type: "ready" });
        await waitFor(() => expect(ws.sent.length).toBe(1));
        const cid = (JSON.parse(ws.sent[0]!) as { cid: string }).cid;
        ws.deliver({ type: "user_ack", cid } as SdkEvent);

        await waitFor(() => expect(screen.getByTestId("sdk-user")).toHaveAttribute("data-state", "sent"));
        await waitFor(() => expect(localStorage.getItem("vibehub.sdkOutbox.c1")).toBeNull());
      } finally {
        vi.useRealTimers();
      }
    });

    /**
     * `ready` arrives BEFORE the receipts of what was buffered: the back sends `ready` on attach
     * (manager.ts) and only AFTERWARDS processes `pendingFrames` (routes/cardSdk.ts). So the replay
     * cannot contain the in-flight message — and the reconciliation, which compares by TEXT, took it as
     * lost: duplicated bubble, flagged "não entregue", for a message on its way.
     *
     * The boundary: reconciling is about what was left over from BEFORE. A send that already has a bubble on this screen
     * has an owner — the watchdog — and the reconciliation has no say about it.
     */
    it("a reconciliação não duplica nem condena o envio que ESTA conexão ainda espera", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        renderSdkChat();
        const ws = await socket();
        ws.accept();
        const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
        await user.type(screen.getByRole("textbox"), "instrução longa{Enter}");

        await act(async () => { await vi.advanceTimersByTimeAsync(OUTBOX_ACK_TIMEOUT_MS * 2); });
        ws.deliver({ type: "ready" }); // the replay comes without it: it was still in the queue

        await waitFor(() => expect(ws.sent.length).toBe(1));
        expect(screen.getAllByTestId("sdk-user")).toHaveLength(1);
        expect(screen.getByTestId("sdk-user")).toHaveAttribute("data-state", "sending");
      } finally {
        vi.useRealTimers();
      }
    });

    it("depois do 'ready' o relógio começa DO ZERO — a espera do setup não é descontada do prazo", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        renderSdkChat();
        const ws = await socket();
        ws.accept();
        const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
        await user.type(screen.getByRole("textbox"), "instrução longa{Enter}");

        await act(async () => { await vi.advanceTimersByTimeAsync(OUTBOX_ACK_TIMEOUT_MS * 2); });
        ws.deliver({ type: "ready" }); // the server took over the socket NOW: the deadline is born here
        await waitFor(() => expect(ws.sent.length).toBe(1));

        await act(async () => { await vi.advanceTimersByTimeAsync(OUTBOX_ACK_TIMEOUT_MS / 2); });
        expect(screen.getByTestId("sdk-user")).toHaveAttribute("data-state", "sending");

        await act(async () => { await vi.advanceTimersByTimeAsync(OUTBOX_ACK_TIMEOUT_MS); });
        // Now yes: there was a connection standing, with a full deadline, and nobody responded.
        expect(screen.getByTestId("sdk-user")).toHaveAttribute("data-state", "undelivered");
        expect(ws.readyState).toBe(3);
      } finally {
        vi.useRealTimers();
      }
    });

    /**
     * THE OTHER HALF of the "all the time": writing during the reconnect.
     *
     * A socket drops all the time for mundane reasons — deploy, laptop lid, proxy cutting an
     * idle connection — and the reconnect takes from 400ms to 15s (lib/reconnect.ts). Whoever is writing
     * sees none of this: presses Enter and, until now, the message was born INSTANTLY condemned ("não
     * entregue ao servidor", with reenviar/descartar) by a wire that would come back two seconds later —
     * and the text stayed in TWO places at once, in the bubble and in the field, from where a second
     * Enter sent the copy.
     *
     * A message that only needs to wait for the wire is not a lost message: it is the QUEUE — the same
     * place where whoever wrote during a turn waits, editable, saved on disk, and delivered
     * by itself as soon as the connection can carry it again.
     */
    it("escrever com o fio caído: a mensagem espera na fila, e sobe sozinha quando o fio volta", async () => {
      renderSdkChat();
      const first = await socket();
      first.accept();
      first.deliver({ type: "ready" });
      act(() => { first.readyState = 3; first.onclose?.(); }); // the wire dropped, without anyone noticing

      await userEvent.type(screen.getByRole("textbox"), "instrução longa{Enter}");

      expect(first.sent).toHaveLength(0);
      expect(screen.queryByTestId("sdk-user")).not.toBeInTheDocument(); // nothing is born condemned
      expect(screen.getByTestId("sdk-queued")).toHaveTextContent("instrução longa");
      expect(screen.getByRole("textbox")).toHaveValue(""); // and the text does not stay in two places

      // The wire comes back: the queue moves by itself, and only now does the message become a real bubble.
      await waitFor(() => expect(FakeSocket.instances.length).toBe(2));
      const second = FakeSocket.instances[1] as FakeSocket;
      second.accept();
      second.deliver({ type: "ready" });

      await waitFor(() => expect(second.sent.length).toBe(1));
      expect(JSON.parse(second.sent[0]!)).toMatchObject({ type: "user", text: "instrução longa" });
      await waitFor(() => expect(screen.queryByTestId("sdk-queued")).not.toBeInTheDocument());
      expect(screen.getByTestId("sdk-user")).toHaveAttribute("data-state", "sending");
    });

    /**
     * THE EXCEPTION THAT MUST NOT FALL: with a question from the agent waiting for an answer, NOTHING is
     * queued — not even with the wire down.
     *
     * A `user_question` leaves the driver blocked with the turn still counted as ACTIVE, and the only
     * thing that releases it is a message from the person. The queue dispatch only moves when the turn closes —
     * so queuing here would mean waiting for an end of turn that only the queued message itself
     * could cause: a permanent lock, the kind that lasts half an hour until the timeout.
     */
    it("pergunta do agente na tela: a mensagem NÃO vai pra fila nem com o fio caído (seria deadlock)", async () => {
      renderSdkChat();
      const ws = await socket();
      ws.accept();
      ws.deliver({ type: "ready", turnActive: true } as SdkEvent);
      ws.deliver({
        type: "user_question",
        id: "q1",
        questions: [{ question: "Sigo pelo caminho A?", options: [{ label: "A" }, { label: "B" }] }],
      } as SdkEvent);
      await screen.findByTestId("sdk-question");
      act(() => { ws.readyState = 3; ws.onclose?.(); }); // the wire drops with the question standing

      const composer = screen.getByTestId("terminal-composer").querySelector("textarea")!;
      await userEvent.type(composer, "vai pelo A mesmo{Enter}");

      expect(screen.queryByTestId("sdk-queued")).not.toBeInTheDocument();
    });

    it("conexão caída: o prazo não corre no escuro — quem decide é a reconciliação do reconnect", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        renderSdkChat();
        const ws = await socket();
        ws.accept();
        ws.deliver({ type: "ready" });
        const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
        await user.type(screen.getByRole("textbox"), "instrução longa{Enter}");
        await waitFor(() => expect(ws.sent.length).toBe(1));

        // The wire drops right after the send (deploy, VPN, wi-fi) — none of that is the message's fault.
        act(() => { ws.readyState = 3; ws.onclose?.(); });
        await act(async () => { await vi.advanceTimersByTimeAsync(OUTBOX_ACK_TIMEOUT_MS + OUTBOX_TICK_MS); });

        expect(screen.getByTestId("sdk-user")).toHaveAttribute("data-state", "sending");
        expect(screen.queryByTestId("sdk-user-undelivered")).not.toBeInTheDocument();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  /**
   * The dead socket the browser has not noticed yet (`readyState` closed without `onclose` having
   * run): nothing goes out through it. The condemned bubble that was born here was a false negative twice over
   * — the server refused nothing, it was not even consulted — and it left the text in two places, in the
   * bubble and in the field, from where the next Enter sent the copy. A message that only needs a
   * wire WAITS: saved on disk, editable, delivered by the dispatch when there is a connection.
   */
  it("socket morto: a mensagem nem sai, espera na fila, e ninguém acusa entrega nenhuma", async () => {
    renderSdkChat();
    const ws = await socket();
    ws.accept();
    ws.deliver({ type: "ready" });
    ws.readyState = 3; // dead, without the browser having noticed (the half-open socket case)

    await userEvent.type(screen.getByRole("textbox"), "não vai sair{Enter}");

    expect(ws.sent.length).toBe(0);
    expect(await screen.findByTestId("sdk-queued")).toHaveTextContent("não vai sair"); // saved and editable
    expect(screen.queryByTestId("sdk-user")).not.toBeInTheDocument(); // nothing is born condemned
    expect(screen.getByRole("textbox")).toHaveValue(""); // and the text does not stay in two places
  });
});

/**
 * "SÓ FICA UM LOADING ESCRITO 'TRABALHANDO…'" (César's request, 2026-09-17): a ten-minute turn
 * and a half-second one were identical on screen, and whoever was waiting did not know whether the agent had understood
 * the request. The reasoning is the only thing that exists before the answer — so it is what becomes news.
 */
describe("SdkChatView — o raciocínio durante a espera", () => {
  it("o pensamento aparece ao vivo, aberto, enquanto o modelo pensa", async () => {
    renderSdkChat();
    const ws = await socket();
    ws.accept();
    ws.deliver({ type: "ready" });

    ws.deliver({ type: "thinking_delta", text: "Primeiro vou ler o " } as SdkEvent);
    ws.deliver({ type: "thinking_delta", text: "teste que falhou." } as SdkEvent);

    const row = await screen.findByTestId("sdk-thinking");
    expect(row).toHaveAttribute("data-streaming", "true");
    expect(screen.getByTestId("sdk-thinking-text")).toHaveTextContent("Primeiro vou ler o teste que falhou.");
  });

  it("terminado o pensamento, a linha CONTINUA aberta — e quem fecha, fecha", async () => {
    renderSdkChat();
    const ws = await socket();
    ws.accept();
    ws.deliver({ type: "ready" });
    ws.deliver({ type: "thinking_delta", text: "hmm" } as SdkEvent);
    await screen.findByTestId("sdk-thinking-text");

    ws.deliver({ type: "thinking", text: "O teste falha por causa do timeout." } as SdkEvent);

    // The end of the turn does not hide the reasoning: that is exactly when it explains what was done.
    await waitFor(() =>
      expect(screen.getByTestId("sdk-thinking-text")).toHaveTextContent("O teste falha por causa do timeout."),
    );
    await userEvent.click(screen.getByTestId("sdk-thinking-toggle"));
    expect(screen.queryByTestId("sdk-thinking-text")).not.toBeInTheDocument();
  });

  it("quem abriu o raciocínio no meio do turno NÃO o perde quando ele termina", async () => {
    renderSdkChat();
    const ws = await socket();
    ws.accept();
    ws.deliver({ type: "ready" });
    ws.deliver({ type: "thinking_delta", text: "pensando" } as SdkEvent);
    await screen.findByTestId("sdk-thinking-text");
    await userEvent.click(screen.getByTestId("sdk-thinking-toggle")); // closes
    await userEvent.click(screen.getByTestId("sdk-thinking-toggle")); // and reopens: explicit choice

    ws.deliver({ type: "thinking", text: "decidido" } as SdkEvent);

    expect(screen.getByTestId("sdk-thinking-text")).toHaveTextContent("decidido");
  });

  it("a resposta é desenhada separada do raciocínio (uma não vira a outra)", async () => {
    renderSdkChat();
    const ws = await socket();
    ws.accept();
    ws.deliver({ type: "ready" });
    ws.deliver({ type: "thinking_delta", text: "vou responder curto" } as SdkEvent);
    ws.deliver({ type: "assistant_delta", text: "Pronto." } as SdkEvent);

    await waitFor(() => expect(screen.getByTestId("sdk-assistant")).toHaveTextContent("Pronto."));
    expect(screen.getByTestId("sdk-thinking")).not.toHaveAttribute("data-streaming");
    expect(screen.getByTestId("sdk-assistant")).not.toHaveTextContent("vou responder curto");
  });
});

/**
 * The card that locked the screen (production, 2026-09-17). The unlocking itself lives in the driver — what
 * is stopped waiting for the click is the turn inside `canUseTool` —, and what the SCREEN owes is telling the
 * truth when it is released: the person answered, just not through the card.
 */
describe("SdkChatView — a pergunta respondida por mensagem", () => {
  const question = {
    type: "user_question",
    id: "q1",
    questions: [{ question: "Abro PR ou commito direto?", options: [{ label: "PR" }, { label: "direto" }] }],
  } as unknown as SdkEvent;

  it("o cartão diz que foi respondido por mensagem — não 'sem resposta'", async () => {
    renderSdkChat();
    const ws = await socket();
    ws.accept();
    ws.deliver({ type: "ready" });
    ws.deliver(question);
    await screen.findByTestId("sdk-question");

    ws.deliver({ type: "question_result", id: "q1", superseded: true } as unknown as SdkEvent);

    // (the suite runs in the default language, en — pt-BR says "Você respondeu por mensagem")
    await waitFor(() => expect(screen.getByTestId("sdk-question")).toHaveTextContent("You answered with a message"));
    expect(screen.getByTestId("sdk-question")).not.toHaveTextContent("No answer");
  });

  it("e a bandeja de decisões pendentes esvazia (nada segue cobrando um clique)", async () => {
    renderSdkChat();
    const ws = await socket();
    ws.accept();
    ws.deliver({ type: "ready" });
    ws.deliver(question);
    await waitFor(() => expect(screen.getByTestId("pending-tray")).toBeInTheDocument());

    ws.deliver({ type: "question_result", id: "q1", superseded: true } as unknown as SdkEvent);

    await waitFor(() => expect(screen.queryByTestId("pending-tray")).not.toBeInTheDocument());
  });
});

/**
 * THE MUTE RED BALLOON. The production screenshot: an answer chopped mid-sentence and, under it, a
 * red bubble whose entire content was the word "error". It came from a turn that ended with
 * `is_error` and no text of its own — the exact shape an INTERRUPT produces.
 */
describe("SdkChatView — todo erro diz o que houve", () => {
  it("a failed turn with no words gets a sentence, never the bare word 'error'", async () => {
    renderSdkChat();
    const ws = await socket();
    ws.accept();
    ws.deliver({ type: "ready" });
    ws.deliver({ type: "assistant_delta", text: "Analisando…" });
    ws.deliver({ type: "result", isError: true, subtype: "error_during_execution" });

    const banner = await screen.findByTestId("sdk-error");
    expect(banner.textContent).not.toBe("error");
    expect(banner).toHaveTextContent(/error_during_execution/); // what the driver actually said
    expect(banner).toHaveTextContent(/reenvie a mensagem|send the message again/i); // what to do
  });

  it("an error frame with no message says so instead of showing an empty red box", async () => {
    renderSdkChat();
    const ws = await socket();
    ws.accept();
    ws.deliver({ type: "ready" });
    ws.deliver({ type: "error", message: "" });

    expect(await screen.findByTestId("sdk-error")).toHaveTextContent(/reabra o card|reopen the card/i);
  });

  it("'driver exited' stops being jargon: it says the page reconnects on its own", async () => {
    renderSdkChat();
    const ws = await socket();
    ws.accept();
    ws.deliver({ type: "error", message: "driver exited (code 1)" });

    const banner = await screen.findByTestId("sdk-error");
    expect(banner).toHaveTextContent(/reconecta|reconnects/i);
    expect(banner).toHaveTextContent(/code 1/); // the raw detail is kept, not hidden
  });

  it("the back's interrupt note is drawn in the reader's language, not as a code", async () => {
    renderSdkChat();
    const ws = await socket();
    ws.accept();
    ws.deliver({ type: "ready" });
    ws.deliver({ type: "assistant_text", text: "Estava indo até que…" });
    ws.deliver({ type: "system_note", text: "turn-interrupted-edit" });

    const note = await screen.findByTestId("sdk-note");
    expect(note).toHaveTextContent(/editar a mensagem|edit the message/i);
    expect(note.textContent).not.toContain("turn-interrupted-edit");
  });
});

/**
 * WHAT IS RUNNING, WITHOUT SCROLLING FOR IT.
 *
 * In the terminal the status line is always on screen: what the agent is doing and for how long.
 * In the chat that was scattered through the scroll — a long turn (a skill, an agent, a build) put
 * it far above the fold, and the person watching the card had to scroll to find out whether
 * anything was still happening. The bar is pinned while the turn runs, carries the CURRENT step,
 * the clock and the escalation, and jumps to the live edge when clicked.
 */
describe("SdkChatView — the activity bar", () => {
  it("is absent at rest and appears with the turn, naming the newest step", async () => {
    renderSdkChat();
    const ws = await socket();
    ws.accept();
    ws.deliver({ type: "ready" });
    expect(screen.queryByTestId("sdk-activity-bar")).toBeNull();

    ws.deliver({ type: "user", text: "use code review no pdv" });
    ws.deliver({ type: "thinking_delta", text: "pensando…" });
    expect(screen.getByTestId("sdk-activity-bar")).toBeInTheDocument();
    expect(screen.getByTestId("sdk-activity-label")).toHaveTextContent("Thinking…");

    ws.deliver({ type: "tool_use", id: "t1", name: "Bash", input: { description: "Measuring PDV module size", command: "ls" } });
    expect(screen.getByTestId("sdk-activity-label")).toHaveTextContent("Measuring PDV module size");

    ws.deliver({ type: "tool_use", id: "t2", name: "Skill", input: { skill: "code-review" } });
    expect(screen.getByTestId("sdk-activity-label")).toHaveTextContent("Skill(code-review)");
    expect(screen.getByTestId("sdk-activity-bar").getAttribute("data-kind")).toBe("tool");

    // The turn ends: nothing is running, so nothing claims to be.
    ws.deliver({ type: "result", isError: false });
    expect(screen.queryByTestId("sdk-activity-bar")).toBeNull();
  });

  it("counts the seconds the turn has been running", async () => {
    vi.useFakeTimers();
    try {
      renderSdkChat();
      const ws = await vi.waitFor(() => {
        expect(FakeSocket.instances.length).toBeGreaterThan(0);
        return FakeSocket.instances[0] as FakeSocket;
      });
      ws.accept();
      ws.deliver({ type: "ready" });
      // A DRIVER event is what says a turn is running (a mirrored user line never does).
      ws.deliver({ type: "thinking_delta", text: "pensando…" });
      expect(screen.getByTestId("sdk-activity-elapsed")).toHaveTextContent("0s");
      act(() => { vi.advanceTimersByTime(4_000); });
      expect(screen.getByTestId("sdk-activity-elapsed")).toHaveTextContent("4s");
      act(() => { vi.advanceTimersByTime(80_000); });
      expect(screen.getByTestId("sdk-activity-elapsed")).toHaveTextContent("1m 24s");
    } finally {
      vi.useRealTimers();
    }
  });

  it("says the turn was escalated — ultrathink/ultracode cost time and money in silence", async () => {
    renderSdkChat();
    const ws = await socket();
    ws.accept();
    ws.deliver({ type: "ready" });

    const field = screen.getByRole("textbox");
    fireEvent.change(field, { target: { value: "ultracode revisa o pdv" } });
    fireEvent.keyDown(field, { key: "Enter" });

    await waitFor(() => expect(screen.getByTestId("sdk-activity-effort")).toHaveTextContent("ultracode"));
    ws.deliver({ type: "result", isError: false });
    await waitFor(() => expect(screen.queryByTestId("sdk-activity-effort")).toBeNull());
  });

  it("o driver avisa que a troca do pill tirou o turno do nível da palavra: o 'esforço alto' sai da barra", async () => {
    // Review of #259 (f5): the order of the switch and the word is the DRIVER's. The browser's clock does not
    // know it (the PATCH writes before sending the switch, and the message may arrive first).
    renderSdkChat();
    const ws = await socket();
    ws.accept();
    ws.deliver({ type: "ready" });

    const field = screen.getByRole("textbox");
    fireEvent.change(field, { target: { value: "ultrathink revisa o pdv" } });
    fireEvent.keyDown(field, { key: "Enter" });
    await waitFor(() => expect(screen.getByTestId("sdk-activity-effort")).toHaveTextContent("high effort"));

    ws.deliver({ type: "keyword_effort_replaced" });
    await waitFor(() => expect(screen.queryByTestId("sdk-activity-effort")).toBeNull());
    expect(screen.getByTestId("sdk-activity-bar")).toBeInTheDocument();
  });

  it("o ultracode segue na barra depois do aviso — a orquestração continua ligada", async () => {
    renderSdkChat();
    const ws = await socket();
    ws.accept();
    ws.deliver({ type: "ready" });

    const field = screen.getByRole("textbox");
    fireEvent.change(field, { target: { value: "ultracode revisa o pdv" } });
    fireEvent.keyDown(field, { key: "Enter" });
    await waitFor(() => expect(screen.getByTestId("sdk-activity-effort")).toHaveTextContent("ultracode"));

    ws.deliver({ type: "keyword_effort_replaced" });
    expect(screen.getByTestId("sdk-activity-effort")).toHaveTextContent("ultracode");
  });

  it("a click on the bar goes to the live edge of the conversation", async () => {
    renderSdkChat();
    const ws = await socket();
    ws.accept();
    ws.deliver({ type: "ready" });
    ws.deliver({ type: "thinking_delta", text: "pensando…" });
    const scroller = screen.getByTestId("sdk-chat-scroller");
    const scrollTo = vi.fn();
    Object.defineProperty(scroller, "scrollTo", { value: scrollTo, configurable: true });
    fireEvent.click(screen.getByTestId("sdk-activity-bar"));
    expect(scrollTo).toHaveBeenCalled();
  });
});

/**
 * THE SCREEN READER. The conversation is a `role="log"` — a live region: everything that changes inside it is
 * announced. The turn's clock lived in there (the bar pinned at the top and the "Trabalhando… 1m 24s"
 * at the end), so whoever listens to the screen heard the stopwatch every second, over the conversation. The
 * stopwatch is for the eyes; for the ear goes the PHASE (thinking, answering, executing), which only
 * changes when the work changes.
 */
describe("SdkChatView — o que o leitor de tela anuncia", () => {
  /** Is it in a part of the conversation the screen reader announces (inside the log and without aria-hidden)? */
  function announcedInLog(el: Element): boolean {
    const log = screen.getByRole("log");
    if (!log.contains(el)) return false;
    for (let node: Element | null = el; node && node !== log; node = node.parentElement) {
      if (node.getAttribute("aria-hidden") === "true") return false;
    }
    return true;
  }

  it("o relógio do turno não é anunciado: nem a barra do topo, nem a linha do fim", async () => {
    renderSdkChat();
    const ws = await socket();
    ws.accept();
    ws.deliver({ type: "ready" });
    ws.deliver({ type: "thinking_delta", text: "pensando…" });

    expect(announcedInLog(screen.getByTestId("sdk-activity-elapsed"))).toBe(false);
    expect(announcedInLog(screen.getByTestId("sdk-chat-working"))).toBe(false);
  });

  it("a FASE vai para uma região de status fora do log — sem o relógio", async () => {
    renderSdkChat();
    const ws = await socket();
    ws.accept();
    ws.deliver({ type: "ready" });
    const status = screen.getByTestId("sdk-working-status");
    expect(status).toHaveAttribute("role", "status");
    expect(screen.getByRole("log").contains(status)).toBe(false);
    expect(status).toHaveTextContent("");

    ws.deliver({ type: "thinking_delta", text: "pensando…" });
    expect(status).toHaveTextContent(/Pensando|Thinking/);
    expect(status.textContent).not.toMatch(/\d/);

    ws.deliver({ type: "result", isError: false });
    expect(status).toHaveTextContent("");
  });

  it("o log fica OCUPADO enquanto um texto chega token a token — e é lido inteiro quando fecha", async () => {
    renderSdkChat();
    const ws = await socket();
    ws.accept();
    ws.deliver({ type: "ready" });
    const log = screen.getByRole("log");
    // `role="log"` is already a polite live region: the repeated `aria-live` said nothing more
    expect(log).not.toHaveAttribute("aria-live");
    expect(log).not.toHaveAttribute("aria-busy", "true");

    ws.deliver({ type: "assistant_delta", text: "Começ" });
    expect(log).toHaveAttribute("aria-busy", "true");

    ws.deliver({ type: "assistant_text", text: "Começando." });
    expect(log).not.toHaveAttribute("aria-busy", "true");
  });
});

/**
 * WHO IS DOING WHAT. What a subagent (Agent/Task) does arrives tagged with `parentToolUseId`
 * and is drawn INSIDE the card of the call that triggered it — collapsed, with how many actions have run and
 * the latest —, never as a step or answer of the main agent.
 */
describe("SdkChatView — subagentes", () => {
  const agentCall: SdkEvent = {
    type: "tool_use", id: "t1", name: "Agent", input: { description: "explora o chat", subagent_type: "Explore" },
  };

  it("o tempo do subagente rodando anda sozinho, sem esperar progresso novo do CLI", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      renderSdkChat();
      const ws = await socket();
      ws.accept();
      ws.deliver({ type: "ready" });
      ws.deliver(agentCall);
      // the runner's clock does not come in: a startedAt from another clock does not change what the screen shows
      ws.deliver({ type: "agent_task", toolUseId: "t1", taskId: "k1", status: "running", toolUses: 18, durationMs: 186_000, startedAt: 1 });
      const agent = within(screen.getByTestId("sdk-fleet")).getByTestId("sdk-fleet-agent");
      // the real clock also moves with `shouldAdvanceTime`: a slow runner may add a second
      expect(agent).toHaveTextContent(/3m 0[67]s/);

      await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
      expect(agent).toHaveTextContent(/4m 0[67]s/);

      // the background strip shows the same clock
      ws.deliver({ type: "background_tasks", tasks: [{ id: "b1", type: "local_agent", description: "explora o chat", toolUseId: "t1" }] });
      expect(screen.getByTestId("sdk-background-task")).toHaveTextContent(/4m 0[678]s/);

      // the subagent modal counts along with the fleet row
      fireEvent.click(agent);
      expect(await screen.findByTestId("sdk-agent-elapsed")).toHaveTextContent(/4m 0[678]s/);
      await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
      expect(screen.getByTestId("sdk-agent-elapsed")).toHaveTextContent(/5m 0[6789]s/);

      // finished, the clock stops at the final duration
      ws.deliver({ type: "agent_task", toolUseId: "t1", taskId: "k1", status: "completed", toolUses: 20, durationMs: 250_000 });
      await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
      expect(agent).toHaveTextContent("4m 10s");
      expect(screen.getByTestId("sdk-agent-elapsed")).toHaveTextContent("4m 10s");
    } finally {
      vi.useRealTimers();
    }
  });

  it("o subagente vira uma linha da frota; o clique abre a linha do tempo dele, pedida ao back", async () => {
    renderSdkChat();
    const ws = await socket();
    ws.accept();
    ws.deliver({ type: "ready" });
    ws.deliver(agentCall);
    ws.deliver({ type: "tool_use", id: "c1", name: "Read", input: { file_path: "/w/sdkChat.ts" }, parentToolUseId: "t1" });
    ws.deliver({ type: "assistant_text", text: "achei o reducer", parentToolUseId: "t1" });
    ws.deliver({ type: "tool_use", id: "c2", name: "Grep", input: { pattern: "toolHeadline" }, parentToolUseId: "t1" });
    ws.deliver({ type: "agent_task", toolUseId: "t1", taskId: "k1", status: "running", toolUses: 2, summary: "Lendo o reducer" });

    const fleet = screen.getByTestId("sdk-fleet");
    const agent = within(fleet).getByTestId("sdk-fleet-agent");
    expect(agent).toHaveAttribute("data-status", "running");
    expect(agent).toHaveTextContent("explora o chat");
    expect(agent).toHaveTextContent("Lendo o reducer");
    expect(agent).toHaveTextContent("2 actions");
    // The subagent's actions do not show up as steps of the main agent.
    expect(screen.queryAllByTestId("sdk-tool")).toHaveLength(0);
    expect(screen.queryByText("achei o reducer")).toBeNull();

    fireEvent.click(agent);
    const dialog = await screen.findByTestId("sdk-detail");
    expect(dialog).toHaveAttribute("data-view", "agent");
    await waitFor(() => expect(ws.sent.map((f) => JSON.parse(f) as { type: string; req?: string; id?: string }).some((f) => f.type === "detail" && f.req === "agent" && f.id === "t1")).toBe(true));
    const ask = ws.sent.map((f) => JSON.parse(f) as { type: string; req?: string; nonce?: string }).find((f) => f.type === "detail" && f.req === "agent")!;
    ws.deliver({
      type: "detail", req: "agent", id: "t1", nonce: ask.nonce,
      data: { found: true, prompt: "Explore o chat", items: [
        { kind: "thinking", at: 1, text: "vou ler o reducer" },
        { kind: "tool", at: 2, id: "c1", name: "Read", input: { file_path: "/w/sdkChat.ts" }, result: { lines: 40 } },
        { kind: "text", at: 3, text: "achei o reducer" },
      ] },
    } as never);
    expect(await within(dialog).findByTestId("sdk-timeline-thinking")).toHaveTextContent("vou ler o reducer");
    expect(within(dialog).getByTestId("sdk-timeline-tool")).toHaveTextContent("Read(sdkChat.ts)");
    expect(within(dialog).getByTestId("sdk-timeline-tool")).toHaveTextContent("40 lines");
    expect(within(dialog).getByTestId("sdk-agent-now")).toHaveTextContent("Lendo o reducer");
  });

  it("o texto do subagente não vira resposta do agente principal", async () => {
    renderSdkChat();
    const ws = await socket();
    ws.accept();
    ws.deliver({ type: "ready" });
    ws.deliver(agentCall);
    ws.deliver({ type: "assistant_text", text: "relatório do subagente", parentToolUseId: "t1" });
    ws.deliver({ type: "assistant_text", text: "Resumo do principal." });

    const answers = screen.getAllByTestId("sdk-assistant");
    expect(answers).toHaveLength(1);
    expect(answers[0]).toHaveTextContent("Resumo do principal.");
  });

  it("um token da resposta do principal não redesenha a frota", () => {
    const row: SdkRow = { kind: "tool", id: "t1", name: "Agent", summary: "", input: {} };
    const kids: SdkRow[] = [{ kind: "tool", id: "c1", name: "Read", summary: "", parent: "t1" }];
    const children = new Map([["t1", kids]]);
    const tasks = {};
    const before = { rows: [row], tasks, children };
    expect(fleetPropsEqual(before, { rows: [row], tasks, children: new Map([["t1", kids]]) })).toBe(true);
    expect(fleetPropsEqual(before, { rows: [row], tasks, children: new Map([["t1", [...kids]]]) })).toBe(false);
    expect(fleetPropsEqual(before, { rows: [row], tasks: {}, children })).toBe(false);
  });

  it("a barra de atividade diz que é o subagente trabalhando", async () => {
    renderSdkChat();
    const ws = await socket();
    ws.accept();
    ws.deliver({ type: "ready" });
    ws.deliver({ type: "user", text: "investiga" });
    ws.deliver(agentCall);
    ws.deliver({ type: "tool_use", id: "c1", name: "Read", input: { file_path: "/w/sdkChat.ts" }, parentToolUseId: "t1" });
    expect(screen.getByTestId("sdk-activity-label")).toHaveTextContent("Subagent Explore: Read(sdkChat.ts)");
  });
});

/**
 * THE AGENT'S TASK LIST. A TodoWrite said only "TodoWrite"; now it says how many are done and
 * shows the list — only the MOST RECENT one open: the earlier ones are old versions of the same list.
 */
describe("SdkChatView — TodoWrite", () => {
  const todos = (statuses: Array<"pending" | "in_progress" | "completed">) => statuses.map((status, i) => ({
    content: `Tarefa ${i + 1}`, activeForm: `Fazendo a tarefa ${i + 1}`, status,
  }));

  it("o mais recente aparece aberto com a lista e o status de cada item; os anteriores, recolhidos", async () => {
    renderSdkChat();
    const ws = await socket();
    ws.accept();
    ws.deliver({ type: "ready" });
    ws.deliver({ type: "tool_use", id: "td1", name: "TodoWrite", input: { todos: todos(["in_progress", "pending", "pending"]) } });
    ws.deliver({ type: "assistant_text", text: "começando" });
    ws.deliver({ type: "tool_use", id: "td2", name: "TodoWrite", input: { todos: todos(["completed", "in_progress", "pending"]) } });

    const cards = screen.getAllByTestId("sdk-todos");
    expect(cards).toHaveLength(2);
    const [older, latest] = cards as [HTMLElement, HTMLElement];
    expect(within(older).getByTestId("sdk-todos-title")).toHaveTextContent("Tasks 0/3");
    expect(within(older).queryByTestId("sdk-todo-item")).toBeNull();

    expect(within(latest).getByTestId("sdk-todos-title")).toHaveTextContent("Tasks 1/3");
    const items = within(latest).getAllByTestId("sdk-todo-item");
    expect(items.map((item) => item.getAttribute("data-status"))).toEqual(["completed", "in_progress", "pending"]);
    expect(items[0]).toHaveClass("line-through");
    expect(items[1]).toHaveClass("font-semibold");
    expect(items[1]).toHaveTextContent("Fazendo a tarefa 2");
    expect(items[2]).toHaveTextContent("Tarefa 3");

    // Whoever wants to see the old version opens it.
    fireEvent.click(within(older).getByTestId("sdk-todos-toggle"));
    expect(within(older).getAllByTestId("sdk-todo-item")).toHaveLength(3);
  });
});

describe("SdkChatView — a tool call reads like the terminal's", () => {
  it("shows the headline and the detail under it, and says when work went to the background", async () => {
    renderSdkChat();
    const ws = await socket();
    ws.accept();
    ws.deliver({ type: "ready" });
    ws.deliver({
      type: "tool_use", id: "t1", name: "Bash",
      input: { description: "Measuring PDV module size", command: "ls && find src" },
    });
    expect(screen.getByTestId("sdk-tool-title")).toHaveTextContent("Measuring PDV module size");
    expect(screen.getByTestId("sdk-tool-detail")).toHaveTextContent("$ ls && find src");

    ws.deliver({ type: "tool_use", id: "t2", name: "Skill", input: { skill: "code-review" } });
    const details = screen.getAllByTestId("sdk-tool-detail");
    const last = details[details.length - 1] as HTMLElement;
    expect(last).toHaveTextContent("Running in the background");
    expect(last.getAttribute("data-background")).toBe("true");
  });
});

/**
 * THE QUEUE — what you write while Claude works.
 *
 * What these tests pin down, in the order the owner described: the message WAITS (it does not become a bubble and
 * does not go to the socket), it goes up into the conversation the instant it is delivered, it is editable
 * while it waits, and a message being edited CANNOT be delivered — not even if the turn ends in the middle
 * of the correction.
 */
describe("SdkChatView — a fila (mensagem escrita durante um turno)", () => {
  /** A chat with a turn visibly running and a message waiting in the queue. */
  async function chatWithQueued(text = "aproveita e ajusta o título") {
    renderSdkChat();
    const ws = await socket();
    ws.accept();
    ws.deliver({ type: "ready" });
    const box = (await screen.findByLabelText(/Enter/)) as HTMLTextAreaElement;
    await userEvent.type(box, `faz a tarefa{Enter}`);
    await waitFor(() => expect(ws.sent.length).toBe(1));
    ws.deliver({ type: "assistant_delta", text: "Fazendo…" }); // the turn is running
    await userEvent.type(box, `${text}{Enter}`);
    await screen.findByTestId("sdk-queue");
    return { ws, box };
  }

  it("com o turno rodando, a mensagem ESPERA: não vai pro socket e não vira bolha", async () => {
    const { ws } = await chatWithQueued();
    expect(ws.sent).toHaveLength(1); // only the first message was delivered
    expect(screen.getByTestId("sdk-queued")).toHaveTextContent("aproveita e ajusta o título");
    // the conversation has ONE user bubble — the one Claude actually read
    expect(screen.getAllByTestId("sdk-user")).toHaveLength(1);
    expect(screen.getByTestId("sdk-queue")).toHaveTextContent(/1 mensagem esperando|1 message waiting/);
  });

  it("quando o turno fecha, ela SOBE: vai pro socket, vira bolha e sai da fila", async () => {
    const { ws } = await chatWithQueued();
    ws.deliver({ type: "result", isError: false });

    await waitFor(() => expect(ws.sent.length).toBe(2));
    expect(JSON.parse(ws.sent[1]!)).toMatchObject({ type: "user", text: "aproveita e ajusta o título" });
    await waitFor(() => expect(screen.queryByTestId("sdk-queue")).toBeNull());
    const bubbles = screen.getAllByTestId("sdk-user");
    expect(bubbles[bubbles.length - 1]).toHaveTextContent("aproveita e ajusta o título");
  });

  it("UMA por vez: a segunda continua esperando enquanto a primeira roda", async () => {
    const { ws, box } = await chatWithQueued("primeiro isto");
    await userEvent.type(box, "depois aquilo{Enter}");
    await waitFor(() => expect(screen.getAllByTestId("sdk-queued")).toHaveLength(2));
    expect(screen.getByTestId("sdk-queue")).toHaveTextContent(/2 mensagens esperando|2 messages waiting/);

    ws.deliver({ type: "result", isError: false });
    await waitFor(() => expect(ws.sent.length).toBe(2));
    expect(JSON.parse(ws.sent[1]!)).toMatchObject({ text: "primeiro isto" });
    // the second did NOT go along: it waits for the turn the first one just opened
    expect(screen.getAllByTestId("sdk-queued")).toHaveLength(1);
    expect(screen.getByTestId("sdk-queued")).toHaveTextContent("depois aquilo");

    ws.deliver({ type: "result", isError: false });
    await waitFor(() => expect(ws.sent.length).toBe(3));
    expect(JSON.parse(ws.sent[2]!)).toMatchObject({ text: "depois aquilo" });
  });

  it("o X tira da fila: essa mensagem nunca chega ao Claude", async () => {
    const { ws } = await chatWithQueued();
    await userEvent.click(screen.getByTestId("sdk-queued-remove"));
    expect(screen.queryByTestId("sdk-queue")).toBeNull();

    ws.deliver({ type: "result", isError: false });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(ws.sent).toHaveLength(1);
  });

  it("o lápis traz a mensagem pro campo — e ela GUARDA o lugar dela na fila", async () => {
    const { ws } = await chatWithQueued();
    await userEvent.click(screen.getByTestId("sdk-queued-edit"));

    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("aproveita e ajusta o título");
    expect(screen.getByTestId("composer-editing")).toHaveTextContent(/fila|queued/);
    // it stays in the queue, flagged: that is what makes an F5 give the text back instead of erasing it
    expect(screen.getByTestId("sdk-queued")).toHaveAttribute("data-editing", "true");
    expect(screen.getByTestId("sdk-queued-editing")).toBeInTheDocument();
    expect(screen.queryByTestId("sdk-queued-edit")).toBeNull(); // the field is in charge now
    // and the text is NOT in the conversation: Claude still has not read any of this
    expect(screen.getAllByTestId("sdk-user")).toHaveLength(1);
    expect(ws.sent).toHaveLength(1);
  });

  it("editar a PRIMEIRA não segura a segunda: o despacho pula só quem está no campo", async () => {
    const { ws, box } = await chatWithQueued("primeiro isto");
    await userEvent.type(box, "depois aquilo{Enter}");
    await waitFor(() => expect(screen.getAllByTestId("sdk-queued")).toHaveLength(2));
    await userEvent.click(screen.getAllByTestId("sdk-queued-edit")[0]!);

    ws.deliver({ type: "result", isError: false });
    await waitFor(() => expect(ws.sent.length).toBe(2));
    expect(JSON.parse(ws.sent[1]!)).toMatchObject({ text: "depois aquilo" });
    expect(screen.getByTestId("sdk-queued")).toHaveAttribute("data-editing", "true");
  });

  it("clicar o lápis de outra devolve a primeira à fila — nenhuma mensagem se perde", async () => {
    const { box } = await chatWithQueued("primeiro isto");
    await userEvent.type(box, "depois aquilo{Enter}");
    await waitFor(() => expect(screen.getAllByTestId("sdk-queued")).toHaveLength(2));

    await userEvent.click(screen.getAllByTestId("sdk-queued-edit")[0]!);
    await userEvent.click(screen.getByTestId("sdk-queued-edit")); // the only visible one now is the other

    const rows = screen.getAllByTestId("sdk-queued");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent("primeiro isto");
    expect(rows[0]).not.toHaveAttribute("data-editing");
    expect(rows[1]).toHaveAttribute("data-editing", "true");
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("depois aquilo");
  });

  it("EM EDIÇÃO ela não é entregue, nem quando o turno acaba no meio da correção", async () => {
    const { ws } = await chatWithQueued();
    await userEvent.click(screen.getByTestId("sdk-queued-edit"));

    ws.deliver({ type: "result", isError: false }); // Claude became free in the middle of the typing
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(ws.sent).toHaveLength(1); // nothing went out: the message is in the field, being rewritten

    const box = screen.getByRole("textbox") as HTMLTextAreaElement;
    await userEvent.type(box, " e o subtítulo{Enter}");
    await waitFor(() => expect(ws.sent.length).toBe(2));
    expect(JSON.parse(ws.sent[1]!)).toMatchObject({
      type: "user",
      text: "aproveita e ajusta o título e o subtítulo",
    });
    expect(screen.queryByTestId("composer-editing")).toBeNull();
  });

  it("editada com o turno AINDA rodando, ela volta pra fila (e não pro socket)", async () => {
    const { ws } = await chatWithQueued();
    await userEvent.click(screen.getByTestId("sdk-queued-edit"));
    await userEvent.type(screen.getByRole("textbox"), " agora{Enter}");

    await waitFor(() => expect(screen.getByTestId("sdk-queued")).toHaveTextContent("aproveita e ajusta o título agora"));
    expect(ws.sent).toHaveLength(1);
    expect(screen.getAllByTestId("sdk-queued")).toHaveLength(1); // it comes back as ONE, not as a copy
    expect(screen.getByTestId("sdk-queued")).not.toHaveAttribute("data-editing");
  });

  it("cancelar a edição devolve a mensagem à fila, intacta", async () => {
    const { ws } = await chatWithQueued();
    await userEvent.click(screen.getByTestId("sdk-queued-edit"));
    await userEvent.type(screen.getByRole("textbox"), " e mais isto");
    await userEvent.click(screen.getByTestId("composer-editing-cancel"));

    expect(screen.getByTestId("sdk-queued")).toHaveTextContent("aproveita e ajusta o título");
    expect(screen.getByTestId("sdk-queued")).not.toHaveTextContent("e mais isto");
    expect(screen.getByTestId("sdk-queued")).not.toHaveAttribute("data-editing");
    expect(ws.sent).toHaveLength(1);
  });

  it("cancelar NÃO reordena: a corrigida continua na frente de quem chegou depois", async () => {
    const { ws, box } = await chatWithQueued("primeiro isto");
    await userEvent.type(box, "depois aquilo{Enter}");
    await waitFor(() => expect(screen.getAllByTestId("sdk-queued")).toHaveLength(2));

    await userEvent.click(screen.getAllByTestId("sdk-queued-edit")[0]!);
    await userEvent.click(screen.getByTestId("composer-editing-cancel"));

    ws.deliver({ type: "result", isError: false });
    await waitFor(() => expect(ws.sent.length).toBe(2));
    expect(JSON.parse(ws.sent[1]!)).toMatchObject({ text: "primeiro isto" });
  });

  it("a seta pra cima num campo vazio abre a ÚLTIMA da fila pra edição", async () => {
    const { box } = await chatWithQueued("primeiro isto");
    await userEvent.type(box, "depois aquilo{Enter}");
    await waitFor(() => expect(screen.getAllByTestId("sdk-queued")).toHaveLength(2));

    await userEvent.type(box, "{ArrowUp}");
    expect(box.value).toBe("depois aquilo");
    const rows = screen.getAllByTestId("sdk-queued");
    expect(rows[1]).toHaveAttribute("data-editing", "true"); // keeps its place, in the field
    expect(rows[0]).not.toHaveAttribute("data-editing");
  });

  it("com uma PERGUNTA parada, o recado solto também vai na hora (senão nada destrava o turno)", async () => {
    renderSdkChat();
    const ws = await socket();
    ws.accept();
    ws.deliver({ type: "ready" });
    // AskUserQuestion: the driver stays blocked waiting, with the turn still counted as active —
    // and the only thing that releases it is a message from the user. Queuing here would lock until the timeout.
    ws.deliver({
      type: "user_question",
      id: "q1",
      questions: [{ question: "Qual dos dois?", header: "Caminho", options: [{ label: "A" }, { label: "B" }], multiSelect: false }],
    });
    await screen.findByTestId("pending-tray");

    // the chat field, not the "outra resposta" of the question card itself
    await userEvent.type(screen.getByLabelText(/Enter/), "manda o A{Enter}");
    await waitFor(() => expect(ws.sent.length).toBe(1));
    expect(screen.queryByTestId("sdk-queue")).toBeNull();
  });

  it("responder uma decisão pendente NUNCA espera: é ela que destrava o turno", async () => {
    renderSdkChat();
    const ws = await socket();
    ws.accept();
    ws.deliver({ type: "ready" });
    ws.deliver({ type: "assistant_text", text: "Fiz A e B.\n\nQual dos dois você prefere?" });
    // the turn stays OPEN — it is the case where the agent asks and stays waiting inside the turn
    await userEvent.click(await screen.findByTestId("pending-tray-item"));
    await userEvent.type(screen.getByRole("textbox"), "o B{Enter}");

    await waitFor(() => expect(ws.sent.length).toBe(1));
    expect(JSON.parse(ws.sent[0]!).text).toContain("o B");
    expect(screen.queryByTestId("sdk-queue")).toBeNull();
  });

  /**
   * ONE FIELD, ONE MODE. Correcting one from the queue, correcting a sent bubble and answering a decision are
   * three gestures that compete for the SAME text field — entering one has to leave the others. The queue's
   * pencil already released the other two, but the bubble's pencil and the decisions tray did not release the
   * queue: the next Enter fell into `queueEdit` (tested first) and the bubble's correction was written
   * OVER the message waiting in the queue, which vanished without anyone having asked.
   */
  it("o lápis de uma bolha ENVIADA solta a da fila: a correção não grava por cima dela", async () => {
    const { ws, box } = await chatWithQueued();
    await userEvent.click(screen.getByTestId("sdk-queued-edit"));
    await userEvent.click(screen.getByTestId("sdk-edit")); // changed my mind: corrects the sent one
    expect(box.value).toBe("faz a tarefa");

    await userEvent.clear(box);
    await userEvent.type(box, "faz a outra tarefa{Enter}");

    // the bubble's correction followed its own path (it stops the turn, and goes after the result)…
    await waitFor(() => expect(ws.sent.length).toBe(2));
    expect(JSON.parse(ws.sent[1]!)).toEqual({ type: "interrupt", reason: "edit" });
    // …and the queued one is intact, back to waiting
    expect(screen.getByTestId("sdk-queued")).toHaveTextContent("aproveita e ajusta o título");
    expect(screen.getByTestId("sdk-queued")).not.toHaveTextContent("faz a outra tarefa");
    expect(screen.getByTestId("sdk-queued")).not.toHaveAttribute("data-editing");
  });

  it("responder uma decisão pela bandeja solta a da fila: a resposta não grava por cima dela", async () => {
    const { ws, box } = await chatWithQueued();
    await userEvent.click(screen.getByTestId("sdk-queued-edit"));
    // In the middle of the correction an AskUserQuestion arrives (the queued one, in the field, is not dispatched).
    ws.deliver({
      type: "user_question",
      id: "q_1",
      questions: [{ question: "Formato do relatório?", options: [{ label: "Resumo" }, { label: "Detalhado" }] }],
    });
    await userEvent.click(await screen.findByTestId("pending-tray-item"));
    expect(screen.queryByTestId("composer-editing")).toBeNull(); // the field now ANSWERS

    await userEvent.clear(box);
    await userEvent.type(box, "em tabela{Enter}");

    await waitFor(() => expect(ws.sent.some((raw) => JSON.parse(raw).type === "question_answer")).toBe(true));
    const frames = ws.sent.map((raw) => JSON.parse(raw) as { type: string; text?: string });
    expect(frames).toContainEqual({ type: "question_answer", id: "q_1", answers: [{ selected: ["em tabela"] }] });
    // the queued one became deliverable again with ITS text — and the answered question opens the breather,
    // so it goes out right after, intact
    await waitFor(() => expect(ws.sent.map((raw) => JSON.parse(raw) as { text?: string }))
      .toContainEqual(expect.objectContaining({ type: "user", text: "aproveita e ajusta o título" })));
    expect(frames.filter((f) => f.type === "user").map((f) => f.text)).not.toContain("em tabela");
  });
});

/**
 * THE LAYOUT BUG (production, 2026-09-28): "a big message breaks the layout, it is in the queue and I
 * cannot scroll up to see what is being said".
 *
 * The queue tray lives between the conversation and the text field, as a SIBLING of the conversation scroller
 * in a flex column. The waiting message's text was drawn in full, with no ceiling — so a
 * two-hundred-line instruction stretched the tray until it took the whole screen, and the scroller
 * (`min-h-0 flex-1`) was squeezed almost to zero. The conversation did not vanish: it was pushed
 * out, and with it the only way to follow what the agent was saying.
 *
 * The rule: waiting can never steal the screen from the conversation. The tray has a CEILING and its own scrolling, and
 * each waiting message does too — a giant one scrolls inside its own place instead of pushing the
 * others (and the pencil is still the way to read it in full, in the field).
 *
 * jsdom does not compute layout, so what can be pinned here is the RULE: both elements carry
 * a height ceiling and their own scrolling, and the tray stays OUTSIDE the conversation scroller.
 */
describe("SdkChatView — a fila não rouba a tela da conversa", () => {
  /** A real instruction, the size of the ones that broke the layout. */
  const HUGE = Array.from({ length: 120 }, (_, i) => `linha ${i + 1} da instrução gigante`).join("\n");

  async function queueHuge() {
    renderSdkChat();
    const ws = await socket();
    ws.accept();
    ws.deliver({ type: "ready" });
    const box = screen.getByTestId("terminal-composer").querySelector("textarea")!;
    await userEvent.type(box, "primeira{Enter}");
    await waitFor(() => expect(ws.sent.length).toBe(1));
    ws.deliver({ type: "assistant_delta", text: "trabalhando…" }); // turn running: the rest waits
    fireEvent.change(box, { target: { value: HUGE } });
    fireEvent.keyDown(box, { key: "Enter" });
    await screen.findByTestId("sdk-queued");
    return ws;
  }

  it("a bandeja da fila tem teto de altura e rolagem própria", async () => {
    await queueHuge();
    const tray = screen.getByTestId("sdk-queue");
    expect(tray.className).toMatch(/max-h-/); // without a ceiling it grows until it swallows the conversation
    expect(tray.className).toMatch(/overflow-y-auto/); // and what does not fit scrolls IN HERE
  });

  it("uma mensagem em espera gigante rola dentro do lugar dela, sem empurrar as outras", async () => {
    await queueHuge();
    const body = screen.getByTestId("sdk-queued-text");
    expect(body.className).toMatch(/max-h-/);
    expect(body.className).toMatch(/overflow-y-auto/);
    expect(body).toHaveTextContent("linha 1 da instrução gigante"); // and the text is still whole
    expect(body).toHaveTextContent("linha 120 da instrução gigante");
  });

  const CARD = "2f76af45-3e76-4e32-a49d-bc30b799713d";
  const shot = (file: string) => `/work/.uploads/${CARD}/${file}`;

  /** A turn running and `text` waiting in the queue. Returns the field, for whoever wants to edit. */
  async function queueText(text: string) {
    renderSdkChat();
    const ws = await socket();
    ws.accept();
    ws.deliver({ type: "ready" });
    const box = screen.getByTestId("terminal-composer").querySelector("textarea")!;
    await userEvent.type(box, "primeira{Enter}");
    await waitFor(() => expect(ws.sent.length).toBe(1));
    ws.deliver({ type: "assistant_delta", text: "trabalhando…" });
    fireEvent.change(box, { target: { value: text } });
    fireEvent.keyDown(box, { key: "Enter" });
    await screen.findByTestId("sdk-queued");
    return box;
  }

  it("uma imagem anexada na mensagem em espera aparece como miniatura, não como caminho", async () => {
    await queueText(`olha esse erro ${shot("1792422236057-image.png")}`);
    const body = screen.getByTestId("sdk-queued-text");
    const image = within(body).getByTestId("chat-image");
    expect(image).toHaveAttribute("src", `/api/cards/${CARD}/uploads/1792422236057-image.png`);
    // FIXED height (not max): the image arriving later does not stretch the tray nor hide the conversation
    expect(image.className).toMatch(/\bh-16\b/);
    expect(image.closest("a")!.className).toMatch(/inline-block/); // two side by side, not stacked
    expect(body).toHaveTextContent("olha esse erro");
    expect(body).not.toHaveTextContent("/work/.uploads");
  });

  it("duas imagens na mesma mensagem viram duas miniaturas", async () => {
    await queueText(`compara ${shot("1-a.png")} ${shot("2-b.png")}`);
    expect(within(screen.getByTestId("sdk-queued-text")).getAllByTestId("chat-image")).toHaveLength(2);
  });

  it("imagem que não carrega na fila volta a ser o caminho — nunca o ícone de imagem quebrada", async () => {
    await queueText(`olha ${shot("1-sumiu.png")}`);
    fireEvent.error(within(screen.getByTestId("sdk-queued-text")).getByTestId("chat-image"));
    await waitFor(() => expect(screen.queryByTestId("chat-image")).not.toBeInTheDocument());
    expect(screen.getByTestId("sdk-queued-text")).toHaveTextContent(shot("1-sumiu.png"));
  });

  it("editar a mensagem trocando a imagem não herda a falha da imagem anterior", async () => {
    const box = await queueText(`olha ${shot("1-sumiu.png")}`);
    fireEvent.error(within(screen.getByTestId("sdk-queued-text")).getByTestId("chat-image"));
    await waitFor(() => expect(screen.queryByTestId("chat-image")).not.toBeInTheDocument());
    await userEvent.click(screen.getByTestId("sdk-queued-edit"));
    fireEvent.change(box, { target: { value: `olha ${shot("2-nova.png")}` } });
    fireEvent.keyDown(box, { key: "Enter" });
    const image = await within(screen.getByTestId("sdk-queued-text")).findByTestId("chat-image");
    expect(image).toHaveAttribute("src", `/api/cards/${CARD}/uploads/2-nova.png`);
  });

  it("na fila, ultrathink é texto comum — a pintura é só do campo e da bolha", async () => {
    await queueText("ultrathink sobre isso");
    expect(screen.getByTestId("sdk-queued-text").querySelector(".vh-ultra-char")).toBeNull();
  });

  it("a bandeja fica FORA do scroller da conversa — ela não é uma linha do histórico", async () => {
    await queueHuge();
    const scroller = screen.getByTestId("sdk-chat-scroller");
    expect(scroller.contains(screen.getByTestId("sdk-queue"))).toBe(false);
    // and the scroller is still what scrolls the conversation
    expect(scroller.className).toMatch(/overflow-y-auto/);
    expect(scroller.className).toMatch(/min-h-0/); // what keeps it from being squeezed to zero
  });
});

/**
 * "FORÇAR ENVIO" (César's request, 2026-09-28): "I send the message to you, you are still in the
 * turn but you can receive the message a few seconds or minutes later — and there is no option to force
 * send, to send the queued message right away for the AI to receive".
 *
 * The queue waits for the turn to CLOSE, and that is the right rule by default: a message folded into the middle of
 * an ongoing line of reasoning comes in as a context interruption, not as a new question. But waiting
 * is not always what the person wants — sometimes the note is precisely for now ("para, tá errado",
 * "o que você tá fazendo?"), and the driver ACCEPTS that: the message enters the turn in progress and comes back
 * flagged "entrou no turno em andamento" (the `turn_absorbed`).
 *
 * So waiting becomes a CHOICE, not a sentence: each queued message carries the gesture of
 * overriding the wait and going now.
 */
describe("SdkChatView — forçar o envio de uma mensagem da fila", () => {
  async function queueOne(text = "o que você tá fazendo ?") {
    renderSdkChat();
    const ws = await socket();
    ws.accept();
    ws.deliver({ type: "ready" });
    const box = screen.getByTestId("terminal-composer").querySelector("textarea")!;
    await userEvent.type(box, "primeira{Enter}");
    await waitFor(() => expect(ws.sent.length).toBe(1));
    ws.deliver({ type: "assistant_delta", text: "trabalhando…" }); // turn running: the rest waits
    await userEvent.type(box, `${text}{Enter}`);
    await screen.findByTestId("sdk-queued");
    return ws;
  }

  it("o gesto existe em cada mensagem que espera", async () => {
    await queueOne();
    expect(screen.getByTestId("sdk-queued-send-now")).toBeInTheDocument();
  });

  it("clicar nele manda a mensagem AGORA, no meio do turno — ela sai da fila e vira bolha", async () => {
    const ws = await queueOne();

    await userEvent.click(screen.getByTestId("sdk-queued-send-now"));

    await waitFor(() => expect(ws.sent.length).toBe(2));
    // `now`: with a tool stuck the driver interrupts so it is read right away (see sendUserNow)
    expect(JSON.parse(ws.sent[1]!)).toMatchObject({ type: "user", text: "o que você tá fazendo ?", now: true });
    // it left the wait and became conversation: that is what "was delivered" means on this screen
    await waitFor(() => expect(screen.queryByTestId("sdk-queued")).not.toBeInTheDocument());
    const bubbles = screen.getAllByTestId("sdk-user");
    expect(bubbles[bubbles.length - 1]).toHaveTextContent("o que você tá fazendo ?");
  });

  /**
   * "ONDE EU CLICO EM ENVIAR AGORA?" (César, 2026-09-28) — the question that condemns a gesture.
   *
   * The queue's three buttons were born copying the pattern of the conversation rows: `md:opacity-0
   * md:group-hover:opacity-100`, that is, invisible on desktop until the mouse passes over them. For
   * a gesture one already knows that is discretion; for one that has just come to exist it is the same as not
   * having been made. And "manda agora" is precisely the gesture in a HURRY — whoever wants to override the wait
   * will not hunt for a hidden icon.
   *
   * The queue tray is not the conversation: it only shows up when something is waiting, and it already exists to
   * draw attention. Here the gestures stay in sight.
   */
  it("os gestos da fila ficam À VISTA — não escondidos atrás do hover", async () => {
    await queueOne();
    for (const id of ["sdk-queued-send-now", "sdk-queued-edit", "sdk-queued-remove"]) {
      expect(screen.getByTestId(id).className).not.toMatch(/opacity-0/);
    }
  });

  it("o gesto de mandar agora tem RÓTULO, não só um ícone para adivinhar", async () => {
    await queueOne();
    expect(screen.getByTestId("sdk-queued-send-now")).toHaveTextContent(/agora|now/i);
  });

  it("a mensagem que está NO CAMPO sendo reescrita não oferece o gesto (ela está cancelada)", async () => {
    await queueOne();
    await userEvent.click(screen.getByTestId("sdk-queued-edit"));
    await screen.findByTestId("sdk-queued-editing");
    expect(screen.queryByTestId("sdk-queued-send-now")).not.toBeInTheDocument();
  });

  it("sem fio, forçar não perde a mensagem: ela CONTINUA na fila", async () => {
    const ws = await queueOne();
    act(() => { ws.readyState = 3; ws.onclose?.(); }); // the wire dropped before the click

    await userEvent.click(screen.getByTestId("sdk-queued-send-now"));

    expect(ws.sent.length).toBe(1); // nothing went out
    expect(screen.getByTestId("sdk-queued")).toHaveTextContent("o que você tá fazendo ?"); // and it stays saved
    expect(screen.queryByTestId("sdk-user-undelivered")).not.toBeInTheDocument(); // no condemned bubble
  });
});

/**
 * THE QUEUE MOVES ON THE BREATHER (César's request, 2026-09-28): "in Cursor and in Claude Code the messages
 * stay there while it is working, but when it is calm it pulls the messages".
 *
 * Before this the queue waited for the `result` — the end of the whole turn. A fifteen-minute turn
 * held back a "para, tá errado" for fifteen minutes, and the person kept looking at their own message
 * sitting there while the agent went on down the wrong path. Now it goes out on the first CLOSED block: the
 * turn keeps standing, and the message enters it through streaming input.
 */
/**
 * THE TURN'S BREATHER — and what it CANNOT be (production, 13/10/2026: "I hand over a task and see that
 * it takes a while").
 *
 * The queue moves on the breather, not only at the end of the turn. But "breather" is not "nothing running": the
 * newest line of a working turn is almost always a TOOL, which is exactly where the time
 * goes — measured on a real transcript of this panel, 11s median from a tool call to
 * the next closed block, 31s at p90, 71s in the worst case. Waiting that long with the wire up and the CLI
 * ready was the slowness the owner saw. A breather is the absence of a HALF-FINISHED SENTENCE: text or
 * reasoning streaming, wait; tool in progress, go — the CLI queues it and the model reads it on the next
 * step (see `turnHasRoomForMore`).
 */
describe("SdkChatView — a fila anda no respiro do turno, não só no fim", () => {
  it("ferramenta rodando: a mensagem SOBE na hora — é aí que o turno passa o tempo dele", async () => {
    renderSdkChat();
    const ws = await socket();
    ws.accept();
    ws.deliver({ type: "ready" });
    const box = screen.getByTestId("terminal-composer").querySelector("textarea")!;
    await userEvent.type(box, "primeira{Enter}");
    await waitFor(() => expect(ws.sent.length).toBe(1));
    ws.deliver({ type: "assistant_delta", text: "vou olhar" });
    ws.deliver({ type: "assistant_text", text: "vou olhar" });
    ws.deliver({ type: "tool_use", id: "t1", name: "Bash", input: { command: "npm test" } });

    // written WITH the tool already running: none of this is a half-finished sentence
    await userEvent.type(box, "o que você tá fazendo ?{Enter}");

    await waitFor(() => expect(ws.sent.length).toBe(2));
    expect(JSON.parse(ws.sent[1]!)).toMatchObject({ type: "user", text: "o que você tá fazendo ?" });
    await waitFor(() => expect(screen.queryByTestId("sdk-queued")).not.toBeInTheDocument());
    // and none of this needed the end of the turn: NO `result` was delivered in this conversation
    expect(screen.getByTestId("sdk-chat-working")).toBeInTheDocument();
  });

  it("texto ainda escorrendo: ESPERA — e o bloco fechado a solta, sem o turno ter acabado", async () => {
    renderSdkChat();
    const ws = await socket();
    ws.accept();
    ws.deliver({ type: "ready" });
    const box = screen.getByTestId("terminal-composer").querySelector("textarea")!;
    await userEvent.type(box, "primeira{Enter}");
    await waitFor(() => expect(ws.sent.length).toBe(1));
    ws.deliver({ type: "assistant_delta", text: "vou olhar" });

    await userEvent.type(box, "o que você tá fazendo ?{Enter}");
    await screen.findByTestId("sdk-queued");
    expect(ws.sent.length).toBe(1); // in the middle of a sentence, no

    ws.deliver({ type: "assistant_text", text: "os testes passaram" }); // the breather

    await waitFor(() => expect(ws.sent.length).toBe(2));
    expect(JSON.parse(ws.sent[1]!)).toMatchObject({ type: "user", text: "o que você tá fazendo ?" });
    await waitFor(() => expect(screen.queryByTestId("sdk-queued")).not.toBeInTheDocument());
  });

  it("uma por vez: o respiro entrega UMA, as outras seguem esperando o próximo", async () => {
    renderSdkChat();
    const ws = await socket();
    ws.accept();
    ws.deliver({ type: "ready" });
    const box = screen.getByTestId("terminal-composer").querySelector("textarea")!;
    await userEvent.type(box, "primeira{Enter}");
    await waitFor(() => expect(ws.sent.length).toBe(1));
    ws.deliver({ type: "assistant_delta", text: "vou olhar" });

    await userEvent.type(box, "recado um{Enter}");
    await userEvent.type(box, "recado dois{Enter}");
    await waitFor(() => expect(screen.getAllByTestId("sdk-queued")).toHaveLength(2));

    ws.deliver({ type: "assistant_text", text: "os testes passaram" }); // a breather
    ws.deliver({ type: "turn_absorbed" }); // the driver confirms the fold of the first one

    await waitFor(() => expect(ws.sent.length).toBe(2));
    expect(JSON.parse(ws.sent[1]!)).toMatchObject({ text: "recado um" });
    // the second did NOT go along: the newest line is the one that went up, and the model has not reacted yet
    expect(screen.getAllByTestId("sdk-queued")).toHaveLength(1);
    expect(screen.getByTestId("sdk-queued")).toHaveTextContent("recado dois");

    // the model's next step is the reaction — and it is what opens the breather for the next one
    ws.deliver({ type: "tool_use", id: "t1", name: "Bash", input: { command: "npm test" } });
    await waitFor(() => expect(ws.sent.length).toBe(3));
    expect(JSON.parse(ws.sent[2]!)).toMatchObject({ text: "recado dois" });
  });
});

/**
 * "PARECE MENSAGEM GENÉRICA" (César, 2026-09-28): what showed up most in a long turn was
 * "ferramenta demorada, ainda rodando" — the same sentence for any tool, picked by a
 * table from the clock. The model's reasoning and the description it wrote itself for the
 * command were one step away, in the state, and never reached the screen.
 *
 * Now the model's word beats the canned sentence. The canned one still exists for when there is
 * nothing to say — the "Preparando…" of a session starting up has no reasoning at all to show.
 */
describe("SdkChatView — o indicador diz o que a IA está dizendo", () => {
  it("ferramenta rodando: mostra a descrição do AGENTE, não 'rodando ferramenta'", async () => {
    renderSdkChat();
    const ws = await socket();
    ws.accept();
    ws.deliver({ type: "ready" });
    const box = screen.getByTestId("terminal-composer").querySelector("textarea")!;
    await userEvent.type(box, "mede o pdv{Enter}");
    ws.deliver({
      type: "tool_use",
      id: "t1",
      name: "Bash",
      input: { description: "Medindo o tamanho do módulo PDV", command: "du -sh src/pdv" },
    } as SdkEvent);

    const note = await screen.findByTestId("sdk-working-note");
    expect(note).toHaveTextContent("Medindo o tamanho do módulo PDV");
    expect(note).not.toHaveTextContent(/rodando ferramenta|ferramenta demorada/);
  });

  it("pensando: mostra a última linha do raciocínio, que é a que está mudando", async () => {
    renderSdkChat();
    const ws = await socket();
    ws.accept();
    ws.deliver({ type: "ready" });
    const box = screen.getByTestId("terminal-composer").querySelector("textarea")!;
    await userEvent.type(box, "investiga{Enter}");
    ws.deliver({ type: "thinking_delta", text: "Primeiro vou ler o teste que falhou.\n" } as SdkEvent);
    ws.deliver({ type: "thinking_delta", text: "Agora vou conferir se o índice existe" } as SdkEvent);

    const note = await screen.findByTestId("sdk-working-note");
    expect(note).toHaveTextContent("Agora vou conferir se o índice existe");
  });

  it("o relógio continua ali — saber há quanto tempo é metade da informação", async () => {
    renderSdkChat();
    const ws = await socket();
    ws.accept();
    ws.deliver({ type: "ready" });
    const box = screen.getByTestId("terminal-composer").querySelector("textarea")!;
    await userEvent.type(box, "investiga{Enter}");
    ws.deliver({ type: "thinking_delta", text: "conferindo o índice" } as SdkEvent);

    expect(await screen.findByTestId("sdk-working-note")).toHaveTextContent(/\ds/);
  });

  it("sem palavra do modelo ('Preparando…'), a frase enlatada segue valendo", async () => {
    renderSdkChat();
    const ws = await socket();
    ws.accept();
    const box = screen.getByTestId("terminal-composer").querySelector("textarea")!;
    await userEvent.type(box, "sobe pra prod{Enter}"); // no `ready`: the session is still starting up
    // forced by the person, it goes out anyway — and the session has nothing to say yet
    await userEvent.click(screen.getByTestId("sdk-queued-send-now"));
    await waitFor(() => expect(ws.sent.length).toBe(1));

    expect(await screen.findByTestId("sdk-working-note")).toHaveTextContent(/preparando a sessão|preparing the session/i);
  });
});

describe("SdkChatView — o painel da frota do Workflow", () => {
  const SCRIPT = [
    "export const meta = {",
    "  name: 'auditoria-do-pdv',",
    "  description: 'Varre o PDV atrás de bugs e verifica cada achado',",
    "  phases: [{ title: 'Achar' }, { title: 'Verificar' }],",
    "}",
  ].join("\n");

  async function fleetOnScreen() {
    renderSdkChat();
    const ws = await socket();
    ws.accept();
    ws.deliver({ type: "ready" });
    ws.deliver({ type: "tool_use", id: "t1", name: "Workflow", input: { script: SCRIPT } });
    ws.deliver({ type: "assistant_text", text: "Disparei a frota — te trago quando voltar." });
    ws.deliver({ type: "result" });
    return ws;
  }

  it("desenha a frota em movimento: nome, plano, contagem e barra", async () => {
    const ws = await fleetOnScreen();
    ws.deliver({
      type: "workflow_progress",
      runId: "wf_1",
      name: "auditoria-do-pdv",
      at: 1,
      finished: false,
      agents: [
        { id: "a1", label: "achar bugs em pdv/caixa", status: "done", result: "2 bugs: estoque negativo e troco" },
        { id: "a2", label: "achar bugs em pdv/pagamento", status: "running" },
      ],
    });
    const card = await screen.findByTestId("sdk-workflow");
    expect(card).toHaveAttribute("data-run", "wf_1");
    expect(card).not.toHaveAttribute("data-finished");
    expect(screen.getByTestId("sdk-workflow-count")).toHaveTextContent(/1\/2/);
    expect(card).toHaveTextContent("auditoria-do-pdv");
    expect(card).toHaveTextContent("Varre o PDV atrás de bugs");
    expect(screen.getByTestId("sdk-workflow-phases")).toHaveTextContent("Achar");
    expect(screen.getByTestId("sdk-workflow-bar")).toHaveStyle({ width: "50%" });
    expect(screen.getAllByTestId("sdk-workflow-agent")).toHaveLength(2);
  });

  it("clicar num subagente mostra o que ele devolveu", async () => {
    const ws = await fleetOnScreen();
    ws.deliver({
      type: "workflow_progress",
      runId: "wf_1",
      name: "auditoria-do-pdv",
      at: 1,
      finished: false,
      agents: [{ id: "a1", label: "achar bugs em pdv/caixa", status: "done", result: "2 bugs: estoque negativo e troco" }],
    });
    const agent = await screen.findByTestId("sdk-workflow-agent");
    expect(screen.queryByTestId("sdk-workflow-result")).toBeNull();
    await userEvent.click(agent);
    expect(await screen.findByTestId("sdk-workflow-result")).toHaveTextContent("estoque negativo");
    await userEvent.click(agent); // and closes again
    expect(screen.queryByTestId("sdk-workflow-result")).toBeNull();
  });

  it("um subagente ainda rodando diz isso em vez de mentir um resultado", async () => {
    const ws = await fleetOnScreen();
    ws.deliver({
      type: "workflow_progress", runId: "wf_1", name: "auditoria-do-pdv", at: 1, finished: false,
      agents: [{ id: "a2", label: "achar bugs em pdv/pagamento", status: "running" }],
    });
    await userEvent.click(await screen.findByTestId("sdk-workflow-agent"));
    expect(await screen.findByTestId("sdk-workflow-result")).toHaveTextContent(/ainda trabalhando|still working/);
  });

  it("terminada, a frota se recolhe sozinha e vira uma linha de resumo", async () => {
    const ws = await fleetOnScreen();
    const run = {
      type: "workflow_progress" as const, runId: "wf_1", name: "auditoria-do-pdv",
      agents: [{ id: "a1", label: "achar bugs", status: "done" as const, result: "ok" }],
    };
    ws.deliver({ ...run, at: 1, finished: false });
    expect(await screen.findByTestId("sdk-workflow-agent")).toBeInTheDocument();
    ws.deliver({ ...run, at: 2, finished: true });
    await waitFor(() => expect(screen.getByTestId("sdk-workflow")).toHaveAttribute("data-finished", "true"));
    expect(screen.queryByTestId("sdk-workflow-agent")).toBeNull(); // collapsed
    expect(screen.getByTestId("sdk-workflow-count")).toHaveTextContent(/1\/1/);
    expect(screen.getByTestId("sdk-workflow")).toHaveTextContent(/concluído|done/);
  });

  it("abrir um subagente pede o feed PELO SOCKET e desenha a resposta — que não vira linha da conversa", async () => {
    const ws = await fleetOnScreen();
    ws.deliver({
      type: "workflow_progress", runId: "wf_1", name: "auditoria-do-pdv", at: 1, finished: false,
      phases: ["Achar", "Verificar"], startedAt: Date.now() - 30_000,
      agents: [{ id: "a01f", label: "achar:caixa", phase: "Achar", status: "running", startedAt: Date.now() - 30_000 }],
    });
    await userEvent.click(await screen.findByTestId("sdk-workflow-agent"));
    const asked = ws.sent.map((raw) => JSON.parse(raw) as { type: string }).filter((f) => f.type === "workflow_feed");
    expect(asked).toEqual([{ type: "workflow_feed", runId: "wf_1", agentId: "a01f" }]);
    const rowsBefore = screen.getByTestId("sdk-chat-scroller").children.length;
    ws.deliver({ type: "workflow_feed", runId: "wf_1", agentId: "a01f", items: [{ at: Date.now(), kind: "tool", tool: "Grep", target: "estoque" }] });
    expect(await screen.findByTestId("workflow-feed")).toHaveTextContent(/(Buscou|Searched) estoque/);
    expect(screen.getByTestId("sdk-chat-scroller").children.length).toBe(rowsBefore);
    expect(screen.getAllByTestId("workflow-phase-group").map((g) => g.getAttribute("data-phase"))).toEqual(["Achar"]);
  });

  it("dois quadros da mesma rodada desenham UM cartão, não dois", async () => {
    const ws = await fleetOnScreen();
    const base = { type: "workflow_progress" as const, runId: "wf_1", name: "auditoria-do-pdv", finished: false };
    ws.deliver({ ...base, at: 1, agents: [{ id: "a1", label: "um", status: "running" as const }] });
    ws.deliver({ ...base, at: 2, agents: [
      { id: "a1", label: "um", status: "done" as const, result: "r" },
      { id: "a2", label: "dois", status: "running" as const },
    ] });
    await waitFor(() => expect(screen.getByTestId("sdk-workflow-count")).toHaveTextContent(/1\/2/));
    expect(screen.getAllByTestId("sdk-workflow")).toHaveLength(1);
  });
});

/**
 * THE REASONING TRANSLATED ON SCREEN. The model no longer receives a language instruction (it was the trigger of
 * Opus's blocking, and did not even always work): the browser translates the FINISHED block, with Chrome/Edge's
 * local translator — zero tokens. Without the API, the original, and nothing breaks.
 */
describe("SdkChatView — o raciocínio traduzido no navegador", () => {
  const translate = vi.fn(async (text: string) => `[pt] ${text}`);
  const Translator = {
    availability: vi.fn(async () => "available"),
    create: vi.fn(async () => ({ translate })),
  };
  const LanguageDetector = {
    availability: vi.fn(async () => "available"),
    create: vi.fn(async () => ({ detect: async () => [{ detectedLanguage: "en", confidence: 0.99 }] })),
  };

  beforeEach(() => {
    resetReasoningTranslatorForTesting();
    translate.mockClear();
    vi.stubGlobal("Translator", Translator);
    vi.stubGlobal("LanguageDetector", LanguageDetector);
  });
  // The language is global and persisted: leaving it switched would leak into the other test files.
  // the globals (Translator, LanguageDetector) are undone by the outer afterEach, along with the WebSocket
  afterEach(() => {
    resetReasoningTranslatorForTesting();
    act(() => resetLanguage());
  });

  async function thinkingDone(text: string): Promise<FakeSocket> {
    renderSdkChat();
    const ws = await socket();
    ws.accept();
    ws.deliver({ type: "ready" });
    ws.deliver({ type: "thinking_delta", text: "Let me" } as SdkEvent);
    await screen.findByTestId("sdk-thinking-text");
    ws.deliver({ type: "thinking", text } as SdkEvent);
    return ws;
  }

  it("em pt-BR, o bloco TERMINADO aparece traduzido", async () => {
    setLanguage("pt-BR");
    await thinkingDone("I need to check how roles work.");
    await waitFor(() =>
      expect(screen.getByTestId("sdk-thinking-text")).toHaveTextContent("[pt] I need to check how roles work."),
    );
  });

  it("enquanto o bloco ainda chega, mostra o original — traduzir pedaço a pedaço faria o texto pular", async () => {
    setLanguage("pt-BR");
    renderSdkChat();
    const ws = await socket();
    ws.accept();
    ws.deliver({ type: "ready" });
    ws.deliver({ type: "thinking_delta", text: "Still thinking" } as SdkEvent);
    expect(await screen.findByTestId("sdk-thinking-text")).toHaveTextContent("Still thinking");
    expect(translate).not.toHaveBeenCalled();
  });

  it("\"ver original\" mostra o texto como veio, e volta para a tradução", async () => {
    setLanguage("pt-BR");
    await thinkingDone("I will check the reasoning.");
    const toggle = await screen.findByTestId("sdk-thinking-original-toggle");
    await userEvent.click(toggle);
    expect(screen.getByTestId("sdk-thinking-text")).toHaveTextContent(/^I will check the reasoning\.$/);
    await userEvent.click(screen.getByTestId("sdk-thinking-original-toggle"));
    expect(screen.getByTestId("sdk-thinking-text")).toHaveTextContent("[pt] I will check the reasoning.");
  });

  it("interface em inglês: o original, e o tradutor nem é chamado", async () => {
    setLanguage("en");
    await thinkingDone("I will check the reasoning.");
    await waitFor(() => expect(screen.getByTestId("sdk-thinking-text")).toHaveTextContent("I will check the reasoning."));
    expect(translate).not.toHaveBeenCalled();
    expect(screen.queryByTestId("sdk-thinking-original-toggle")).toBeNull();
  });

  it("navegador sem a API (Firefox): o original, sem botão e sem erro", async () => {
    vi.stubGlobal("Translator", undefined);
    vi.stubGlobal("LanguageDetector", undefined);
    resetReasoningTranslatorForTesting();
    setLanguage("pt-BR");
    await thinkingDone("I will check the reasoning.");
    await waitFor(() => expect(screen.getByTestId("sdk-thinking-text")).toHaveTextContent("I will check the reasoning."));
    expect(screen.queryByTestId("sdk-thinking-original-toggle")).toBeNull();
  });

  // LOW-4 from the review: downloading the model CONSUMES the gesture. On pointerdown in capture, the person's first
  // click lost the gesture before the app itself (popup, fullscreen). On click, the app has already acted.
  it("o tradutor é preparado no click, DEPOIS do app — nunca no pointerdown em captura", async () => {
    setLanguage("pt-BR");
    renderSdkChat();
    await socket();
    Translator.create.mockClear();
    fireEvent.pointerDown(document.body);
    expect(Translator.create).not.toHaveBeenCalled();
    fireEvent.click(document.body);
    expect(Translator.create).toHaveBeenCalledTimes(1);
  });

  it("o socket não manda mais idioma nenhum — nada sobre o raciocínio chega ao modelo", async () => {
    setLanguage("pt-BR");
    const ws = await thinkingDone("I will check the reasoning.");
    await userEvent.type(screen.getByRole("textbox"), "oi{Enter}");
    await waitFor(() => expect(ws.rawSent.some((raw) => raw.includes('"user"'))).toBe(true));
    expect(ws.rawSent.some((raw) => raw.includes('"language"'))).toBe(false);
  });
});

/* ------------------------------------------- two people on the same card */

describe("SdkChatView — quem escreve e quem está digitando", () => {
  const OPERATOR = { id: "1", username: "operator", role: "owner" };
  const CESAR = { id: "2", username: "cesar", role: "user" };
  let me: typeof OPERATOR = OPERATOR;

  beforeEach(() => {
    me = OPERATOR;
    localStorage.clear();
    // the previous blocks may leave the language in pt-BR; the sentences here are asserted in English
    setLanguage("en");
    vi.mocked(get).mockImplementation(((url: string) =>
      url === "/auth/me"
        ? Promise.resolve({ user: me })
        : Promise.resolve({ available: false, proofread: false, language: null })) as never);
  });

  afterEach(() => {
    vi.mocked(get).mockImplementation((() => Promise.resolve({ available: false, proofread: false, language: null })) as never);
    localStorage.clear();
    resetLanguage();
  });

  /** Waits for the screen to know who the reader is (`/auth/me` resolved). */
  async function signedIn(): Promise<void> {
    await waitFor(() => expect(vi.mocked(get)).toHaveBeenCalledWith("/auth/me"));
    await act(async () => { await Promise.resolve(); });
  }

  it("mensagem de OUTRA conta no outbox não sai por esta conexão: fica marcada", async () => {
    localStorage.setItem(
      "vibehub.sdkOutbox.c1",
      JSON.stringify([{ cid: "c-alheio", text: "de outra pessoa", at: Date.now(), from: { kind: "user", name: "mussa" } }]),
    );
    renderSdkChat();
    const ws = await socket();
    ws.accept();
    await signedIn();
    ws.deliver({ type: "ready" });

    expect(await screen.findByTestId("sdk-user-undelivered")).toBeInTheDocument();
    expect(screen.getByTestId("sdk-user")).toHaveTextContent("de outra pessoa");
    expect(ws.sent).toHaveLength(0);
    // Not even the automatic resend sends it: it would go out under the name of whoever is on the tab.
    expect(screen.queryByTestId("sdk-user-retrying")).not.toBeInTheDocument();
  });

  it("mensagem de OUTRA conta: o reenvio automático também não a manda, por mais tempo que passe", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      localStorage.setItem(
        "vibehub.sdkOutbox.c1",
        JSON.stringify([{ cid: "c-alheio", text: "de outra pessoa", at: Date.now(), undelivered: true, from: { kind: "user", name: "mussa" } }]),
      );
      renderSdkChat();
      const ws = await socket();
      ws.accept();
      await signedIn();
      ws.deliver({ type: "ready" });
      expect(await screen.findByTestId("sdk-user-undelivered")).toBeInTheDocument();

      await act(async () => { await vi.advanceTimersByTimeAsync(AUTO_RESEND_DELAYS_MS.reduce((a, b) => a + b, 0)); });

      expect(ws.sent).toHaveLength(0);
      expect(screen.queryByTestId("sdk-user-retrying")).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("abrir a tela não reconecta à toa quando o /auth/me chega (só UMA conexão)", async () => {
    renderSdkChat();
    const ws = await socket();
    ws.accept();
    await signedIn();
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    expect(FakeSocket.instances.length).toBe(1);
  });

  it("TROCAR DE CONTA reconecta o chat — o servidor carimba o autor por conexão (o bug do F5)", async () => {
    const { queryClient } = renderSdkChat();
    const ws = await socket();
    ws.accept();
    await signedIn();
    me = CESAR;
    await act(async () => { await queryClient.invalidateQueries({ queryKey: ME_KEY }); });
    await waitFor(() => expect(FakeSocket.instances.length).toBe(2));
    expect(ws.readyState).toBe(3);
  });

  it("a mensagem que ficou sem recibo continua sendo de QUEM a escreveu depois da troca de conta", async () => {
    const { queryClient } = renderSdkChat();
    const ws = await socket();
    ws.accept();
    ws.deliver({ type: "ready" });
    await signedIn();
    await userEvent.type(screen.getByRole("textbox"), "continua nao para{Enter}");
    await waitFor(() => expect(ws.sent.length).toBe(1));
    // for whoever wrote it, it is their own bubble: no author name
    expect(screen.getByTestId("sdk-user")).not.toHaveAttribute("data-role");
    // account switch before the receipt: the outbox keeps the copy, and the new connection redraws it
    me = CESAR;
    await act(async () => { await queryClient.invalidateQueries({ queryKey: ME_KEY }); });
    await waitFor(() => expect(FakeSocket.instances.length).toBe(2));
    const next = FakeSocket.instances[1]!;
    next.accept();
    next.deliver({ type: "ready" });
    await waitFor(() => expect(screen.getByTestId("sdk-user")).toHaveTextContent("continua nao para"));
    // for cesar, it belongs to the operator — with the name, not as if it were his
    expect(screen.getByTestId("sdk-user")).toHaveAttribute("data-role", "user");
    expect(screen.getByTestId("sdk-user")).toHaveTextContent("operator");
  });

  it("o close ATRASADO do socket antigo não derruba a conexão nova (a mensagem sai, não fica na espera)", async () => {
    const { queryClient } = renderSdkChat();
    const ws = await socket();
    ws.accept();
    ws.deliver({ type: "ready" });
    await signedIn();
    me = CESAR;
    await act(async () => { await queryClient.invalidateQueries({ queryKey: ME_KEY }); });
    await waitFor(() => expect(FakeSocket.instances.length).toBe(2));
    const next = FakeSocket.instances[1]!;
    next.accept();
    next.deliver({ type: "ready" });
    // only now does the browser deliver the old socket's close
    act(() => ws.onclose?.());
    await userEvent.type(screen.getByRole("textbox"), "oi do cesar{Enter}");
    await waitFor(() => expect(next.sent.some((raw) => raw.includes("oi do cesar"))).toBe(true));
  });

  it("a mensagem que ESPERAVA NA FILA da conta anterior não sai pela conexão da conta nova", async () => {
    const { queryClient } = renderSdkChat();
    const ws = await socket();
    ws.accept();
    ws.deliver({ type: "ready" });
    await signedIn();
    const box = screen.getByRole("textbox");
    await userEvent.type(box, "faz a tarefa{Enter}");
    await waitFor(() => expect(ws.sent.length).toBe(1));
    ws.deliver({ type: "assistant_delta", text: "Fazendo…" });
    await userEvent.type(box, "isto é do operator{Enter}");
    await screen.findByTestId("sdk-queue");
    // account switch with the message still waiting
    me = CESAR;
    await act(async () => { await queryClient.invalidateQueries({ queryKey: ME_KEY }); });
    await waitFor(() => expect(FakeSocket.instances.length).toBe(2));
    const next = FakeSocket.instances[1]!;
    next.accept();
    next.deliver({ type: "ready" });
    next.deliver({ type: "result", isError: false });
    await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
    // nothing from the operator went out signed by cesar's connection
    expect(next.sent.some((raw) => raw.includes("isto é do operator"))).toBe(false);
    // it stays on screen, as the operator's, undelivered — and without "Reenviar" for cesar
    const bubble = screen.getAllByTestId("sdk-user").find((el) => el.textContent?.includes("isto é do operator"));
    expect(bubble).toBeDefined();
    expect(bubble).toHaveTextContent("operator");
    // (the first one, with no receipt, is also the operator's: neither of the two offers "Reenviar" to cesar)
    expect(screen.queryByTestId("sdk-user-resend")).toBeNull();
    expect(within(bubble!).getByTestId("sdk-user-undelivered")).toBeInTheDocument();
    expect(screen.queryByTestId("sdk-queue")).toBeNull();
  });

  it("mostra \"Cesar is typing\" quando outra pessoa digita neste card, e some quando ela para", async () => {
    renderSdkChat();
    const ws = await socket();
    ws.accept();
    await signedIn();
    ws.deliver({ type: "peer_typing", name: "cesar", active: true });
    expect(screen.getByTestId("sdk-peer-typing")).toHaveTextContent("Cesar is typing");
    ws.deliver({ type: "peer_typing", name: "cesar", active: false });
    expect(screen.queryByTestId("sdk-peer-typing")).toBeNull();
  });

  it("em português: \"Cesar está digitando\"", async () => {
    setLanguage("pt-BR");
    try {
      renderSdkChat();
      const ws = await socket();
      ws.accept();
      await signedIn();
      ws.deliver({ type: "peer_typing", name: "cesar", active: true });
      expect(screen.getByTestId("sdk-peer-typing")).toHaveTextContent("Cesar está digitando");
    } finally {
      resetLanguage();
    }
  });

  it("duas pessoas digitando ao mesmo tempo aparecem juntas", async () => {
    renderSdkChat();
    const ws = await socket();
    ws.accept();
    await signedIn();
    ws.deliver({ type: "peer_typing", name: "rafa", active: true });
    ws.deliver({ type: "peer_typing", name: "cesar", active: true });
    expect(screen.getByTestId("sdk-peer-typing")).toHaveTextContent("Cesar and Rafa are typing");
  });

  it("o indicador EXPIRA sozinho se o \"parou\" nunca chegar", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      renderSdkChat();
      const ws = await socket();
      ws.accept();
      await signedIn();
      ws.deliver({ type: "peer_typing", name: "cesar", active: true });
      expect(screen.getByTestId("sdk-peer-typing")).toBeInTheDocument();
      await act(async () => { await vi.advanceTimersByTimeAsync(PEER_TYPING_TTL_MS + 50); });
      expect(screen.queryByTestId("sdk-peer-typing")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("uma reconexão limpa quem estava digitando (o estado é do socket que caiu)", async () => {
    renderSdkChat();
    const ws = await socket();
    ws.accept();
    await signedIn();
    ws.deliver({ type: "peer_typing", name: "cesar", active: true });
    act(() => ws.onclose?.());
    expect(screen.queryByTestId("sdk-peer-typing")).toBeNull();
  });

  it("digitar avisa as outras abas; enviar avisa que parou", async () => {
    renderSdkChat();
    const ws = await socket();
    ws.accept();
    ws.deliver({ type: "ready" });
    await signedIn();
    await userEvent.type(screen.getByRole("textbox"), "oi");
    expect(ws.typingSent).toEqual([true]);
    await userEvent.type(screen.getByRole("textbox"), "{Enter}");
    await waitFor(() => expect(ws.typingSent).toEqual([true, false]));
  });

  /**
   * ANYONE'S DRAFT SURVIVES (production, 2026-11-03): the server keeps what each one
   * selected and returns it on attach — including MINE, for the device or tab that did not have it.
   */
  describe("cartão de pergunta — o que foi marcado volta de onde estiver", () => {
    const Q = {
      type: "user_question" as const,
      id: "q_back",
      questions: [
        { question: "Como marcamos o trucado?", options: [{ label: "Tipo no cadastro" }, { label: "Faixa de capacidade" }] },
        { question: "Produto sem peso?", options: [{ label: "Bloqueia" }, { label: "Avisa" }] },
      ],
    };

    it("o MEU rascunho guardado no servidor volta para o cartão vazio (outro aparelho, navegador limpo)", async () => {
      renderSdkChat();
      const ws = await socket();
      ws.accept();
      await signedIn();
      ws.deliver({ type: "ready" });
      ws.deliver(Q);
      ws.deliver({ type: "peer_question_draft", id: "q_back", name: "operator", picked: [["Faixa de capacidade"], []], other: ["", "pela placa"], at: 5_000, away: true });
      expect(screen.getByRole("button", { name: "Faixa de capacidade" })).toHaveAttribute("aria-pressed", "true");
      expect(screen.getAllByTestId("sdk-question-other")[1]).toHaveValue("pela placa");
      // what came from the server does not go back to it
      expect(ws.sent.map((x) => JSON.parse(x)).filter((f) => f.type === "question_draft")).toEqual([]);
    });

    it("a versão do servidor MAIS VELHA que a daqui não atropela o que foi marcado aqui", async () => {
      localStorage.setItem("vibehub.questionDrafts", JSON.stringify({
        "c1:q_back": { picked: [["Tipo no cadastro"], []], other: ["", ""], at: 9_000 },
      }));
      renderSdkChat();
      const ws = await socket();
      ws.accept();
      await signedIn();
      ws.deliver({ type: "ready" });
      ws.deliver(Q);
      ws.deliver({ type: "peer_question_draft", id: "q_back", name: "operator", picked: [["Faixa de capacidade"], []], other: ["", ""], at: 5_000 });
      expect(screen.getByRole("button", { name: "Tipo no cadastro" })).toHaveAttribute("aria-pressed", "true");
      expect(screen.getByRole("button", { name: "Faixa de capacidade" })).toHaveAttribute("aria-pressed", "false");
      // and the one from here, newer, goes to the server with its timestamp
      const sent = ws.sent.map((x) => JSON.parse(x)).filter((f) => f.type === "question_draft");
      expect(sent.at(-1)).toMatchObject({ picked: [["Tipo no cadastro"], []], at: 9_000 });
    });

    it("a versão do servidor MAIS NOVA (feita em outro aparelho) substitui a velha daqui", async () => {
      localStorage.setItem("vibehub.questionDrafts", JSON.stringify({
        "c1:q_back": { picked: [["Tipo no cadastro"], []], other: ["", ""], at: 1_000 },
      }));
      renderSdkChat();
      const ws = await socket();
      ws.accept();
      await signedIn();
      ws.deliver({ type: "ready" });
      ws.deliver(Q);
      ws.deliver({ type: "peer_question_draft", id: "q_back", name: "operator", picked: [["Faixa de capacidade"], ["Avisa"]], other: ["", ""], at: 7_000 });
      expect(screen.getByRole("button", { name: "Faixa de capacidade" })).toHaveAttribute("aria-pressed", "true");
      expect(screen.getByRole("button", { name: "Avisa" })).toHaveAttribute("aria-pressed", "true");
    });

    it("quem fechou a aba continua com as marcações na tela, mas não aparece como 'respondendo'", async () => {
      renderSdkChat();
      const ws = await socket();
      ws.accept();
      await signedIn();
      ws.deliver({ type: "ready" });
      ws.deliver(Q);
      ws.deliver({ type: "peer_question_draft", id: "q_back", name: "albert", picked: [["Tipo no cadastro"], []], other: ["", "a space tem os pesos"], away: true });
      expect(screen.queryByTestId("sdk-question-peer-presence")).toBeNull();
      expect(screen.getByRole("button", { name: "Tipo no cadastro" })).toHaveAttribute("data-peer-picked", "true");
      expect(screen.getByTestId("sdk-question-peer-draft")).toHaveTextContent("a space tem os pesos");
      ws.deliver({ type: "peer_question_draft", id: "q_back", name: "albert", picked: [["Tipo no cadastro"], []], other: ["", "a space tem os pesos"] });
      expect(screen.getByTestId("sdk-question-peer-presence")).toHaveTextContent("Albert");
    });
  });
});

/**
 * THE TRANSCRIPT COST. Every token that arrives (`assistant_delta`) and every second of the turn's
 * clock re-rendered the WHOLE conversation — every old bubble redrawn and every Markdown
 * re-parsed, dozens of times per second in a long conversation (and it is on the phone that it hurts).
 * A row that did not change has nothing to redraw.
 */
describe("SdkChatView — o custo do transcript", () => {
  /** How many times the bubble with this text has been drawn so far. */
  function drawsOf(text: string): number {
    return vi.mocked(LinkifiedText).mock.calls.filter(([props]) => props.text === text).length;
  }

  it("um token novo não redesenha as bolhas antigas", async () => {
    const { queryClient } = renderSdkChat();
    const ws = await socket();
    ws.accept();
    ws.deliver({ type: "user", text: "a mensagem antiga" });
    ws.deliver({ type: "assistant_text", text: "a resposta antiga" });
    ws.deliver({ type: "ready" });
    ws.deliver({ type: "assistant_delta", text: "Come" });
    // The mount's queries (/auth/me redraws every row through the context) settle before the
    // count: the wait below for the live row must not measure that as if it were the token's fault.
    await waitFor(() => expect(queryClient.isFetching()).toBe(0));
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
    const before = drawsOf("a mensagem antiga");
    expect(before).toBeGreaterThan(0);

    ws.deliver({ type: "assistant_delta", text: "çando" });
    ws.deliver({ type: "assistant_delta", text: " a nova" });
    ws.deliver({ type: "assistant_delta", text: " resposta" });

    // the live row is re-parsed at most every 100ms (see "o ritmo do streaming")
    await waitFor(() => expect(screen.getAllByTestId("sdk-assistant")[1]).toHaveTextContent("Começando a nova resposta"));
    expect(drawsOf("a mensagem antiga")).toBe(before);
  });

  it("o relógio do turno anda sem redesenhar a conversa", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      renderSdkChat();
      const ws = await socket();
      ws.accept();
      ws.deliver({ type: "user", text: "a mensagem antiga" });
      ws.deliver({ type: "ready" });
      ws.deliver({ type: "assistant_delta", text: "Trabalhando nisso" });
      const before = drawsOf("a mensagem antiga");

      await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });

      expect(screen.getByTestId("sdk-activity-elapsed")).toHaveTextContent(/3s/);
      expect(drawsOf("a mensagem antiga")).toBe(before);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("SdkChatView — tarefas em segundo plano", () => {
  it("o turno acabou mas a tarefa segue: o chat DIZ que há trabalho rodando, e para de dizer quando ela termina", async () => {
    renderSdkChat();
    const ws = await socket();
    ws.accept();
    ws.deliver({ type: "ready" });
    ws.deliver({ type: "tool_use", id: "t1", name: "Bash", input: { command: "sleep 200 && echo ok", run_in_background: true } });
    ws.deliver({ type: "background_tasks", tasks: [{ id: "b1", type: "local_bash", description: "Aguarda o self-deploy" }] });
    ws.deliver({ type: "assistant_text", text: "Vou aguardar o deploy." });
    ws.deliver({ type: "result", isError: false });

    const tray = await screen.findByTestId("sdk-background-tasks");
    expect(tray).toHaveTextContent("Aguarda o self-deploy");
    expect(tray).toHaveTextContent(/background/i);

    ws.deliver({ type: "background_tasks", tasks: [] });
    await waitFor(() => expect(screen.queryByTestId("sdk-background-tasks")).toBeNull());
  });

  it("uma tarefa sem descrição não derruba o chat: aparece com um nome genérico", async () => {
    renderSdkChat();
    const ws = await socket();
    ws.accept();
    ws.deliver({ type: "ready" });
    ws.deliver({ type: "background_tasks", tasks: [{ id: "b1" } as never] });
    const tray = await screen.findByTestId("sdk-background-tasks");
    expect(tray).toHaveTextContent(/background task/i);
  });

  it("a faixa tem o desenho do painel de subagentes: cada tarefa é uma linha rodando; sem ligação, não é clicável", async () => {
    renderSdkChat();
    const ws = await socket();
    ws.accept();
    ws.deliver({ type: "ready" });
    ws.deliver({ type: "tool_use", id: "t9", name: "Agent", input: { description: "Review backend", run_in_background: true } });
    ws.deliver({ type: "background_tasks", tasks: [
      { id: "k9", type: "local_agent", description: "Review backend", toolUseId: "t9" },
      { id: "k1", type: "local_bash", description: "Wait for jest" },
    ] });
    const tray = await screen.findByTestId("sdk-background-tasks");
    expect(tray).toHaveAttribute("data-count", "2");
    const [linked, loose] = within(tray).getAllByTestId("sdk-background-task");
    expect(linked).toHaveAttribute("data-status", "running");
    expect(linked.tagName).toBe("BUTTON");
    expect(loose).toHaveAttribute("data-status", "running");
    expect(loose.tagName).toBe("DIV");
    expect(loose).not.toHaveAttribute("data-clickable");
  });
});

describe("SdkChatView — /clear", () => {
  it("o /clear limpa a conversa da tela e diz que o Claude começou do zero", async () => {
    renderSdkChat();
    const ws = await socket();
    ws.accept();
    ws.deliver({ type: "ready" });
    ws.deliver({ type: "assistant_text", text: "Resposta antiga e longa." });
    ws.deliver({ type: "result", isError: false });
    expect(screen.getByText("Resposta antiga e longa.")).toBeInTheDocument();

    ws.deliver({ type: "conversation_reset", trigger: "clear" });
    ws.deliver({ type: "system_note", text: "conversation-cleared", at: Date.now() });
    await waitFor(() => expect(screen.queryByText("Resposta antiga e longa.")).toBeNull());
    expect(screen.getByText(/cleared/i)).toBeInTheDocument();
  });
});

/**
 * The edit DIFF, like in Cursor: when the AI changes code, the chat shows only the changed
 * hunks (+ green, − red, counter in the header) instead of the "Edit(file)" line.
 */
describe("SdkChatView — o diff do que a IA editou", () => {
  const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i}`).join("\n");
  // Unmounts BEFORE the file's `resetLanguage()`: switching the language with the screen mounted redraws
  // every `useT` subscriber outside an act(...) — warnings this block cannot add.
  afterEach(() => cleanup());

  it("um Edit vira o card de diff: +1 −1, as linhas com sinal e o contexto", async () => {
    renderSdkChat();
    const ws = await socket();
    ws.accept();
    ws.deliver({ type: "ready" });
    ws.deliver({
      type: "tool_use", id: "t1", name: "Edit",
      input: { file_path: "/repo/src/app.ts", old_string: "const a = 1;\nconst b = 2;", new_string: "const a = 1;\nconst b = 3;" },
    });

    const card = screen.getByTestId("sdk-diff");
    expect(card.getAttribute("data-tool")).toBe("Edit");
    expect(screen.queryByTestId("sdk-tool")).toBeNull();
    expect(within(card).getByText("app.ts").getAttribute("title")).toBe("/repo/src/app.ts");
    expect(within(card).getByTestId("sdk-diff-added")).toHaveTextContent("+1");
    expect(within(card).getByTestId("sdk-diff-added").getAttribute("aria-label")).toBe("1 line added");
    expect(within(card).getByTestId("sdk-diff-removed")).toHaveTextContent("−1");
    expect(within(card).getByRole("button", { expanded: true })).toBeInTheDocument();

    const shown = within(card).getAllByTestId("sdk-diff-line").map((line) => [line.getAttribute("data-kind"), line.textContent]);
    expect(shown).toEqual([
      ["ctx", " const a = 1;"],
      ["del", "−const b = 2;"],
      ["add", "+const b = 3;"],
    ]);
    // What changed inside the line comes highlighted, on both sides.
    expect(within(card).getAllByTestId("sdk-diff-mark").map((mark) => mark.textContent)).toEqual(["2", "3"]);
  });

  it("três ferramentas antes do Edit dobram sozinhas — o card do diff fica de fora, na tela", async () => {
    renderSdkChat();
    const ws = await socket();
    ws.accept();
    ws.deliver({ type: "ready" });
    for (const id of ["r1", "r2", "r3"]) ws.deliver({ type: "tool_use", id, name: "Read", input: { file_path: `/repo/${id}.ts` } });
    ws.deliver({ type: "tool_use", id: "e1", name: "Edit", input: { file_path: "/repo/a.ts", old_string: "x", new_string: "y" } });

    const group = screen.getByTestId("sdk-tool-group");
    expect(group.getAttribute("data-count")).toBe("3");
    const card = screen.getByTestId("sdk-diff");
    expect(group.contains(card)).toBe(false);
    expect(within(card).getAllByTestId("sdk-diff-line")).toHaveLength(2);
  });

  it("um Edit espelhado do terminal (só description) continua a linha compacta de sempre", async () => {
    renderSdkChat();
    const ws = await socket();
    ws.accept();
    ws.deliver({ type: "ready" });
    ws.deliver({ type: "tool_use", id: "t1", name: "Edit", input: { description: "Edit(src/a.ts)" } });
    expect(screen.queryByTestId("sdk-diff")).toBeNull();
    expect(screen.getByTestId("sdk-tool").getAttribute("data-tool")).toBe("Edit");
  });

  it("um Write grande também nasce aberto, com o resto contado, e recolhe no clique", async () => {
    renderSdkChat();
    const ws = await socket();
    ws.accept();
    ws.deliver({ type: "ready" });
    ws.deliver({ type: "tool_use", id: "w1", name: "Write", input: { file_path: "/repo/new.ts", content: lines(60) } });

    const card = screen.getByTestId("sdk-diff");
    expect(within(card).getByTestId("sdk-diff-added")).toHaveTextContent("+60");
    const toggle = within(card).getByRole("button", { expanded: true });
    const shown = within(card).getAllByTestId("sdk-diff-line");
    expect(shown).toHaveLength(40);
    expect(shown.every((line) => line.getAttribute("data-kind") === "add")).toBe(true);
    expect(within(card).getByTestId("sdk-diff-truncated")).toHaveTextContent("20 more lines not shown");

    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(within(card).queryAllByTestId("sdk-diff-line")).toHaveLength(0);
  });

  /**
   * THE "CHOKING" AI: while the model wrote the input of a large Write, the screen stayed only on
   * "Trabalhando…" for dozens of seconds. Now the provisional row says what is being written and
   * how much, and the complete `tool_use` becomes the diff card IN ITS PLACE — never a second card.
   */
  it("durante a geração mostra 'Writing x… N KB'; com o tool_use completo fica um único card de diff", async () => {
    renderSdkChat();
    const ws = await socket();
    ws.accept();
    ws.deliver({ type: "ready" });
    ws.deliver({ type: "user", text: "cria o arquivo" });
    ws.deliver({ type: "tool_use_start", id: "w1", name: "Write" });
    ws.deliver({ type: "tool_input_progress", id: "w1", bytes: 12_288, filePath: "/repo/src/sdkChat.ts" });

    const live = screen.getByTestId("sdk-tool");
    expect(live.getAttribute("data-pending")).toBe("true");
    expect(within(live).getByTestId("sdk-tool-title")).toHaveTextContent("Writing sdkChat.ts… 12 KB");
    expect(screen.getByTestId("sdk-activity-label")).toHaveTextContent("Writing sdkChat.ts… 12 KB");
    expect(screen.queryByTestId("sdk-diff")).toBeNull();

    ws.deliver({ type: "tool_use", id: "w1", name: "Write", input: { file_path: "/repo/src/sdkChat.ts", content: lines(3) } });
    expect(screen.getAllByTestId("sdk-diff")).toHaveLength(1);
    expect(screen.queryByTestId("sdk-tool")).toBeNull();
    expect(within(screen.getByTestId("sdk-diff")).getByTestId("sdk-diff-added")).toHaveTextContent("+3");
  });

  it("um Agent ou TodoWrite ainda sendo gerado é a linha viva, não um card vazio", async () => {
    renderSdkChat();
    const ws = await socket();
    ws.accept();
    ws.deliver({ type: "ready" });
    ws.deliver({ type: "user", text: "explora" });
    ws.deliver({ type: "tool_use_start", id: "a1", name: "Agent" });
    expect(screen.queryByTestId("sdk-agent")).toBeNull();
    expect(within(screen.getByTestId("sdk-tool")).getByTestId("sdk-tool-title")).toHaveTextContent("Preparing Agent…");
    ws.deliver({ type: "tool_use", id: "a1", name: "Agent", input: { description: "explora o chat", subagent_type: "Explore" } });
    expect(screen.getAllByTestId("sdk-fleet-agent")).toHaveLength(1);
    expect(document.querySelector("[data-pending]")).toBeNull();
  });

  it("em pt-BR os contadores falam com plural", async () => {
    setLanguage("pt-BR");
    renderSdkChat();
    const ws = await socket();
    ws.accept();
    ws.deliver({ type: "ready" });
    ws.deliver({ type: "tool_use", id: "t1", name: "Edit", input: { file_path: "a.ts", old_string: "a\nb", new_string: "c" } });
    const card = screen.getByTestId("sdk-diff");
    expect(within(card).getByTestId("sdk-diff-added").getAttribute("aria-label")).toBe("1 linha adicionada");
    expect(within(card).getByTestId("sdk-diff-removed").getAttribute("aria-label")).toBe("2 linhas removidas");
  });
});

/**
 * THE STREAMING RHYTHM. The driver sends one socket frame per token, and each frame became a
 * setState: one render of the whole conversation per token, and the answer's Markdown re-parsed from scratch
 * on each one — the long answer "choked" on screen and the text field lagged along with it.
 */
describe("SdkChatView — o ritmo do streaming", () => {
  /** How many times Markdown parsed a text that starts like this. */
  function parsesOf(prefix: string): number {
    const inner = (Markdown as unknown as { type: { mock: { calls: [{ text: string }][] } } }).type;
    return inner.mock.calls.filter(([props]) => props.text.startsWith(prefix)).length;
  }

  it("os tokens que chegam no mesmo frame de animação viram UM render", async () => {
    const commits = vi.fn();
    renderApp(
      <Profiler id="chat" onRender={commits}>
        <SdkChatView cardId="c1" />
      </Profiler>,
    );
    const ws = await socket();
    ws.accept();
    ws.deliver({ type: "ready" });
    ws.deliver({ type: "assistant_delta", text: "Começ" });
    const before = commits.mock.calls.length;

    for (let i = 0; i < 30; i++) ws.receive({ type: "assistant_delta", text: ` t${i}` });
    runAnimationFrames();

    expect(commits.mock.calls.length - before).toBeLessThanOrEqual(2);
    await waitFor(() => expect(screen.getByTestId("sdk-assistant")).toHaveTextContent("Começ t0 t1"));
    await waitFor(() => expect(screen.getByTestId("sdk-assistant")).toHaveTextContent("t29"));
  });

  it("um evento que não é token esvazia o frame ANTES de entrar: a ordem da conversa não muda", async () => {
    renderSdkChat();
    const ws = await socket();
    ws.accept();
    ws.deliver({ type: "ready" });

    ws.receive({ type: "assistant_delta", text: "Vou rodar " });
    ws.receive({ type: "assistant_delta", text: "os testes." });
    ws.receive({ type: "tool_use", id: "t1", name: "Bash", input: { command: "npm test" } });
    ws.receive({ type: "assistant_delta", text: "Depois" });

    // Without any animation frame: the text before the tool is already on screen, and in its place.
    const answer = screen.getAllByTestId("sdk-assistant")[0]!;
    expect(answer).toHaveTextContent("Vou rodar os testes.");
    expect(answer.compareDocumentPosition(screen.getByTestId("sdk-tool")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    runAnimationFrames();
    await waitFor(() => expect(screen.getAllByTestId("sdk-assistant")).toHaveLength(2));
    expect(screen.getAllByTestId("sdk-assistant")[1]).toHaveTextContent("Depois");
  });

  it("sem frame de animação (aba em segundo plano), os tokens entram mesmo assim", async () => {
    renderSdkChat();
    const ws = await socket();
    ws.accept();
    ws.deliver({ type: "ready" });
    vi.useFakeTimers();
    try {
      ws.receive({ type: "assistant_delta", text: "Rodando " });
      ws.receive({ type: "assistant_delta", text: "em segundo plano" });
      act(() => { vi.advanceTimersByTime(250); });
      expect(screen.getByTestId("sdk-assistant")).toHaveTextContent("Rodando em segundo plano");
    } finally {
      vi.useRealTimers();
    }
  });

  it("a resposta que ainda escorre não é re-parseada a cada token — e o texto final sempre aparece", async () => {
    renderSdkChat();
    const ws = await socket();
    ws.accept();
    ws.deliver({ type: "ready" });
    vi.useFakeTimers();
    try {
      ws.deliver({ type: "assistant_delta", text: "Resposta:" });
      // 40 tokens, each in its own animation frame, in under 100ms of clock
      for (let i = 0; i < 40; i++) {
        ws.deliver({ type: "assistant_delta", text: ` p${i}` });
        act(() => { vi.advanceTimersByTime(2); });
      }
      expect(parsesOf("Resposta:")).toBeLessThanOrEqual(3);

      // once the window has passed, the live row catches up with the whole text, even without a new token
      act(() => { vi.advanceTimersByTime(200); });
      expect(screen.getByTestId("sdk-assistant")).toHaveTextContent("p39");
    } finally {
      vi.useRealTimers();
    }

    ws.deliver({ type: "assistant_text", text: "Resposta: **final**." });
    expect(screen.getByTestId("sdk-assistant")).toHaveTextContent("Resposta: final.");
    expect(screen.getByText("final").tagName).toBe("STRONG");
  });
});

/**
 * THE FRAME'S TOKENS AND THE LOCAL ACTION. Tokens wait for the next animation frame in a buffer — and
 * an action by the person in the meantime (Enter, the correction, Esc, "enviar agora") cannot be
 * judged by the screen from one frame behind, nor write into the conversation BEFORE what had already arrived.
 */
describe("SdkChatView — o buffer de tokens diante de uma ação local", () => {
  function follows(first: Element, second: Element): boolean {
    return (first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
  }

  async function readyChat() {
    renderSdkChat();
    const ws = await socket();
    ws.accept();
    return ws;
  }

  it("Enter com o token que abriu um turno ainda no buffer: a mensagem ESPERA na fila", async () => {
    const ws = await readyChat();
    ws.deliver({ type: "ready" });
    const box = (await screen.findByLabelText(/Enter/)) as HTMLTextAreaElement;
    await userEvent.type(box, "oi");

    ws.receive({ type: "assistant_delta", text: "Começando" }); // no animation frame yet
    await userEvent.type(box, "{Enter}");
    runAnimationFrames();

    expect(ws.sent).toHaveLength(0);
    await screen.findByTestId("sdk-queue");
    expect(screen.getByTestId("sdk-queued")).toHaveTextContent("oi");
  });

  it("a correção enviada com um turno aberto só no buffer PARA o turno antes — e nasce depois da resposta", async () => {
    const ws = await readyChat();
    ws.deliver({ type: "user", text: "sobe pra prod" }); // replay: no turn running
    ws.deliver({ type: "ready" });
    const box = (await screen.findByLabelText(/Enter/)) as HTMLTextAreaElement;
    await userEvent.click(screen.getByTestId("sdk-edit"));
    await userEvent.clear(box);
    await userEvent.type(box, "sobe pra dev");

    ws.receive({ type: "assistant_delta", text: "Subindo…" });
    await userEvent.type(box, "{Enter}");
    runAnimationFrames();

    await waitFor(() => expect(ws.sent.length).toBe(1));
    expect(JSON.parse(ws.sent[0]!)).toEqual({ type: "interrupt", reason: "edit" });
    const bubbles = screen.getAllByTestId("sdk-user");
    expect(follows(screen.getByTestId("sdk-assistant"), bubbles[bubbles.length - 1]!)).toBe(true);
  });

  it("Esc no campo vazio com um turno aberto só no buffer não entra em edição", async () => {
    const ws = await readyChat();
    ws.deliver({ type: "user", text: "sobe pra prod" });
    ws.deliver({ type: "ready" });
    const box = (await screen.findByLabelText(/Enter/)) as HTMLTextAreaElement;
    await userEvent.clear(box);

    ws.receive({ type: "assistant_delta", text: "Subindo…" });
    fireEvent.keyDown(box, { key: "Escape" });
    runAnimationFrames();

    expect(screen.queryByTestId("composer-editing")).not.toBeInTheDocument();
  });

  it("o despacho da fila não solta a mensagem no meio de uma frase que só está no buffer", async () => {
    const ws = await readyChat();
    ws.deliver({ type: "ready" });
    const box = (await screen.findByLabelText(/Enter/)) as HTMLTextAreaElement;
    await userEvent.type(box, "faz a tarefa{Enter}");
    await waitFor(() => expect(ws.sent.length).toBe(1));
    ws.deliver({ type: "assistant_delta", text: "Fazendo…" });
    await userEvent.type(box, "depois isto{Enter}");
    await screen.findByTestId("sdk-queued");
    await userEvent.click(screen.getByTestId("sdk-edit")); // the armed correction holds the queue
    ws.deliver({ type: "result", isError: false });
    expect(ws.sent).toHaveLength(1);

    ws.receive({ type: "assistant_delta", text: "Outro turno começando" }); // half-finished sentence, in the buffer
    fireEvent.keyDown(box, { key: "Escape" }); // gave up on the correction: the queue can move again
    runAnimationFrames();

    expect(ws.sent).toHaveLength(1);
    expect(screen.getByTestId("sdk-queued")).toHaveTextContent("depois isto");
  });

  it("'enviar agora' com tokens no buffer: a bolha nasce DEPOIS do que já tinha chegado", async () => {
    const ws = await readyChat();
    ws.deliver({ type: "ready" });
    const box = (await screen.findByLabelText(/Enter/)) as HTMLTextAreaElement;
    await userEvent.type(box, "faz a tarefa{Enter}");
    await waitFor(() => expect(ws.sent.length).toBe(1));
    ws.deliver({ type: "assistant_delta", text: "Fazendo…" });
    await userEvent.type(box, "o que você tá fazendo ?{Enter}");
    await screen.findByTestId("sdk-queued");
    ws.receive({ type: "assistant_delta", text: " Analisando a saída" }); // still the same sentence, in the buffer
    await userEvent.click(screen.getByTestId("sdk-queued-send-now"));
    runAnimationFrames();

    await waitFor(() => expect(ws.sent.length).toBe(2));
    // The answer still streaming is redrawn every STREAMING_MARKDOWN_MS: the new text may
    // take up to that window to appear. A token lost in the buffer never appears — and fails here.
    const answer = await waitFor(() => {
      const found = screen.getAllByTestId("sdk-assistant").find((el) => el.textContent?.includes("Analisando a saída"));
      expect(found).toBeDefined();
      return found!;
    });
    const bubbles = screen.getAllByTestId("sdk-user");
    expect(follows(answer, bubbles[bubbles.length - 1]!)).toBe(true);
  });
});

describe("SdkChatView — o buffer de tokens e a troca de conexão", () => {
  it("um token do card anterior que ficou no buffer não entra no card novo", async () => {
    const { rerender } = renderSdkChat();
    const ws = await socket();
    ws.accept();
    ws.deliver({ type: "ready" });
    ws.receive({ type: "assistant_delta", text: "TOKEN-DO-CARD-1" }); // no animation frame yet

    rerender(<SdkChatView cardId="c2" />);
    await waitFor(() => expect(FakeSocket.instances).toHaveLength(2));
    const ws2 = FakeSocket.instances[1]!;
    ws2.accept();
    ws2.deliver({ type: "ready" });
    runAnimationFrames();

    expect(screen.getByTestId("sdk-chat-scroller")).not.toHaveTextContent("TOKEN-DO-CARD-1");
  });
});

describe("SdkChatView — o buffer de tokens e a queda do fio", () => {
  /**
   * What guarantees this is the ORDER of the timers: the buffer's (100ms) is born before the reconnect's (400ms
   * at minimum) and fires first, so the next `onopen` — which clears the screen for the replay —
   * never finds a token from the dead connection to drip on top of the history.
   */
  it("o token que estava no buffer quando o fio caiu não reaparece por cima do replay", async () => {
    // Only the clock is fake: the animation frame stays in the test's hands and does NOT fire (the tab in
    // the background) — what empties the buffer here is the timer.
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    try {
      renderSdkChat();
      const first = await socket();
      first.accept();
      first.deliver({ type: "ready" });
      first.deliver({ type: "assistant_delta", text: "Começo" });
      first.receive({ type: "assistant_delta", text: " da resposta" }); // no animation frame

      act(() => { first.readyState = 3; first.onclose?.(); });
      await act(async () => { await vi.advanceTimersByTimeAsync(RECONNECT_MAX_MS); });
      const second = FakeSocket.instances[1] as FakeSocket;
      second.accept();
      second.deliver({ type: "user", text: "explica o deploy" }); // the replay from disk
      second.deliver({ type: "assistant_text", text: "Começo da resposta" });
      second.deliver({ type: "ready" });
      runAnimationFrames();

      expect(screen.getAllByTestId("sdk-assistant")).toHaveLength(1);
      expect(screen.getByTestId("sdk-chat-scroller").textContent?.match(/da resposta/g)).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

/**
 * THE PLAN LIMIT WARNING — the "You've used 91% of your session limit" from the terminal's footer, in the
 * right corner of the "está digitando" strip, in the color of how much is left.
 */
describe("SdkChatView — o aviso de limite do plano", () => {
  afterEach(() => cleanup());
  const inTwoHours = () => Date.now() + 2 * 3_600_000;

  it("aparece com o tom de quanto já foi, e some quando um driver novo sobe", async () => {
    renderSdkChat();
    const ws = await socket();
    ws.accept();
    ws.deliver({ type: "ready" });
    expect(screen.queryByTestId("plan-alert")).toBeNull();

    ws.deliver({ type: "rate_limit", status: "allowed_warning", window: "five_hour", utilization: 88, resetsAt: inTwoHours() });
    const alert = screen.getByTestId("plan-alert");
    expect(alert.getAttribute("data-tone")).toBe("orange");
    expect(alert).toHaveTextContent(/^88% of the session limit used — resets in 1h 59m|^88% of the session limit used — resets in 2h 00m/);

    ws.deliver({ type: "rate_limit", status: "rejected", window: "five_hour", utilization: 100, resetsAt: inTwoHours() });
    expect(screen.getByTestId("plan-alert").getAttribute("data-tone")).toBe("red");
    expect(screen.getByTestId("plan-alert")).toHaveTextContent("The session limit is used up");

    ws.deliver({ type: "ready" });
    expect(screen.queryByTestId("plan-alert")).toBeNull();
  });

  it("fica quieto enquanto há margem, e ignora um frame torto", async () => {
    renderSdkChat();
    const ws = await socket();
    ws.accept();
    ws.deliver({ type: "ready" });
    ws.deliver({ type: "rate_limit", status: "allowed", window: "five_hour", utilization: 40, resetsAt: inTwoHours() });
    ws.deliver({ type: "rate_limit", status: "bogus", window: "five_hour", utilization: 99 });
    expect(screen.queryByTestId("plan-alert")).toBeNull();
  });
});

/**
 * THE CONTEXT METER — how much of the window the conversation takes, in the bottom right corner of the log. The color
 * slides with the percentage; the guide (tooltip) shows the three bands with the current one highlighted.
 */
describe("SdkChatView — o medidor de contexto", () => {
  afterEach(() => cleanup());

  it("só aparece com leitura, muda de faixa conforme a conversa cresce e some com um driver novo", async () => {
    renderSdkChat();
    const ws = await socket();
    ws.accept();
    ws.deliver({ type: "ready" });
    expect(screen.queryByTestId("context-meter")).toBeNull();

    ws.deliver({ type: "context_usage", usedTokens: 24_000, maxTokens: 200_000, percent: 12 } as SdkEvent);
    const meter = screen.getByTestId("context-meter");
    expect(meter.getAttribute("data-zone")).toBe("smart");
    expect(screen.getByTestId("context-meter-value")).toHaveTextContent("12%");
    const cool = screen.getByTestId("context-meter-fill").style.backgroundColor;

    ws.deliver({ type: "context_usage", usedTokens: 84_000, maxTokens: 200_000, percent: 42 } as SdkEvent);
    expect(screen.getByTestId("context-meter").getAttribute("data-zone")).toBe("warn");
    ws.deliver({ type: "context_usage", usedTokens: 140_000, maxTokens: 200_000, percent: 70 } as SdkEvent);
    expect(screen.getByTestId("context-meter").getAttribute("data-zone")).toBe("danger");
    expect(screen.getByTestId("context-meter-fill").style.backgroundColor).not.toBe(cool);

    // A skewed reading does not erase the one that counts.
    ws.deliver({ type: "context_usage", usedTokens: 10 } as SdkEvent);
    expect(screen.getByTestId("context-meter-value")).toHaveTextContent("70%");

    ws.deliver({ type: "ready" });
    expect(screen.queryByTestId("context-meter")).toBeNull();
  });

  it("fica no canto inferior direito da caixa da conversa, não na faixa acima do campo", async () => {
    renderSdkChat();
    const ws = await socket();
    ws.accept();
    ws.deliver({ type: "ready" });
    ws.deliver({ type: "context_usage", usedTokens: 24_000, maxTokens: 200_000, percent: 12 } as SdkEvent);
    const corner = screen.getByTestId("sdk-context-corner");
    expect(corner).toContainElement(screen.getByTestId("context-meter"));
    expect(corner).toHaveClass("absolute", "bottom-3", "right-4");
    // Same box as the log: the corner is a sibling of the scroller, inside the same wrapper.
    expect(corner.parentElement).toContainElement(screen.getByTestId("sdk-chat-scroller"));
    expect(screen.getByTestId("terminal-composer").previousElementSibling).not.toContainElement(screen.getByTestId("context-meter"));
  });

  it("na resposta fechada, entra na linha do copiar/ouvir; outra última linha volta ao canto com faixa própria", async () => {
    renderSdkChat();
    const ws = await socket();
    ws.accept();
    ws.deliver({ type: "user", text: "oi" });
    ws.deliver({ type: "assistant_text", text: "Pronto." });
    ws.deliver({ type: "result", isError: false });
    // Resuming the session does not become a row in the log: the answer is still the last one.
    ws.deliver({ type: "ready", resume: "bfe63d25-95df-4c86-bf34-047b1366cc02" } as SdkEvent);
    ws.deliver({ type: "context_usage", usedTokens: 24_000, maxTokens: 200_000, percent: 12 } as SdkEvent);
    const scroller = screen.getByTestId("sdk-chat-scroller");
    expect(screen.queryByText(/Retomando a sessão/)).toBeNull();
    // Same row as the icons, with no extra strip nor floating pill.
    expect(screen.getByTestId("sdk-answer-actions")).toContainElement(screen.getByTestId("context-meter"));
    expect(screen.queryByTestId("sdk-context-corner")).toBeNull();
    expect(scroller).not.toHaveClass("pb-10");

    // The last row is now the user's bubble, on the right: the meter goes to the corner and the log reserves the strip.
    ws.deliver({ type: "user", text: "mais uma" });
    expect(screen.getByTestId("sdk-context-corner")).toContainElement(screen.getByTestId("context-meter"));
    expect(screen.getByTestId("sdk-answer-actions")).not.toContainElement(screen.queryByTestId("context-meter"));
    expect(scroller).toHaveClass("pb-10");
  });

  it("sem medidor, o log não reserva o canto", async () => {
    renderSdkChat();
    const ws = await socket();
    ws.accept();
    ws.deliver({ type: "ready" });
    ws.deliver({ type: "user", text: "oi" });
    expect(screen.getByTestId("sdk-chat-scroller")).not.toHaveClass("pb-10");
  });

  it("com o medidor no canto, o 'ir pro fim' sobe uma faixa para não colidir com ele", async () => {
    renderSdkChat();
    const ws = await socket();
    ws.accept();
    ws.deliver({ type: "ready" });
    ws.deliver({ type: "user", text: "oi" });
    const scroller = screen.getByTestId("sdk-chat-scroller");
    Object.defineProperty(scroller, "scrollHeight", { configurable: true, value: 1000 });
    Object.defineProperty(scroller, "clientHeight", { configurable: true, value: 200 });
    Object.defineProperty(scroller, "scrollTop", { configurable: true, get: () => 0, set: () => {} });
    fireEvent.scroll(scroller);
    expect(screen.getByTestId("jump-latest")).toHaveClass("bottom-3");

    ws.deliver({ type: "context_usage", usedTokens: 24_000, maxTokens: 200_000, percent: 12 } as SdkEvent);
    expect(screen.getByTestId("jump-latest")).toHaveClass("bottom-11");
    expect(screen.getByTestId("jump-latest")).not.toHaveClass("bottom-3");
  });

  it("o guia mostra os tokens, as três faixas e destaca a de agora", async () => {
    renderSdkChat();
    const ws = await socket();
    ws.accept();
    ws.deliver({ type: "ready" });
    ws.deliver({ type: "context_usage", usedTokens: 84_000, maxTokens: 200_000, percent: 42 } as SdkEvent);
    fireEvent.focus(screen.getByTestId("context-meter"));
    const guide = await screen.findByTestId("context-guide");
    expect(guide).toHaveTextContent("84k of 200k tokens");
    const zones = within(guide).getAllByTestId("context-zone");
    expect(zones.map((z) => z.getAttribute("data-zone"))).toEqual(["smart", "warn", "danger"]);
    expect(zones.filter((z) => z.getAttribute("data-current") === "true").map((z) => z.getAttribute("data-zone"))).toEqual(["warn"]);
    expect(within(guide).getByTestId("context-guide-marker").style.left).toBe("42%");
  });

  it("acima de 30% vira aviso que o dev pode esconder; acima de 60% faixa de perigo que não se esconde", async () => {
    renderSdkChat();
    const ws = await socket();
    ws.accept();
    ws.deliver({ type: "ready" });
    ws.deliver({ type: "context_usage", usedTokens: 50_000, maxTokens: 200_000, percent: 25 } as SdkEvent);
    expect(screen.queryByTestId("context-notice")).toBeNull();
    expect(screen.queryByTestId("context-meter-icon")).toBeNull();

    ws.deliver({ type: "context_usage", usedTokens: 84_000, maxTokens: 200_000, percent: 42 } as SdkEvent);
    const warn = screen.getByTestId("context-notice");
    expect(warn.getAttribute("data-zone")).toBe("warn");
    expect(warn.getAttribute("role")).toBe("status");
    expect(warn).toHaveTextContent("Context at 42%");
    expect(screen.getByTestId("context-meter")).toHaveTextContent("attention");
    expect(screen.getByTestId("context-meter-icon")).toBeTruthy();

    fireEvent.click(screen.getByTestId("context-notice-dismiss"));
    expect(screen.queryByTestId("context-notice")).toBeNull();
    // With the warning hidden, the meter still says "attention".
    expect(screen.getByTestId("context-meter")).toHaveTextContent("attention");

    // It reached danger: the strip comes back, red, and without a hide button.
    ws.deliver({ type: "context_usage", usedTokens: 130_000, maxTokens: 200_000, percent: 65 } as SdkEvent);
    const danger = screen.getByTestId("context-notice");
    expect(danger.getAttribute("data-zone")).toBe("danger");
    expect(danger.getAttribute("role")).toBe("alert");
    expect(danger).toHaveTextContent("AI in the danger zone: 65%");
    expect(screen.queryByTestId("context-notice-dismiss")).toBeNull();
    expect(screen.getByTestId("context-meter")).toHaveTextContent("danger");

    // A /compact brings it back to the smart band: everything goes away, and the next warning shows up again.
    ws.deliver({ type: "context_usage", usedTokens: 20_000, maxTokens: 200_000, percent: 10 } as SdkEvent);
    expect(screen.queryByTestId("context-notice")).toBeNull();
    ws.deliver({ type: "context_usage", usedTokens: 70_000, maxTokens: 200_000, percent: 35 } as SdkEvent);
    expect(screen.getByTestId("context-notice").getAttribute("data-zone")).toBe("warn");
  });

  it("o aviso escondido continua escondido depois de uma reconexão, e volta depois de passar pelo perigo", async () => {
    renderSdkChat();
    const ws = await socket();
    ws.accept();
    ws.deliver({ type: "ready" });
    ws.deliver({ type: "context_usage", usedTokens: 84_000, maxTokens: 200_000, percent: 42 } as SdkEvent);
    fireEvent.click(screen.getByTestId("context-notice-dismiss"));
    expect(screen.queryByTestId("context-notice")).toBeNull();

    // Reconnect: `ready` resets the reading and the back resends the same one right behind it.
    ws.deliver({ type: "ready" });
    ws.deliver({ type: "context_usage", usedTokens: 86_000, maxTokens: 200_000, percent: 43 } as SdkEvent);
    expect(screen.queryByTestId("context-notice")).toBeNull();

    // It went to danger and came back (a partial /compact): the worrying warning shows up again.
    ws.deliver({ type: "context_usage", usedTokens: 130_000, maxTokens: 200_000, percent: 65 } as SdkEvent);
    ws.deliver({ type: "context_usage", usedTokens: 100_000, maxTokens: 200_000, percent: 50 } as SdkEvent);
    expect(screen.getByTestId("context-notice").getAttribute("data-zone")).toBe("warn");
  });

  it("o /clear tira o medidor da conversa apagada", async () => {
    renderSdkChat();
    const ws = await socket();
    ws.accept();
    ws.deliver({ type: "ready" });
    ws.deliver({ type: "context_usage", usedTokens: 130_000, maxTokens: 200_000, percent: 65 } as SdkEvent);
    expect(screen.getByTestId("context-notice")).toBeTruthy();
    ws.deliver({ type: "conversation_reset", trigger: "clear" } as SdkEvent);
    expect(screen.queryByTestId("context-meter")).toBeNull();
    expect(screen.queryByTestId("context-notice")).toBeNull();
  });

  it("o guia abre no clique (toque), não só no hover — e janela de 1M sai como 1M", async () => {
    renderSdkChat();
    const ws = await socket();
    ws.accept();
    ws.deliver({ type: "ready" });
    ws.deliver({ type: "context_usage", usedTokens: 250_000, maxTokens: 1_000_000, percent: 25 } as SdkEvent);
    fireEvent.click(screen.getByTestId("context-meter"));
    const guide = await screen.findByTestId("context-guide");
    expect(guide).toHaveTextContent("250k of 1M tokens");
  });
});

/**
 * THE PRODUCTION SEQUENCE (card review-entrada-mercadoria-albert, 2026-10-19): the message did not go
 * because of an error, the person edited it, and then edited the edited one AGAIN — without changing the words.
 * It should have been ONE overwritten message; the screen got to show three. Here, the exact events that
 * card's log has, live and after a reconnect.
 */
describe("SdkChatView — editar de novo a mensagem editada sobrescreve, não empilha", () => {
  const A = "eu preciso que voce seja mais clara";

  async function textbox(): Promise<HTMLTextAreaElement> {
    return (await screen.findByLabelText(/Enter/)) as HTMLTextAreaElement;
  }

  it("ao vivo: depois do replay e da segunda edição, UMA bolha com o selo", async () => {
    renderSdkChat();
    const ws = await socket();
    ws.accept();
    ws.deliver({ type: "user", text: A, at: 1 });
    ws.deliver({ type: "message_edited", originalText: A });
    ws.deliver({ type: "user", text: A, at: 2 });
    ws.deliver({ type: "ready", resume: "7f0ce176-edd7-4251-a73a-77ed1efe59e7" } as SdkEvent);
    expect(screen.getAllByTestId("sdk-user")).toHaveLength(1);

    await userEvent.click(screen.getByTestId("sdk-edit"));
    await userEvent.type(await textbox(), "{Enter}");
    await waitFor(() => expect(ws.sent.length).toBe(1));
    const frame = JSON.parse(ws.sent[0]!) as { type: string; original: string; text: string; cid: string };
    expect(frame).toMatchObject({ type: "edit_user", original: A, text: A });
    ws.deliver({ type: "user_ack", cid: frame.cid } as SdkEvent);
    ws.deliver({ type: "rewound", ok: false, reason: "not-delivered" } as SdkEvent);
    ws.deliver({ type: "assistant_text", text: "Explicando de forma simples." });
    ws.deliver({ type: "result", isError: false });

    const bubbles = screen.getAllByTestId("sdk-user");
    expect(bubbles).toHaveLength(1);
    expect(bubbles[0]).toHaveTextContent(A);
    expect(bubbles[0]).toHaveAttribute("data-revision", "true");
  });

  it("depois de uma reconexão (o log com as duas edições): continua UMA bolha", async () => {
    renderSdkChat();
    const ws = await socket();
    ws.accept();
    ws.deliver({ type: "user", text: A, at: 1 });
    ws.deliver({ type: "message_edited", originalText: A });
    ws.deliver({ type: "user", text: A, at: 2 });
    ws.deliver({ type: "message_edited", originalText: A });
    ws.deliver({ type: "user", text: A, at: 3 });
    ws.deliver({ type: "assistant_text", text: "Explicando de forma simples." });
    ws.deliver({ type: "ready" });

    const bubbles = screen.getAllByTestId("sdk-user");
    expect(bubbles).toHaveLength(1);
    expect(bubbles[0]).toHaveAttribute("data-revision", "true");
    expect(screen.getAllByTestId("sdk-edit")).toHaveLength(1);
  });
});

/**
 * THE PRODUCTION SEQUENCE (card mcp-chat-gpt, 2026-10-19): the first message died on an
 * authentication error and was resent with the SAME words. Editing the FIRST bubble had to leave only the
 * new version — but screen, log and driver find the message by its words and picked the newest copy:
 * "ficou como se eu tivesse editado a segunda".
 */
describe("SdkChatView — editar a PRIMEIRA mensagem, reenviada com as mesmas palavras", () => {
  const A = "preciso que voce crie um mcp para o vibehub";
  const ERRO = "Failed to authenticate: OAuth token revoked.";

  async function textbox(): Promise<HTMLTextAreaElement> {
    return (await screen.findByLabelText(/Enter/)) as HTMLTextAreaElement;
  }

  it("o frame diz `first`, e o rebobinar deixa só a mensagem nova", async () => {
    renderSdkChat();
    const ws = await socket();
    ws.accept();
    ws.deliver({ type: "user", text: A, at: 1 });
    ws.deliver({ type: "assistant_text", text: ERRO });
    ws.deliver({ type: "user", text: A, at: 2 });
    ws.deliver({ type: "assistant_text", text: ERRO });
    ws.deliver({ type: "ready" });
    expect(screen.getAllByTestId("sdk-user")).toHaveLength(2);

    await userEvent.click(screen.getAllByTestId("sdk-edit")[0]!);
    const box = await textbox();
    await userEvent.clear(box);
    await userEvent.type(box, "nova versão{Enter}");
    await waitFor(() => expect(ws.sent.length).toBe(1));
    const frame = JSON.parse(ws.sent[0]!) as { type: string; original: string; text: string; cid: string; first?: boolean };
    expect(frame).toMatchObject({ type: "edit_user", original: A, text: "nova versão", first: true });
    ws.deliver({ type: "user_ack", cid: frame.cid } as SdkEvent);
    ws.deliver({ type: "rewound", ok: true, originalText: A, text: "nova versão", first: true } as SdkEvent);

    const bubbles = screen.getAllByTestId("sdk-user");
    expect(bubbles).toHaveLength(1);
    expect(bubbles[0]).toHaveTextContent("nova versão");
    expect(screen.queryByText(ERRO)).toBeNull();
  });

  it("editar a SEGUNDA cópia não é `first` (a regra de sempre)", async () => {
    renderSdkChat();
    const ws = await socket();
    ws.accept();
    ws.deliver({ type: "user", text: A, at: 1 });
    ws.deliver({ type: "assistant_text", text: ERRO });
    ws.deliver({ type: "user", text: A, at: 2 });
    ws.deliver({ type: "assistant_text", text: ERRO });
    ws.deliver({ type: "ready" });

    await userEvent.click(screen.getAllByTestId("sdk-edit")[1]!);
    const box = await textbox();
    await userEvent.clear(box);
    await userEvent.type(box, "nova versão{Enter}");
    await waitFor(() => expect(ws.sent.length).toBe(1));
    expect(JSON.parse(ws.sent[0]!)).not.toHaveProperty("first");
  });
});

/**
 * RELOADING DOES NOT STOP THE AI. The tab reloads by itself on a new vibehub version (lib/versionCheck)
 * and the person presses F5 whenever they want: neither of the two may interrupt the work. The turn lives on the
 * server (manager.test: "sem página, turno vivo"); the screen side is this one — leaving the page in the middle
 * of a turn only closes the socket, never sends `interrupt`.
 */
describe("SdkChatView — sair da página no meio de um turno não interrompe nada", () => {
  it("desmontar com o turno rodando não manda interrupt", async () => {
    const { unmount } = renderSdkChat();
    const ws = await socket();
    ws.accept();
    ws.deliver({ type: "ready" });
    await userEvent.type(screen.getByRole("textbox"), "tarefa longa{Enter}");
    await waitFor(() => expect(ws.sent.length).toBe(1));
    ws.deliver({ type: "assistant_delta", text: "trabalhando" });
    ws.deliver({ type: "tool_use", id: "t1", name: "Bash", input: { command: "npm test" } });

    unmount();

    const types = ws.rawSent.map((raw) => (JSON.parse(raw) as { type?: string }).type);
    expect(types).not.toContain("interrupt");
  });
});

/** SEE WHAT CLAUDE IS DOING: each action says how it ended, and the click opens the detail. */
describe("SdkChatView — o detalhe de cada ação", () => {
  const detailAsks = (ws: FakeSocket) =>
    ws.sent.map((f) => JSON.parse(f) as { type: string; req?: string; id?: string; nonce?: string }).filter((f) => f.type === "detail");

  it("a linha mostra o resultado; o clique abre o modal com comando, saída e o porquê; as setas andam", async () => {
    renderSdkChat();
    const ws = await socket();
    ws.accept();
    ws.deliver({ type: "ready" });
    ws.deliver({ type: "user", text: "lista as PRs" });
    ws.deliver({ type: "tool_use", id: "b1", name: "Bash", input: { command: "gh pr list", description: "Lista as PRs" } });
    expect(screen.getByTestId("sdk-tool")).toHaveAttribute("data-status", "running");
    ws.deliver({ type: "tool_result", id: "b1", toolResult: { lines: 7 } });
    ws.deliver({ type: "tool_use", id: "b2", name: "Bash", input: { command: "false" } });
    ws.deliver({ type: "tool_result", id: "b2", toolResult: { isError: true, error: "saiu com código 1" } });
    const [first, second] = screen.getAllByTestId("sdk-tool");
    expect(first).toHaveAttribute("data-status", "ok");
    expect(within(first!).getByTestId("sdk-tool-result")).toHaveTextContent("7 lines");
    expect(second).toHaveAttribute("data-status", "error");
    expect(within(second!).getByTestId("sdk-tool-result")).toHaveTextContent("error: saiu com código 1");

    fireEvent.click(first!);
    const dialog = await screen.findByTestId("sdk-detail");
    expect(dialog).toHaveAttribute("data-view", "action");
    await waitFor(() => expect(detailAsks(ws).some((f) => f.req === "tool" && f.id === "b1")).toBe(true));
    const ask = detailAsks(ws).find((f) => f.id === "b1")!;
    ws.deliver({ type: "detail", req: "tool", id: "b1", nonce: ask.nonce, data: { found: true, by: "main", name: "Bash", input: { command: "gh pr list" }, structured: { stdout: "#510 a\n#511 b\n", stderr: "" }, thinking: "Primeiro a lista.", result: { lines: 2 } } } as never);
    expect(await within(dialog).findByTestId("sdk-detail-why")).toHaveTextContent("Primeiro a lista.");
    expect(within(dialog).getByText("#510 a")).toBeInTheDocument();
    expect(within(dialog).getByTestId("sdk-detail-position")).toHaveTextContent("1 of 2");

    fireEvent.click(within(dialog).getByTestId("sdk-detail-next"));
    await waitFor(() => expect(within(screen.getByTestId("sdk-detail")).getByTestId("sdk-detail-position")).toHaveTextContent("2 of 2"));
    await waitFor(() => expect(detailAsks(ws).some((f) => f.req === "tool" && f.id === "b2")).toBe(true));
  });

  it("comando ainda rodando: diz que roda (não 'terminou sem imprimir'), pede de novo e mostra a saída quando termina", async () => {
    renderSdkChat();
    const ws = await socket();
    ws.accept();
    ws.deliver({ type: "ready" });
    ws.deliver({ type: "tool_use", id: "r1", name: "Bash", input: { command: "npx vitest run" } });
    fireEvent.click(screen.getByTestId("sdk-tool"));
    const dialog = await screen.findByTestId("sdk-detail");
    await waitFor(() => expect(detailAsks(ws).filter((f) => f.id === "r1")).toHaveLength(1));
    const first = detailAsks(ws).find((f) => f.id === "r1")!;
    // The transcript only has the call: no result yet.
    ws.deliver({ type: "detail", req: "tool", id: "r1", nonce: first.nonce, data: { found: true, by: "main", name: "Bash", input: { command: "npx vitest run" }, startedAt: 1 } } as never);
    expect(await within(dialog).findByTestId("sdk-detail-pending")).toHaveTextContent("Still running");
    expect(within(dialog).queryByText("The command finished without printing anything.")).toBeNull();
    expect(within(dialog).queryByTestId("sdk-detail-missing")).toBeNull();

    // The command finishes: the modal asks again by itself and shows the output.
    ws.deliver({ type: "tool_result", id: "r1", toolResult: { lines: 1 } });
    await waitFor(() => expect(detailAsks(ws).filter((f) => f.id === "r1").length).toBeGreaterThan(1));
    const again = detailAsks(ws).filter((f) => f.id === "r1").at(-1)!;
    ws.deliver({ type: "detail", req: "tool", id: "r1", nonce: again.nonce, data: { found: true, by: "main", name: "Bash", input: { command: "npx vitest run" }, structured: { stdout: "Tests 12 passed\n", stderr: "" }, result: { lines: 1 }, startedAt: 1, endedAt: 2 } } as never);
    expect(await within(dialog).findByText("Tests 12 passed")).toBeInTheDocument();
    expect(within(dialog).queryByTestId("sdk-detail-pending")).toBeNull();
  });

  it("ação rodando que ainda não chegou no transcript: diz que roda, não 'conversa apagada'", async () => {
    renderSdkChat();
    const ws = await socket();
    ws.accept();
    ws.deliver({ type: "ready" });
    ws.deliver({ type: "tool_use", id: "n1", name: "Bash", input: { command: "sleep 60" } });
    fireEvent.click(screen.getByTestId("sdk-tool"));
    const dialog = await screen.findByTestId("sdk-detail");
    await waitFor(() => expect(detailAsks(ws).some((f) => f.id === "n1")).toBe(true));
    const ask = detailAsks(ws).find((f) => f.id === "n1")!;
    ws.deliver({ type: "detail", req: "tool", id: "n1", nonce: ask.nonce, data: { found: false } } as never);
    expect(await within(dialog).findByTestId("sdk-detail-pending")).toHaveTextContent("Still running");
    expect(within(dialog).queryByTestId("sdk-detail-missing")).toBeNull();
  });

  it("comando em segundo plano: mostra a saída real e acompanha ao vivo até a tarefa terminar", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      renderSdkChat();
      const ws = await socket();
      ws.accept();
      ws.deliver({ type: "ready" });
      ws.deliver({ type: "tool_use", id: "g1", name: "Bash", input: { command: "npm run dev", run_in_background: true } });
      ws.deliver({ type: "tool_result", id: "g1", toolResult: { background: true } });
      fireEvent.click(screen.getByTestId("sdk-tool"));
      const dialog = await screen.findByTestId("sdk-detail");
      await waitFor(() => expect(detailAsks(ws).some((f) => f.id === "g1")).toBe(true));
      const base = { found: true, by: "main", name: "Bash", input: { command: "npm run dev", run_in_background: true }, text: "Command running in background with ID: bx1.", structured: { stdout: "", stderr: "", backgroundTaskId: "bx1" }, result: { lines: 1 } };
      ws.deliver({ type: "detail", req: "tool", id: "g1", nonce: detailAsks(ws).at(-1)!.nonce, data: { ...base, background: { taskId: "bx1", status: "running", output: "subindo\n", outputLength: 8 } } } as never);
      expect(await within(dialog).findByText("subindo")).toBeInTheDocument();
      expect(within(dialog).getByTestId("sdk-detail-status")).toHaveAttribute("data-status", "running");
      expect(within(dialog).getByTestId("sdk-detail-bg")).toHaveAttribute("data-bg-status", "running");
      expect(within(dialog).queryByText("The command finished without printing anything.")).toBeNull();

      // Running in the background: it asks again by itself and the output grows on screen.
      const asked = detailAsks(ws).filter((f) => f.id === "g1").length;
      await act(async () => { await vi.advanceTimersByTimeAsync(ACTION_POLL_MS + 100); });
      await waitFor(() => expect(detailAsks(ws).filter((f) => f.id === "g1").length).toBeGreaterThan(asked));
      ws.deliver({ type: "detail", req: "tool", id: "g1", nonce: detailAsks(ws).at(-1)!.nonce, data: { ...base, background: { taskId: "bx1", status: "completed", output: "subindo\npronto\n", outputLength: 15 } } } as never);
      expect(await within(dialog).findByText("pronto")).toBeInTheDocument();
      await waitFor(() => expect(within(dialog).getByTestId("sdk-detail-status")).toHaveAttribute("data-status", "ok"));

      // Finished: it stops asking.
      const done = detailAsks(ws).filter((f) => f.id === "g1").length;
      await act(async () => { await vi.advanceTimersByTimeAsync(ACTION_POLL_MS * 3); });
      expect(detailAsks(ws).filter((f) => f.id === "g1").length).toBe(done);
    } finally {
      vi.useRealTimers();
    }
  });

  it("sondagem que falhou ou não achou ainda: continua carregando e pede de novo, nunca desiste", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      renderSdkChat();
      const ws = await socket();
      ws.accept();
      ws.deliver({ type: "ready" });
      ws.deliver({ type: "tool_use", id: "f1", name: "Bash", input: { command: "ls" } });
      ws.deliver({ type: "tool_result", id: "f1", toolResult: { lines: 1 } });
      fireEvent.click(screen.getByTestId("sdk-tool"));
      const dialog = await screen.findByTestId("sdk-detail");
      await waitFor(() => expect(detailAsks(ws).some((f) => f.id === "f1")).toBe(true));
      ws.deliver({ type: "detail", req: "tool", id: "f1", nonce: detailAsks(ws).at(-1)!.nonce, error: "probe-failed" } as never);
      expect(await within(dialog).findByTestId("sdk-detail-loading")).toBeInTheDocument();
      expect(within(dialog).queryByTestId("sdk-detail-missing")).toBeNull();

      let asked = detailAsks(ws).filter((f) => f.id === "f1").length;
      await act(async () => { await vi.advanceTimersByTimeAsync(ACTION_POLL_MS + 100); });
      await waitFor(() => expect(detailAsks(ws).filter((f) => f.id === "f1").length).toBeGreaterThan(asked));
      ws.deliver({ type: "detail", req: "tool", id: "f1", nonce: detailAsks(ws).at(-1)!.nonce, data: { found: false } } as never);
      await act(async () => { await vi.advanceTimersByTimeAsync(10); });
      expect(within(dialog).queryByTestId("sdk-detail-missing")).toBeNull();
      expect(within(dialog).getByTestId("sdk-detail-loading")).toBeInTheDocument();

      asked = detailAsks(ws).filter((f) => f.id === "f1").length;
      await act(async () => { await vi.advanceTimersByTimeAsync(ACTION_POLL_MS + 100); });
      await waitFor(() => expect(detailAsks(ws).filter((f) => f.id === "f1").length).toBeGreaterThan(asked));
      ws.deliver({ type: "detail", req: "tool", id: "f1", nonce: detailAsks(ws).at(-1)!.nonce, data: { found: true, by: "main", name: "Bash", input: { command: "ls" }, structured: { stdout: "README.md\n", stderr: "" }, result: { lines: 1 } } } as never);
      expect(await within(dialog).findByText("README.md")).toBeInTheDocument();
      expect(within(dialog).queryByTestId("sdk-detail-loading")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("reabrir o modal mostra na hora o detalhe que já veio, sem 'Carregando' de novo", async () => {
    renderSdkChat();
    const ws = await socket();
    ws.accept();
    ws.deliver({ type: "ready" });
    ws.deliver({ type: "tool_use", id: "c1", name: "Bash", input: { command: "ls" } });
    ws.deliver({ type: "tool_result", id: "c1", toolResult: { lines: 1 } });
    fireEvent.click(screen.getByTestId("sdk-tool"));
    let dialog = await screen.findByTestId("sdk-detail");
    await waitFor(() => expect(detailAsks(ws).some((f) => f.id === "c1")).toBe(true));
    const ask = detailAsks(ws).find((f) => f.id === "c1")!;
    ws.deliver({ type: "detail", req: "tool", id: "c1", nonce: ask.nonce, data: { found: true, by: "main", name: "Bash", input: { command: "ls" }, structured: { stdout: "README.md\n", stderr: "" }, result: { lines: 1 } } } as never);
    expect(await within(dialog).findByText("README.md")).toBeInTheDocument();

    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(screen.queryByTestId("sdk-detail")).toBeNull());
    fireEvent.click(screen.getByTestId("sdk-tool"));
    dialog = await screen.findByTestId("sdk-detail");
    expect(within(dialog).getByText("README.md")).toBeInTheDocument();
    expect(within(dialog).queryByTestId("sdk-detail-loading")).toBeNull();
    // And it still asks again, to refresh on top.
    await waitFor(() => expect(detailAsks(ws).filter((f) => f.id === "c1")).toHaveLength(2));
  });

  it("a bandeja de segundo plano abre o subagente da tarefa", async () => {
    renderSdkChat();
    const ws = await socket();
    ws.accept();
    ws.deliver({ type: "ready" });
    ws.deliver({ type: "tool_use", id: "t9", name: "Agent", input: { description: "Review PR 510", run_in_background: true } });
    ws.deliver({ type: "background_tasks", tasks: [{ id: "k9", type: "local_agent", description: "Review PR 510", toolUseId: "t9" }] });
    const task = screen.getByTestId("sdk-background-task");
    expect(task).toHaveAttribute("data-clickable", "true");
    fireEvent.click(task);
    expect(await screen.findByTestId("sdk-detail")).toHaveAttribute("data-view", "agent");
    await waitFor(() => expect(detailAsks(ws).some((f) => f.req === "agent" && f.id === "t9")).toBe(true));
  });

  it("Mudanças lista os arquivos que o Claude alterou", async () => {
    renderSdkChat();
    const ws = await socket();
    ws.accept();
    ws.deliver({ type: "ready" });
    ws.deliver({ type: "tool_use", id: "e1", name: "Edit", input: { file_path: "/w/a.ts", old_string: "a", new_string: "b" } });
    ws.deliver({ type: "tool_result", id: "e1", toolResult: { added: 1, removed: 1 } });
    expect(screen.getByTestId("sdk-changes")).toHaveTextContent("+1");
    fireEvent.click(screen.getByTestId("sdk-changes"));
    const dialog = await screen.findByTestId("sdk-detail");
    expect(dialog).toHaveAttribute("data-view", "changes");
    expect(within(dialog).getByTestId("sdk-changes-file")).toHaveTextContent("a.ts");
  });
});

/** The F5 in the middle of loading (production, 2026-10-20) — see `send` and `outboxToQueue`. */
describe("SdkChatView — mensagem enviada durante o carregamento sobrevive ao F5", () => {
  beforeEach(() => localStorage.clear());

  it("enviada com o chat carregando, F5 antes do recibo: no reload ela sai sozinha, sem 'não entregue'", async () => {
    const { unmount } = renderSdkChat();
    const first = await socket();
    first.accept(); // the handshake finished, but the back is still setting up the connection (no `ready`)
    first.deliver({ type: "user", text: "pedido antigo", at: 1 });
    await userEvent.type(screen.getByRole("textbox"), "atualize meus prs com dev{Enter}");
    // Nothing goes out before `ready`: the back would only keep it in a buffer that the F5 throws away.
    expect(first.sent).toHaveLength(0);
    expect(screen.getByTestId("sdk-queued")).toHaveTextContent("atualize meus prs com dev");

    // F5 before `ready`.
    unmount();
    renderSdkChat();
    await waitFor(() => expect(FakeSocket.instances.length).toBe(2));
    const second = FakeSocket.instances[1] as FakeSocket;
    second.accept();
    second.deliver({ type: "user", text: "pedido antigo", at: 1 }); // the server does not have the new one
    second.deliver({ type: "ready" });

    await waitFor(() => expect(second.sent).toHaveLength(1));
    const frame = JSON.parse(second.sent[0]!) as { type: string; text: string; cid: string };
    expect(frame).toMatchObject({ type: "user", text: "atualize meus prs com dev" });
    expect(screen.getAllByTestId("sdk-user")).toHaveLength(2);
    expect(screen.getAllByTestId("sdk-user")[1]).toHaveAttribute("data-state", "sending");
    expect(screen.queryByTestId("sdk-user-undelivered")).not.toBeInTheDocument();
    expect(screen.queryByTestId("sdk-queued")).not.toBeInTheDocument();

    // The receipt arrives: the copy on disk is forgotten, the bubble is a normal message.
    second.deliver({ type: "user_ack", cid: frame.cid } as SdkEvent);
    await waitFor(() => expect(screen.getAllByTestId("sdk-user")[1]).toHaveAttribute("data-state", "sent"));
    await waitFor(() => expect(localStorage.getItem("vibehub.sdkOutbox.c1")).toBeNull());
  });

  it("volta pra FRENTE da fila: o que foi escrito antes sai antes", async () => {
    localStorage.setItem(
      "vibehub.sdkOutbox.c1",
      JSON.stringify([{ cid: "c-perdido", text: "primeira", at: Date.now() - 2_000 }]),
    );
    localStorage.setItem(
      "vibehub.sdkQueue.c1",
      JSON.stringify([{ id: "q-depois", text: "segunda", at: Date.now() - 1_000 }]),
    );
    renderSdkChat();
    const ws = await socket();
    ws.accept();
    ws.deliver({ type: "ready" });

    await waitFor(() => expect(ws.sent).toHaveLength(1));
    expect(JSON.parse(ws.sent[0]!)).toMatchObject({ type: "user", text: "primeira" });
    expect(screen.getByTestId("sdk-queued")).toHaveTextContent("segunda");
  });

  // The message written during the card's "Preparando…" (CardTerminalView) waits in this queue, before the
  // chat exists: it finds it when mounting and delivers it when the server becomes ready.
  it("a fila deixada pelo 'Preparando…' do card sai quando o chat fica pronto", async () => {
    localStorage.setItem(
      "vibehub.sdkQueue.c1",
      JSON.stringify([{ id: "q-prep", text: "comece pelo schema", at: Date.now() - 1_000 }]),
    );
    renderSdkChat();
    const ws = await socket();
    ws.accept();
    expect(screen.getByTestId("sdk-queued")).toHaveTextContent("comece pelo schema");
    ws.deliver({ type: "ready" });

    await waitFor(() => expect(ws.sent).toHaveLength(1));
    expect(JSON.parse(ws.sent[0]!)).toMatchObject({ type: "user", text: "comece pelo schema" });
    expect(screen.queryByTestId("sdk-queued")).not.toBeInTheDocument();
  });

  it("mensagem VELHA sem recibo (aba fechada há dias) não vira turno sozinha: volta marcada", async () => {
    localStorage.setItem(
      "vibehub.sdkOutbox.c1",
      JSON.stringify([{ cid: "c-velho", text: "sobe pra prod", at: Date.now() - 3 * 24 * 3_600_000 }]),
    );
    renderSdkChat();
    const ws = await socket();
    ws.accept();
    ws.deliver({ type: "ready" });

    expect(await screen.findByTestId("sdk-user-undelivered")).toBeInTheDocument();
    expect(ws.sent).toHaveLength(0);
  });
});

/**
 * The /btw: the SIDE question, asked precisely with the turn running. Waiting in the queue would mean waiting for the
 * end of the turn — the opposite of the command —, so it goes out right away, does not light "Preparando…" and the
 * answer shows up as its own row, never as a Claude bubble.
 */
describe("SdkChatView — /btw", () => {
  it("com o fio caído NÃO vai pra fila (lá viraria um turno do agente): avisa e mantém as palavras", async () => {
    renderSdkChat();
    const first = await socket();
    first.accept();
    first.deliver({ type: "ready" });
    act(() => { first.readyState = 3; first.onclose?.(); });

    await userEvent.type(screen.getByRole("textbox"), "/btw o que falta?{Enter}");

    expect(first.sent).toHaveLength(0);
    expect(screen.queryByTestId("sdk-queued")).not.toBeInTheDocument();
    expect(screen.queryByTestId("sdk-btw")).not.toBeInTheDocument();
    expect(screen.getByRole("textbox")).toHaveValue("/btw o que falta?");
  });

  it("com o turno rodando, NÃO espera na fila: sai na hora e a resposta vira linha própria", async () => {
    renderSdkChat();
    const ws = await socket();
    ws.accept();
    ws.deliver({ type: "ready" });
    const box = (await screen.findByLabelText(/Enter/)) as HTMLTextAreaElement;
    await userEvent.type(box, "faz a tarefa{Enter}");
    await waitFor(() => expect(ws.sent.length).toBe(1));
    ws.deliver({ type: "assistant_delta", text: "Fazendo…" }); // the turn is running

    await userEvent.type(box, "/btw o que falta?{Enter}");
    await waitFor(() => expect(ws.sent.length).toBe(2));
    const frame = JSON.parse(ws.sent[1]!) as { type: string; id: string; question: string };
    expect(frame).toMatchObject({ type: "btw", question: "o que falta?" });
    expect(screen.queryByTestId("sdk-queue")).toBeNull();
    const pendente = await screen.findByTestId("sdk-btw");
    expect(pendente).toHaveTextContent("o que falta?");
    expect(within(pendente).getByLabelText(/Answering…|Respondendo…/)).toBeInTheDocument();
    expect(pendente).not.toHaveTextContent(/Side question|Pergunta lateral/);
    expect(within(pendente).getByTitle(/Side question|Pergunta lateral/)).toBeInTheDocument();
    // Highlighted with its own header, so it does not get lost in the middle of the turn's reasoning.
    expect(pendente).toHaveTextContent(/\/btw · (you asked|você perguntou)/);

    ws.deliver({ type: "btw_answer", id: frame.id, question: "o que falta?", text: "falta abrir o PR" });
    await waitFor(() => expect(screen.getByTestId("sdk-btw")).toHaveTextContent("falta abrir o PR"));
    expect(screen.getAllByTestId("sdk-btw")).toHaveLength(1);
    const row = screen.getByTestId("sdk-btw");
    expect(row).toHaveTextContent("o que falta?");
    expect(row).toHaveTextContent("falta abrir o PR");
    expect(within(row).queryByLabelText(/Answering…|Respondendo…/)).toBeNull();
  });
});

/**
 * The /compact: the CLI spends seconds to a minute summarizing the conversation without saying a word. The screen
 * shows the bar running meanwhile and, at the end, the divider with how much the conversation took up.
 */
describe("SdkChatView — compactação", () => {
  beforeEach(() => setLanguage("pt-BR"));
  afterEach(() => resetLanguage());

  it("a barra roda enquanto o CLI compacta e vira o divisor com os tokens quando termina", async () => {
    renderSdkChat();
    const ws = await socket();
    ws.accept();
    ws.deliver({ type: "ready" });
    ws.deliver({ type: "compaction", phase: "started", trigger: "manual", startedAt: Date.now() });

    const running = await screen.findByTestId("sdk-compaction");
    expect(running).toHaveAttribute("data-status", "running");
    expect(running).toHaveTextContent("Compactando a conversa…");
    expect(within(running).getByRole("progressbar")).toBeInTheDocument();
    expect(screen.getByTestId("sdk-compaction-elapsed")).toHaveTextContent(/^0:0\d$/);

    ws.deliver({ type: "compaction", phase: "done", trigger: "manual", preTokens: 180_000, postTokens: 22_000, durationMs: 14_000 });
    await waitFor(() => expect(screen.getByTestId("sdk-compaction")).toHaveAttribute("data-status", "done"));
    const done = screen.getByTestId("sdk-compaction");
    expect(screen.getAllByTestId("sdk-compaction")).toHaveLength(1);
    expect(done).toHaveTextContent("Conversa compactada");
    expect(done).toHaveTextContent("180 mil → 22 mil tokens");
    expect(done).toHaveTextContent("−88%");
    expect(within(done).queryByRole("progressbar")).toBeNull();
  });

  it("a falha vira o divisor com o motivo do CLI", async () => {
    renderSdkChat();
    const ws = await socket();
    ws.accept();
    ws.deliver({ type: "ready" });
    ws.deliver({ type: "compaction", phase: "started", trigger: "manual", startedAt: Date.now() });
    ws.deliver({ type: "compaction", phase: "failed", error: "Not enough messages to compact." });
    await waitFor(() => expect(screen.getByTestId("sdk-compaction")).toHaveAttribute("data-status", "failed"));
    expect(screen.getByTestId("sdk-compaction")).toHaveTextContent("Compactação não concluída");
    expect(screen.getByTestId("sdk-compaction")).toHaveTextContent("Not enough messages to compact.");
  });
});

/**
 * THE SENT COMMAND (`/context`, `/compact`…) shows up as the command it is — the chip with the status —,
 * not as a loose sentence that seemed to have done nothing.
 */
describe("SdkChatView — comando do catálogo", () => {
  beforeEach(() => setLanguage("pt-BR"));
  afterEach(() => resetLanguage());

  it("o /context enviado vira o chip, executando até o turno fechar", async () => {
    renderSdkChat();
    const ws = await socket();
    ws.accept();
    ws.deliver({ type: "ready" });
    ws.deliver({ type: "catalog", commands: [{ name: "context", source: "command" }] });
    const box = (await screen.findByLabelText(/Enter/)) as HTMLTextAreaElement;
    await userEvent.type(box, "/context{Escape}{Enter}");
    await waitFor(() => expect(ws.sent.length).toBe(1));

    const chip = await screen.findByTestId("sdk-command");
    expect(chip).toHaveAttribute("data-command", "context");
    expect(chip).toHaveTextContent("/context");
    expect(chip).toHaveTextContent("executando…");

    ws.deliver({ type: "local_output", text: "Context Usage 84k/200k" });
    ws.deliver({ type: "result", subtype: "success" });
    await waitFor(() => expect(screen.getByTestId("sdk-command")).toHaveTextContent("executado"));
    expect(screen.getByTestId("sdk-command")).not.toHaveAttribute("data-running");
    expect(screen.getByTestId("sdk-command-output")).toHaveTextContent("Context Usage");
  });

  it("uma frase que só cita um comando continua sendo a bolha de sempre", async () => {
    renderSdkChat();
    const ws = await socket();
    ws.accept();
    ws.deliver({ type: "ready" });
    ws.deliver({ type: "catalog", commands: [{ name: "context", source: "command" }] });
    const box = (await screen.findByLabelText(/Enter/)) as HTMLTextAreaElement;
    await userEvent.type(box, "roda o /context depois{Enter}");
    await waitFor(() => expect(ws.sent.length).toBe(1));
    expect(await screen.findByTestId("sdk-user")).toHaveTextContent("roda o /context depois");
    expect(screen.queryByTestId("sdk-command")).toBeNull();
  });
});
