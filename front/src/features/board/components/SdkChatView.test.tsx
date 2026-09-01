import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { act } from "react";
import { SdkChatView } from "@/features/board/components/SdkChatView";
import { renderApp } from "@/test/render";
import type { SdkEvent } from "@/features/board/lib/sdkChat";

vi.mock("@/lib/api", () => ({
  api: { interceptors: { response: { use: vi.fn() } } },
  setUnauthorizedHandler: vi.fn(),
  get: vi.fn(() => Promise.resolve({ available: false, proofread: false, language: null })),
  post: vi.fn(() => Promise.resolve({ ok: true })),
  patch: vi.fn(),
  del: vi.fn(),
}));

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
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;

  constructor(public url: string) {
    FakeSocket.instances.push(this);
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.readyState = 3;
  }

  accept(): void {
    this.readyState = 1;
    act(() => this.onopen?.());
  }
  deliver(event: SdkEvent): void {
    act(() => this.onmessage?.({ data: JSON.stringify(event) } as MessageEvent));
  }
}

const originalWebSocket = globalThis.WebSocket;

beforeEach(() => {
  vi.clearAllMocks();
  FakeSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeSocket);
});

afterEach(() => {
  vi.unstubAllGlobals();
  globalThis.WebSocket = originalWebSocket;
});

async function socket(): Promise<FakeSocket> {
  await waitFor(() => expect(FakeSocket.instances.length).toBeGreaterThan(0));
  return FakeSocket.instances[0] as FakeSocket;
}

function renderSdkChat(props: Partial<React.ComponentProps<typeof SdkChatView>> = {}) {
  return renderApp(<SdkChatView cardId="c1" {...props} />);
}

describe("SdkChatView", () => {
  it("opens the SDK socket for the card and reports its state", async () => {
    const onStatus = vi.fn();
    renderSdkChat({ onStatus });
    const ws = await socket();
    expect(ws.url).toContain("/api/cards/c1/sdk");
    ws.accept();
    expect(onStatus).toHaveBeenCalledWith("open");
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
    expect(JSON.parse(ws.sent[0]!)).toEqual({ type: "user", text: "roda os testes" });
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
