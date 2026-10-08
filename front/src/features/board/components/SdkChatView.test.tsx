import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { act } from "react";
import { OUTBOX_TICK_MS, SdkChatView } from "@/features/board/components/SdkChatView";
import { OUTBOX_ACK_TIMEOUT_MS } from "@/features/board/lib/sdkOutbox";
import { RECONNECT_MAX_MS } from "@/features/board/lib/reconnect";
import { PEER_TYPING_TTL_MS } from "@/features/board/lib/peerTyping";
import { renderApp } from "@/test/render";
import type { SdkEvent } from "@/features/board/lib/sdkChat";
import { resetLanguage, setLanguage } from "@/i18n";
import { resetReasoningTranslatorForTesting } from "@/features/board/lib/reasoningTranslation";
import { get } from "@/lib/api";
import { LinkifiedText } from "@/features/board/components/ChatView";
import { resetDraftsForTesting } from "@/features/board/components/TerminalComposer";
import { ME_KEY } from "@/providers/auth";

vi.mock("@/lib/api", () => ({
  api: { interceptors: { response: { use: vi.fn() } } },
  setUnauthorizedHandler: vi.fn(),
  get: vi.fn(() => Promise.resolve({ available: false, proofread: false, language: null })),
  post: vi.fn(() => Promise.resolve({ ok: true })),
  patch: vi.fn(),
  del: vi.fn(),
}));

// Passthrough com contador: o desenho é o de verdade, e quantas vezes uma bolha foi redesenhada
// fica observável (o teste de custo do transcript, mais abaixo).
vi.mock("@/features/board/components/ChatView", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/features/board/components/ChatView")>();
  return { ...actual, LinkifiedText: vi.fn(actual.LinkifiedText) };
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
  /** TUDO que saiu pelo socket, handshake incluído — o que os testes do handshake leem. */
  rawSent: string[] = [];
  /**
   * Os frames da CONVERSA. O `typing` é sinal efêmero entre abas, não fala de ninguém: contá-lo aqui
   * faria cada teste que mede "saiu UMA mensagem" medir duas.
   */
  get sent(): string[] {
    return this.rawSent.filter((raw) => {
      try {
        const type = (JSON.parse(raw) as { type?: string }).type;
        return type !== "typing";
      } catch { return true; }
    });
  }
  /** Só os sinais de "está digitando" que esta aba mandou, em ordem. */
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
  deliver(event: SdkEvent): void {
    act(() => this.onmessage?.({ data: JSON.stringify(event) } as MessageEvent));
  }
}

const originalWebSocket = globalThis.WebSocket;

beforeEach(() => {
  vi.clearAllMocks();
  // O composer guarda o rascunho de cada card num mapa do MÓDULO (sobrevive a um remount de
  // propósito) — e todo teste aqui é o card "c1": o que um teste deixou no campo era digitado no
  // seguinte ("vai pelo A mesmoinstrução longa", com a ordem embaralhada).
  resetDraftsForTesting();
  FakeSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeSocket);
});

afterEach(() => {
  vi.unstubAllGlobals();
  globalThis.WebSocket = originalWebSocket;
  // `setLanguage` grava a escolha no localStorage e `resetLanguage` a RELÊ de lá — e a limpeza do
  // storage do setup só roda depois deste gancho. Sem limpar antes, um teste em pt-BR deixava o
  // arquivo inteiro em pt-BR para quem viesse depois.
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
   * O APERTO DE MÃO NÃO É SAÚDE. O back aceita o websocket e só DEPOIS descobre que não pode
   * atendê-lo (driver desligado, card apagado, install falhou): manda o erro e fecha. Zerar o
   * backoff no `onopen` fazia disso uma reconexão a ~2Hz para sempre — cada uma pagando o setup
   * inteiro do servidor (sessão, settings, e no install, SSH+docker). Só o `ready` prova a conexão.
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
      // a segunda recusa espera MAIS que a primeira (o backoff andou), não volta aos 400ms
      await act(async () => { await vi.advanceTimersByTimeAsync(600); });
      expect(FakeSocket.instances).toHaveLength(2);
      await act(async () => { await vi.advanceTimersByTimeAsync(600); });
      expect(FakeSocket.instances).toHaveLength(3);

      // uma conexão que o servidor ASSUMIU (`ready`) zera: a queda seguinte volta a ser um piscar
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
    // the original dims with the badge; the new version stands; edit mode is over
    const bubbles = screen.getAllByTestId("sdk-user");
    expect(bubbles[0]).toHaveAttribute("data-edited", "true");
    expect(screen.getByTestId("sdk-user-edited")).toHaveTextContent(/editada|edited/);
    expect(bubbles[1]).toHaveTextContent("sobe pra dev");
    expect(screen.queryByTestId("composer-editing")).not.toBeInTheDocument();
  });

  /**
   * O PEDIDO DO CÉSAR (2026-09-28): "clico em editar, mudo de ideia, e o turno foi interrompido".
   *
   * O lápis abria o campo E MATAVA o turno na hora — antes de existir um único caractere da nova
   * versão. Só que clicar em editar não é uma decisão: é abrir a possibilidade de uma. Quem
   * desistiu não pediu nada, e um turno cortado não se descorta — a tela ficava oferecendo
   * "continuar de onde parou" para consertar um estrago que ela mesma tinha feito, e o histórico
   * ganhava uma nota explicando uma interrupção que ninguém quis.
   *
   * A regra agora: quem para o turno é a CORREÇÃO ENVIADA, nunca o gesto de abrir o campo. O preço
   * é conhecido e é o menor dos dois: entre o lápis e o Enter o agente segue trabalhando na
   * mensagem antiga. Trabalho a mais é recuperável; um turno morto por engano, não.
   */
  it("o lápis MID-TURN não para o turno — abrir o campo não é uma decisão", async () => {
    renderSdkChat();
    const ws = await socket();
    ws.accept();
    ws.deliver({ type: "ready" });

    const box = await textbox();
    await userEvent.type(box, "sobe pra prod{Enter}");
    await waitFor(() => expect(ws.sent.length).toBe(1));
    ws.deliver({ type: "assistant_delta", text: "Subindo…" }); // o turno está visivelmente rodando

    await userEvent.click(screen.getByTestId("sdk-edit"));

    expect(ws.sent.length).toBe(1); // nada saiu além da própria mensagem: nenhum interrupt
    expect(screen.getByTestId("composer-editing")).toBeInTheDocument(); // o campo abriu
    expect(screen.getByTestId("sdk-chat-working")).toBeInTheDocument(); // e o turno segue de pé
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

    fireEvent.keyDown(box, { key: "Escape" }); // mudei de ideia

    expect(ws.sent.length).toBe(1); // o turno nunca foi tocado
    expect(screen.getByTestId("sdk-chat-working")).toBeInTheDocument(); // e continua rodando
    expect(screen.queryByTestId("composer-editing")).not.toBeInTheDocument();
    // …e não sobra oferta nenhuma de "continuar": não houve o que interromper.
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

    // AGORA sim: a decisão foi tomada, e ela para o turno que responde a mensagem superada.
    await waitFor(() => expect(ws.sent.length).toBe(2));
    expect(JSON.parse(ws.sent[1]!)).toEqual({ type: "interrupt", reason: "edit" });

    ws.deliver({ type: "result", isError: false, subtype: "aborted" });
    await waitFor(() => expect(ws.sent.length).toBe(3));
    expect(JSON.parse(ws.sent[2]!)).toMatchObject({ type: "edit_user", original: "sobe pra prod", text: "sobe pra dev" });
    // a correção substituiu o turno interrompido: nada de oferta para continuar o antigo
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

    const bubbles = screen.getAllByTestId("sdk-user");
    expect(bubbles[0]).toHaveAttribute("data-edited", "true");
    expect(bubbles[1]).not.toHaveAttribute("data-edited");
    // a superseded message offers no pencil — only the standing version does
    expect(screen.getAllByTestId("sdk-edit")).toHaveLength(1);
  });
});

describe("SdkChatView — mensagem dobrada no turno por OUTRO remetente (turn_absorbed)", () => {
  /**
   * O próprio campo não dobra mais nada em turno rodando — o que ele escreve ESPERA na fila (ver o
   * bloco "fila"). Mas a dobra continua existindo para quem manda por fora (o maestro, o MCP, outra
   * aba): a bolha sobe na conversa, SEM etiqueta. Quem está na tela vê a mensagem entrar no turno
   * em andamento; o "entrou no turno em andamento" por escrito só repetia o que já estava à vista.
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

    // outra origem mandou no meio do turno, e o driver dobrou no turno que já rodava
    ws.deliver({ type: "user", text: "aproveita e ajusta o título", from: { kind: "agent", name: "maestro" } });
    ws.deliver({ type: "turn_absorbed" });

    const bubbles = await screen.findAllByTestId("sdk-user");
    expect(bubbles[1]).toHaveTextContent("aproveita e ajusta o título");
    expect(screen.queryByTestId("sdk-user-absorbed")).toBeNull();
    expect(screen.queryByText(/entrou no turno em andamento|joined the running turn/)).toBeNull();
  });
});

describe("SdkChatView — escada de estados (Preparando → Pensando → Respondendo)", () => {
  it("cold driver: the send shows Preparando…, ready turns it into Pensando…, the first token into Respondendo…", async () => {
    renderSdkChat();
    const ws = await socket();
    ws.accept(); // socket open, driver still booting (no ready yet)

    const box = (await screen.findByLabelText(/Enter/)) as HTMLTextAreaElement;
    await userEvent.type(box, "oi{Enter}");
    await waitFor(() => expect(ws.sent.length).toBe(1));

    const indicator = screen.getByTestId("sdk-chat-working");
    expect(indicator).toHaveAttribute("data-phase", "preparing");

    ws.deliver({ type: "ready" });
    expect(screen.getByTestId("sdk-chat-working")).toHaveAttribute("data-phase", "thinking");

    // O primeiro token JÁ É a resposta sendo escrita — o indicador diz isso, em vez do
    // "Trabalhando…" genérico que não separava pensar de responder.
    ws.deliver({ type: "assistant_delta", text: "olá" });
    expect(screen.getByTestId("sdk-chat-working")).toHaveAttribute("data-phase", "answering");

    ws.deliver({ type: "result", isError: false });
    expect(screen.queryByTestId("sdk-chat-working")).not.toBeInTheDocument();
  });

  /**
   * O que o César não tinha: retorno visual. "Trabalhando…" é a mesma palavra no segundo 2 e no
   * minuto 9 — o indicador agora carrega o relógio e a nota de estado, e ela ESCALA.
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

      // O servidor confirma o recebimento, senão o outbox declara a mensagem não entregue no meio
      // do relógio e o indicador some — o que este teste mede é o turno vivo, não o outbox.
      const cid = (JSON.parse(ws.sent[0]!) as { cid: string }).cid;
      ws.deliver({ type: "user_ack", cid });

      const note = await screen.findByTestId("sdk-working-note");
      expect(note).toHaveTextContent(/0s/);
      expect(note).toHaveTextContent(/pensando|thinking/);

      // Passados 30s o mesmo turno passa a dizer que AINDA está nisso.
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

/* ------------------------------------------------- respondendo a uma decisão */

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
    // A pergunta FECHA o turno — é o que faz o Claude ficar esperando. Sem isto o chat acha que
    // ainda tem trabalho rodando e um recado solto iria pra FILA, que é outro teste.
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
 * O BUG DO CÉSAR (produção, 2026-09-17, três vezes no mesmo dia): "escrevo uma instrução longa,
 * dou Enter, o chat entra num loop de carregando — às vezes por horas. Se eu dou F5, ou abro a
 * mesma conversa em outro computador, a mensagem simplesmente não está lá, como se eu nunca
 * tivesse enviado. Copio o texto, mando de novo, e aí funciona."
 *
 * Duas causas, os dois lados do mesmo buraco: (1) no servidor, o idle sweep hibernava o card que a
 * pessoa estava usando — matando o driver — e a mensagem seguinte era escrita num stdin morto
 * dentro de um `try {} catch {}`, gravada no histórico e respondida por ninguém; (2) aqui, a bolha
 * era desenhada porque `socket.send()` não reclamou, e um socket meio-aberto aceita `send()` no
 * vácuo — sem recibo do servidor e sem cópia em disco, o F5 apagava a única testemunha.
 *
 * O que estes testes fixam é o lado do navegador: TODA mensagem sai com recibo, e sem recibo ela
 * aparece marcada (com o texto inteiro, reenviável) em vez de girar para sempre.
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
      // Antes do prazo é honesto dizer "enviando" — o servidor pode só estar lento.
      expect(screen.getByTestId("sdk-user")).toHaveAttribute("data-state", "sending");

      await act(async () => { await vi.advanceTimersByTimeAsync(OUTBOX_ACK_TIMEOUT_MS + OUTBOX_TICK_MS); });

      expect(screen.getByTestId("sdk-user")).toHaveAttribute("data-state", "undelivered");
      expect(screen.getByTestId("sdk-user-undelivered")).toBeInTheDocument();
      expect(screen.getByTestId("sdk-user")).toHaveTextContent("instrução longa");
      // …e o socket que engoliu a mensagem é derrubado: só o reconnect revela se ele estava vivo.
      expect(ws.readyState).toBe(3);
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
    // O spinner PARA de prometer trabalho que ninguém recebeu (era ele que "ficava carregando").
    expect(screen.queryByTestId("sdk-chat-working")).not.toBeInTheDocument();
  });

  it("F5 com mensagem não confirmada: ela volta na tela, marcada e com o texto intacto", async () => {
    // O que o navegador anterior deixou em disco, sem recibo.
    localStorage.setItem(
      "vibehub.sdkOutbox.c1",
      JSON.stringify([{ cid: "c-antigo", text: "a instrução longa que sumia", at: Date.now() }]),
    );
    renderSdkChat();
    const ws = await socket();
    ws.accept();
    ws.deliver({ type: "ready" }); // o replay do servidor não traz a mensagem — ele nunca a recebeu

    const bubble = await screen.findByTestId("sdk-user");
    expect(bubble).toHaveTextContent("a instrução longa que sumia");
    expect(bubble).toHaveAttribute("data-state", "undelivered");
  });

  it("F5 quando a mensagem TINHA sido gravada: o replay manda, a bolha é normal e não duplica", async () => {
    localStorage.setItem(
      "vibehub.sdkOutbox.c1",
      JSON.stringify([{ cid: "c-antigo", text: "essa chegou", at: Date.now() }]),
    );
    renderSdkChat();
    const ws = await socket();
    ws.accept();
    ws.deliver({ type: "user", text: "essa chegou" }); // veio do histórico do servidor
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
    first.deliver({ type: "user", text: "sim" }); // a conversa já tinha um "sim" (o histórico)
    first.deliver({ type: "ready" });
    await userEvent.type(screen.getByRole("textbox"), "sim{Enter}");
    await waitFor(() => expect(first.sent.length).toBe(1));
    // o socket meio-aberto engoliu o envio: nenhum recibo, e o fio cai
    act(() => { first.readyState = 3; first.onclose?.(); });

    await waitFor(() => expect(FakeSocket.instances.length).toBe(2));
    const second = FakeSocket.instances[1] as FakeSocket;
    second.accept();
    second.deliver({ type: "user", text: "sim" }); // o servidor só tem o "sim" de antes
    second.deliver({ type: "ready" });

    // o "sim" de agora volta MARCADO, com reenviar — em vez de sumir como se tivesse chegado
    await waitFor(() => expect(screen.getAllByTestId("sdk-user")).toHaveLength(2));
    expect(screen.getAllByTestId("sdk-user")[1]).toHaveAttribute("data-state", "undelivered");
    expect(localStorage.getItem("vibehub.sdkOutbox.c1")).toContain("sim");
  });

  /**
   * A CONVERSA LONGA. O replay é uma JANELA (as últimas centenas de eventos do histórico), e ela anda:
   * seis "ok" na tela no envio, e no reconnect só os dois mais recentes ainda cabem — mais o "ok"
   * novo. Contar "quantos 'ok' havia" na tela inteira dava 6 contra 3 no replay: a mensagem ENTREGUE
   * voltava "não entregue", e o Reenviar duplicava o turno. O replay carrega o `at` do servidor em
   * cada mensagem: o que prova a entrega é uma ocorrência gravada DEPOIS da última que a tela
   * conhecia — relógio do servidor contra relógio do servidor, e a janela andar não muda isso.
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
    // o recibo se perdeu junto com o fio — mas o servidor gravou
    act(() => { first.readyState = 3; first.onclose?.(); });

    await waitFor(() => expect(FakeSocket.instances.length).toBe(2));
    const second = FakeSocket.instances[1] as FakeSocket;
    second.accept();
    second.deliver({ type: "user", text: "ok", at: 5 }); // os quatro mais antigos saíram da janela
    second.deliver({ type: "user", text: "ok", at: 6 });
    second.deliver({ type: "user", text: "ok", at: 100 }); // o de agora, gravado
    second.deliver({ type: "ready" });

    await waitFor(() => expect(localStorage.getItem("vibehub.sdkOutbox.c1")).toBeNull());
    expect(screen.getAllByTestId("sdk-user")).toHaveLength(3);
    expect(screen.queryByTestId("sdk-user-undelivered")).not.toBeInTheDocument();
  });

  it("conversa longa: a janela andou e o 'ok' de agora NÃO está nela — continua marcado", async () => {
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

    await waitFor(() => expect(screen.getAllByTestId("sdk-user")).toHaveLength(3));
    expect(screen.getAllByTestId("sdk-user")[2]).toHaveAttribute("data-state", "undelivered");
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
   * O BUG DO HOTFIX (produção, 2026-09-17, logo depois do recibo entrar no ar): com UMA mensagem
   * não entregue na tela, o chat entrava num loop de ~2 em ~2 segundos — "chat → Iniciando o
   * agente… → histórico inteiro de volta → chat", piscando sem parar até ficar inutilizável.
   *
   * A causa: a mensagem não entregue CONTINUA no outbox de propósito (é a cópia que o
   * "reenviar/descartar" oferece), e o `at` dela nunca muda — então ela seguia vencida em TODO
   * tique do watchdog, que a cada tique derrubava o socket "para descobrir se ele estava vivo".
   * O veredito agora é dado uma vez por envio; só um reenvio volta a armar o relógio.
   */
  describe("o veredito é dado UMA vez (o loop de reconexão)", () => {
    /** Quantos tiques um loop precisaria para se revelar — de sobra para vários prazos vencerem. */
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

        await act(async () => { await vi.advanceTimersByTimeAsync(MANY_TICKS); });

        expect(ws.readyState).not.toBe(3); // o socket que acabou de responder não é suspeito
        expect(FakeSocket.instances).toHaveLength(1); // nenhuma reconexão: nada pisca
        expect(screen.getByTestId("sdk-user-undelivered")).toBeInTheDocument(); // e a bolha continua lá
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

        // Vence o prazo: o socket suspeito cai (isso é o certo) e o navegador reconecta.
        await act(async () => { await vi.advanceTimersByTimeAsync(OUTBOX_ACK_TIMEOUT_MS + OUTBOX_TICK_MS); });
        expect(first.readyState).toBe(3);
        act(() => first.onclose?.());
        await act(async () => { await vi.advanceTimersByTimeAsync(RECONNECT_MAX_MS); });
        await waitFor(() => expect(FakeSocket.instances.length).toBe(2));
        const second = FakeSocket.instances[1] as FakeSocket;
        second.accept();
        second.deliver({ type: "ready" }); // o replay não traz a mensagem: o servidor nunca a teve
        await waitFor(() => expect(screen.getByTestId("sdk-user")).toHaveAttribute("data-state", "undelivered"));

        await act(async () => { await vi.advanceTimersByTimeAsync(MANY_TICKS); });

        expect(second.readyState).not.toBe(3); // a conexão nova não é derrubada de novo
        expect(FakeSocket.instances).toHaveLength(2); // e nenhuma terceira nasce
      } finally {
        vi.useRealTimers();
      }
    });

    it("F5 com a mensagem antiga em disco: a bolha volta marcada e a conexão fica quieta", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        localStorage.setItem(
          "vibehub.sdkOutbox.c1",
          JSON.stringify([{ cid: "c-antigo", text: "a instrução longa que sumia", at: Date.now() - 60_000 }]),
        );
        renderSdkChat();
        const ws = await socket();
        ws.accept();
        ws.deliver({ type: "ready" });
        await waitFor(() => expect(screen.getByTestId("sdk-user")).toHaveAttribute("data-state", "undelivered"));

        await act(async () => { await vi.advanceTimersByTimeAsync(MANY_TICKS); });

        expect(ws.readyState).not.toBe(3);
        expect(FakeSocket.instances).toHaveLength(1);
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
        expect(ws.readyState).toBe(3); // desta vez ninguém respondeu: o socket é suspeito de novo
      } finally {
        vi.useRealTimers();
      }
    });
  });

  /**
   * O BUG DO CÉSAR (produção, 2026-09-28): "toda hora" uma mensagem qualquer, no meio de uma
   * conversa normal, nasce marcada "não entregue ao servidor" — com o servidor no ar 24h.
   *
   * A causa não é o servidor estar fora: é o RELÓGIO DO RECIBO correr num instante em que o
   * servidor ainda não tem como responder. O `onopen` do navegador dispara no aperto de mão do
   * websocket, mas o back só chega ao `handleClientFrame` DEPOIS de um setup que leva segundos —
   * `installCardSdkDriver` (dois `docker exec` por SSH, com `npm install` quando a versão mudou), a
   * sonda de transcript (timeout de 15s, sozinha maior que o prazo do recibo), a leitura e o replay
   * do histórico, o spawn do driver. Até lá o frame fica em `pendingFrames` (routes/cardSdk.ts), e
   * é entregue DE VERDADE quando o setup acaba.
   *
   * Ou seja: a bolha acusava "não entregue" uma mensagem que o servidor recebeu — e o "Reenviar"
   * que a pessoa clica manda a segunda cópia. Pior, o watchdog derrubava esse socket no meio do
   * setup, e a reconexão paga o setup inteiro de novo: é esse o "toda hora".
   *
   * A regra que estes testes fixam: a ausência de recibo só é PROVA quando a conexão estava em
   * condições de responder. O prazo conta a partir do `ready` — o instante em que o servidor
   * assumiu este socket —, nunca de antes dele.
   */
  describe("o prazo do recibo só corre quando o servidor pode responder", () => {
    it("enviada enquanto o back ainda monta a conexão: o prazo não vence, a bolha não mente", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        renderSdkChat();
        const ws = await socket();
        ws.accept(); // o aperto de mão terminou — mas o back ainda está no setup, sem `ready`
        const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
        await user.type(screen.getByRole("textbox"), "instrução longa{Enter}");
        await waitFor(() => expect(ws.sent.length).toBe(1));

        await act(async () => { await vi.advanceTimersByTimeAsync(OUTBOX_ACK_TIMEOUT_MS + OUTBOX_TICK_MS); });

        // Nada aqui é prova de nada: o servidor nem chegou a ouvir ainda.
        expect(screen.getByTestId("sdk-user")).toHaveAttribute("data-state", "sending");
        expect(screen.queryByTestId("sdk-user-undelivered")).not.toBeInTheDocument();
        expect(ws.readyState).not.toBe(3); // e o socket do setup em andamento NÃO é derrubado
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
        await waitFor(() => expect(ws.sent.length).toBe(1));
        const cid = (JSON.parse(ws.sent[0]!) as { cid: string }).cid;

        // O setup do back (sonda de transcript + replay + spawn) demorou mais que o prazo…
        await act(async () => { await vi.advanceTimersByTimeAsync(OUTBOX_ACK_TIMEOUT_MS * 2); });
        // …e então ele atende o socket e responde o frame que estava bufferado.
        ws.deliver({ type: "ready" });
        ws.deliver({ type: "user_ack", cid } as SdkEvent);

        await waitFor(() => expect(screen.getByTestId("sdk-user")).toHaveAttribute("data-state", "sent"));
        await waitFor(() => expect(localStorage.getItem("vibehub.sdkOutbox.c1")).toBeNull());
      } finally {
        vi.useRealTimers();
      }
    });

    /**
     * O `ready` chega ANTES dos recibos do que ficou bufferado: o back manda `ready` no attach
     * (manager.ts) e só DEPOIS processa `pendingFrames` (routes/cardSdk.ts). Então o replay não
     * pode conter a mensagem em voo — e a reconciliação, que compara por TEXTO, a dava como
     * perdida: bolha duplicada, marcada "não entregue", para uma mensagem a caminho.
     *
     * A fronteira: reconciliar é sobre o que sobrou de ANTES. Um envio que já tem bolha nesta tela
     * tem dono — o watchdog — e a reconciliação não opina sobre ele.
     */
    it("a reconciliação não duplica nem condena o envio que ESTA conexão ainda espera", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        renderSdkChat();
        const ws = await socket();
        ws.accept();
        const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
        await user.type(screen.getByRole("textbox"), "instrução longa{Enter}");
        await waitFor(() => expect(ws.sent.length).toBe(1));

        await act(async () => { await vi.advanceTimersByTimeAsync(OUTBOX_ACK_TIMEOUT_MS * 2); });
        ws.deliver({ type: "ready" }); // o replay vem sem ela: o back ainda nem leu o frame

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
        await waitFor(() => expect(ws.sent.length).toBe(1));

        await act(async () => { await vi.advanceTimersByTimeAsync(OUTBOX_ACK_TIMEOUT_MS * 2); });
        ws.deliver({ type: "ready" }); // o servidor assumiu o socket AGORA: o prazo nasce aqui

        await act(async () => { await vi.advanceTimersByTimeAsync(OUTBOX_ACK_TIMEOUT_MS / 2); });
        expect(screen.getByTestId("sdk-user")).toHaveAttribute("data-state", "sending");

        await act(async () => { await vi.advanceTimersByTimeAsync(OUTBOX_ACK_TIMEOUT_MS); });
        // Agora sim: houve uma conexão de pé, com prazo inteiro, e ninguém respondeu.
        expect(screen.getByTestId("sdk-user")).toHaveAttribute("data-state", "undelivered");
        expect(ws.readyState).toBe(3);
      } finally {
        vi.useRealTimers();
      }
    });

    /**
     * A OUTRA METADE do "toda hora": escrever durante a reconexão.
     *
     * Um socket cai o tempo todo por motivos banais — deploy, tampa do notebook, proxy cortando uma
     * conexão ociosa — e a reconexão leva de 400ms a 15s (lib/reconnect.ts). Quem está escrevendo
     * não vê nada disso: dá Enter e, até aqui, a mensagem nascia INSTANTANEAMENTE condenada ("não
     * entregue ao servidor", com reenviar/descartar) por um fio que voltaria dois segundos depois —
     * e o texto ficava em DOIS lugares ao mesmo tempo, na bolha e no campo, de onde um segundo
     * Enter mandava a cópia.
     *
     * Uma mensagem que só precisa esperar o fio não é uma mensagem perdida: é a FILA — o mesmo
     * lugar onde espera quem escreveu durante um turno, editável, guardada em disco, e entregue
     * sozinha assim que a conexão volta a poder carregá-la.
     */
    it("escrever com o fio caído: a mensagem espera na fila, e sobe sozinha quando o fio volta", async () => {
      renderSdkChat();
      const first = await socket();
      first.accept();
      first.deliver({ type: "ready" });
      act(() => { first.readyState = 3; first.onclose?.(); }); // o fio caiu, sem ninguém perceber

      await userEvent.type(screen.getByRole("textbox"), "instrução longa{Enter}");

      expect(first.sent).toHaveLength(0);
      expect(screen.queryByTestId("sdk-user")).not.toBeInTheDocument(); // nada nasce condenado
      expect(screen.getByTestId("sdk-queued")).toHaveTextContent("instrução longa");
      expect(screen.getByRole("textbox")).toHaveValue(""); // e o texto não fica em dois lugares

      // O fio volta: a fila anda sozinha, e só agora a mensagem vira bolha de verdade.
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
     * A EXCEÇÃO QUE NÃO PODE CAIR: com uma pergunta do agente esperando resposta, NADA é
     * enfileirado — nem com o fio fora do ar.
     *
     * Um `user_question` deixa o driver bloqueado com o turno ainda contado como ATIVO, e a única
     * coisa que o solta é uma mensagem da pessoa. O despacho da fila só anda quando o turno fecha —
     * então enfileirar aqui seria esperar por um fim de turno que só a própria mensagem enfileirada
     * poderia causar: trava permanente, do tipo que fica meia hora até o timeout.
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
      act(() => { ws.readyState = 3; ws.onclose?.(); }); // o fio cai com a pergunta de pé

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

        // O fio cai logo depois do envio (deploy, VPN, wi-fi) — nada disso é culpa da mensagem.
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
   * O socket morto que o navegador ainda não percebeu (`readyState` fechado sem o `onclose` ter
   * corrido): nada sai por ele. A bolha condenada que nascia aqui era um falso negativo duas vezes
   * — o servidor não recusou nada, ele nem foi consultado — e deixava o texto em dois lugares, na
   * bolha e no campo, de onde o Enter seguinte mandava a cópia. Uma mensagem que só precisa de um
   * fio ESPERA: guardada em disco, editável, entregue pelo despacho quando houver conexão.
   */
  it("socket morto: a mensagem nem sai, espera na fila, e ninguém acusa entrega nenhuma", async () => {
    renderSdkChat();
    const ws = await socket();
    ws.accept();
    ws.deliver({ type: "ready" });
    ws.readyState = 3; // morto, sem o navegador ter percebido (o caso do socket meio-aberto)

    await userEvent.type(screen.getByRole("textbox"), "não vai sair{Enter}");

    expect(ws.sent.length).toBe(0);
    expect(await screen.findByTestId("sdk-queued")).toHaveTextContent("não vai sair"); // guardada e editável
    expect(screen.queryByTestId("sdk-user")).not.toBeInTheDocument(); // nada nasce condenado
    expect(screen.getByRole("textbox")).toHaveValue(""); // e o texto não fica em dois lugares
  });
});

/**
 * "SÓ FICA UM LOADING ESCRITO 'TRABALHANDO…'" (pedido do César, 2026-09-17): um turno de dez minutos
 * e um de meio segundo eram idênticos na tela, e quem esperava não sabia se o agente tinha entendido
 * o pedido. O raciocínio é a única coisa que existe antes da resposta — então é ele que vira notícia.
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

    // O fim do turno não esconde o raciocínio: é justamente aí que ele explica o que foi feito.
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
    await userEvent.click(screen.getByTestId("sdk-thinking-toggle")); // fecha
    await userEvent.click(screen.getByTestId("sdk-thinking-toggle")); // e reabre: escolha explícita

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
 * O cartão que prendia a tela (produção, 2026-09-17). O destravamento em si mora no driver — quem
 * está parado esperando o clique é o turno dentro do `canUseTool` —, e o que a TELA deve é contar a
 * verdade quando ele é liberado: a pessoa respondeu, só não pelo cartão.
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

    // (a suíte roda no idioma padrão, en — o pt-BR diz "Você respondeu por mensagem")
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
 * O LEITOR DE TELA. A conversa é um `role="log"` — uma região viva: tudo que muda lá dentro é
 * anunciado. O relógio do turno morava ali dentro (a barra fixa no topo e o "Trabalhando… 1m 24s"
 * no fim), então quem ouve a tela ouvia o cronômetro a cada segundo, por cima da conversa. O
 * cronômetro é para os olhos; para o ouvido vai a FASE (pensando, respondendo, executando), que só
 * muda quando o trabalho muda.
 */
describe("SdkChatView — o que o leitor de tela anuncia", () => {
  /** Está numa parte da conversa que o leitor de tela anuncia (dentro do log e sem aria-hidden)? */
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
    // `role="log"` já é uma região viva educada: o `aria-live` repetido não dizia nada a mais
    expect(log).not.toHaveAttribute("aria-live");
    expect(log).not.toHaveAttribute("aria-busy", "true");

    ws.deliver({ type: "assistant_delta", text: "Começ" });
    expect(log).toHaveAttribute("aria-busy", "true");

    ws.deliver({ type: "assistant_text", text: "Começando." });
    expect(log).not.toHaveAttribute("aria-busy", "true");
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
 * A FILA — o que você escreve enquanto o Claude trabalha.
 *
 * O que estes testes fixam, na ordem em que o dono descreveu: a mensagem ESPERA (não vira bolha e
 * não vai pro socket), ela sobe pra conversa no instante em que é entregue, ela é editável
 * enquanto espera, e uma mensagem em edição NÃO pode ser entregue — nem que o turno acabe no meio
 * da correção.
 */
describe("SdkChatView — a fila (mensagem escrita durante um turno)", () => {
  /** Um chat com um turno visivelmente rodando e uma mensagem esperando na fila. */
  async function chatWithQueued(text = "aproveita e ajusta o título") {
    renderSdkChat();
    const ws = await socket();
    ws.accept();
    ws.deliver({ type: "ready" });
    const box = (await screen.findByLabelText(/Enter/)) as HTMLTextAreaElement;
    await userEvent.type(box, `faz a tarefa{Enter}`);
    await waitFor(() => expect(ws.sent.length).toBe(1));
    ws.deliver({ type: "assistant_delta", text: "Fazendo…" }); // o turno está rodando
    await userEvent.type(box, `${text}{Enter}`);
    await screen.findByTestId("sdk-queue");
    return { ws, box };
  }

  it("com o turno rodando, a mensagem ESPERA: não vai pro socket e não vira bolha", async () => {
    const { ws } = await chatWithQueued();
    expect(ws.sent).toHaveLength(1); // só a primeira mensagem foi entregue
    expect(screen.getByTestId("sdk-queued")).toHaveTextContent("aproveita e ajusta o título");
    // a conversa tem UMA bolha do usuário — a que o Claude realmente leu
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
    // a segunda NÃO foi junto: ela espera o turno que a primeira acabou de abrir
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
    // continua na fila, marcada: é o que faz um F5 devolver o texto em vez de apagá-lo
    expect(screen.getByTestId("sdk-queued")).toHaveAttribute("data-editing", "true");
    expect(screen.getByTestId("sdk-queued-editing")).toBeInTheDocument();
    expect(screen.queryByTestId("sdk-queued-edit")).toBeNull(); // o campo é que manda agora
    // e o texto NÃO está na conversa: o Claude continua sem ter lido nada disso
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
    await userEvent.click(screen.getByTestId("sdk-queued-edit")); // o único visível agora é o outro

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

    ws.deliver({ type: "result", isError: false }); // o Claude ficou livre no meio da digitação
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(ws.sent).toHaveLength(1); // nada saiu: a mensagem está no campo, sendo reescrita

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
    expect(screen.getAllByTestId("sdk-queued")).toHaveLength(1); // volta como UMA, não como cópia
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
    expect(rows[1]).toHaveAttribute("data-editing", "true"); // guarda o lugar dela, no campo
    expect(rows[0]).not.toHaveAttribute("data-editing");
  });

  it("com uma PERGUNTA parada, o recado solto também vai na hora (senão nada destrava o turno)", async () => {
    renderSdkChat();
    const ws = await socket();
    ws.accept();
    ws.deliver({ type: "ready" });
    // AskUserQuestion: o driver fica bloqueado esperando, com o turno ainda contado como ativo —
    // e a única coisa que o solta é uma mensagem do usuário. Enfileirar aqui travaria até o timeout.
    ws.deliver({
      type: "user_question",
      id: "q1",
      questions: [{ question: "Qual dos dois?", header: "Caminho", options: [{ label: "A" }, { label: "B" }], multiSelect: false }],
    });
    await screen.findByTestId("pending-tray");

    // o campo do chat, não o "outra resposta" do próprio card da pergunta
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
    // o turno segue ABERTO — é o caso em que o agente pergunta e fica esperando dentro do turno
    await userEvent.click(await screen.findByTestId("pending-tray-item"));
    await userEvent.type(screen.getByRole("textbox"), "o B{Enter}");

    await waitFor(() => expect(ws.sent.length).toBe(1));
    expect(JSON.parse(ws.sent[0]!).text).toContain("o B");
    expect(screen.queryByTestId("sdk-queue")).toBeNull();
  });

  /**
   * UM CAMPO, UM MODO. Corrigir uma da fila, corrigir uma bolha enviada e responder uma decisão são
   * três gestos que disputam o MESMO campo de texto — entrar num tem de sair dos outros. O lápis da
   * fila já soltava os outros dois, mas o lápis da bolha e a bandeja de decisões não soltavam a
   * fila: o Enter seguinte caía no `queueEdit` (testado primeiro) e a correção da bolha gravava
   * POR CIMA da mensagem que esperava na fila, que sumia sem ninguém ter pedido.
   */
  it("o lápis de uma bolha ENVIADA solta a da fila: a correção não grava por cima dela", async () => {
    const { ws, box } = await chatWithQueued();
    await userEvent.click(screen.getByTestId("sdk-queued-edit"));
    await userEvent.click(screen.getByTestId("sdk-edit")); // mudou de ideia: corrige a enviada
    expect(box.value).toBe("faz a tarefa");

    await userEvent.clear(box);
    await userEvent.type(box, "faz a outra tarefa{Enter}");

    // a correção da bolha seguiu o caminho dela (para o turno, e vai depois do result)…
    await waitFor(() => expect(ws.sent.length).toBe(2));
    expect(JSON.parse(ws.sent[1]!)).toEqual({ type: "interrupt", reason: "edit" });
    // …e a da fila está intacta, de volta à espera
    expect(screen.getByTestId("sdk-queued")).toHaveTextContent("aproveita e ajusta o título");
    expect(screen.getByTestId("sdk-queued")).not.toHaveTextContent("faz a outra tarefa");
    expect(screen.getByTestId("sdk-queued")).not.toHaveAttribute("data-editing");
  });

  it("responder uma decisão pela bandeja solta a da fila: a resposta não grava por cima dela", async () => {
    const { ws, box } = await chatWithQueued();
    await userEvent.click(screen.getByTestId("sdk-queued-edit"));
    // No meio da correção chega um AskUserQuestion (a da fila, no campo, não é despachada).
    ws.deliver({
      type: "user_question",
      id: "q_1",
      questions: [{ question: "Formato do relatório?", options: [{ label: "Resumo" }, { label: "Detalhado" }] }],
    });
    await userEvent.click(await screen.findByTestId("pending-tray-item"));
    expect(screen.queryByTestId("composer-editing")).toBeNull(); // o campo agora RESPONDE

    await userEvent.clear(box);
    await userEvent.type(box, "em tabela{Enter}");

    await waitFor(() => expect(ws.sent.some((raw) => JSON.parse(raw).type === "question_answer")).toBe(true));
    const frames = ws.sent.map((raw) => JSON.parse(raw) as { type: string; text?: string });
    expect(frames).toContainEqual({ type: "question_answer", id: "q_1", answers: [{ selected: ["em tabela"] }] });
    // a da fila voltou a ser entregável com o texto DELA — e a pergunta respondida abre o respiro,
    // então ela sai logo em seguida, intacta
    await waitFor(() => expect(ws.sent.map((raw) => JSON.parse(raw) as { text?: string }))
      .toContainEqual(expect.objectContaining({ type: "user", text: "aproveita e ajusta o título" })));
    expect(frames.filter((f) => f.type === "user").map((f) => f.text)).not.toContain("em tabela");
  });
});

/**
 * O BUG DO LAYOUT (produção, 2026-09-28): "mensagem grande quebra o layout, ela tá na fila e eu
 * não consigo subir para ver o que tá sendo dito".
 *
 * A bandeja da fila mora entre a conversa e o campo de texto, como IRMÃ do scroller da conversa
 * num flex column. O texto da mensagem em espera era desenhado inteiro, sem teto — então uma
 * instrução de duzentas linhas esticava a bandeja até ela ocupar a tela toda, e o scroller
 * (`min-h-0 flex-1`) era espremido até quase zero. A conversa não sumiu: ela foi empurrada para
 * fora, e com ela a única forma de acompanhar o que o agente estava dizendo.
 *
 * A regra: a espera nunca pode roubar a tela da conversa. A bandeja tem TETO e rolagem própria, e
 * cada mensagem em espera também — uma gigante rola dentro do lugar dela em vez de empurrar as
 * outras (e o lápis continua sendo o caminho para lê-la inteira, no campo).
 *
 * jsdom não calcula layout, então o que dá para travar aqui é a REGRA: os dois elementos carregam
 * teto de altura e rolagem própria, e a bandeja fica FORA do scroller da conversa.
 */
describe("SdkChatView — a fila não rouba a tela da conversa", () => {
  /** Uma instrução de verdade, do tamanho das que quebraram o layout. */
  const HUGE = Array.from({ length: 120 }, (_, i) => `linha ${i + 1} da instrução gigante`).join("\n");

  async function queueHuge() {
    renderSdkChat();
    const ws = await socket();
    ws.accept();
    ws.deliver({ type: "ready" });
    const box = screen.getByTestId("terminal-composer").querySelector("textarea")!;
    await userEvent.type(box, "primeira{Enter}");
    await waitFor(() => expect(ws.sent.length).toBe(1));
    ws.deliver({ type: "assistant_delta", text: "trabalhando…" }); // turno rodando: o resto espera
    fireEvent.change(box, { target: { value: HUGE } });
    fireEvent.keyDown(box, { key: "Enter" });
    await screen.findByTestId("sdk-queued");
    return ws;
  }

  it("a bandeja da fila tem teto de altura e rolagem própria", async () => {
    await queueHuge();
    const tray = screen.getByTestId("sdk-queue");
    expect(tray.className).toMatch(/max-h-/); // sem teto ela cresce até engolir a conversa
    expect(tray.className).toMatch(/overflow-y-auto/); // e o que não cabe rola AQUI dentro
  });

  it("uma mensagem em espera gigante rola dentro do lugar dela, sem empurrar as outras", async () => {
    await queueHuge();
    const body = screen.getByTestId("sdk-queued-text");
    expect(body.className).toMatch(/max-h-/);
    expect(body.className).toMatch(/overflow-y-auto/);
    expect(body).toHaveTextContent("linha 1 da instrução gigante"); // e o texto continua inteiro
    expect(body).toHaveTextContent("linha 120 da instrução gigante");
  });

  it("a bandeja fica FORA do scroller da conversa — ela não é uma linha do histórico", async () => {
    await queueHuge();
    const scroller = screen.getByTestId("sdk-chat-scroller");
    expect(scroller.contains(screen.getByTestId("sdk-queue"))).toBe(false);
    // e o scroller segue sendo quem rola a conversa
    expect(scroller.className).toMatch(/overflow-y-auto/);
    expect(scroller.className).toMatch(/min-h-0/); // o que o impede de ser espremido a zero
  });
});

/**
 * "FORÇAR ENVIO" (pedido do César, 2026-09-28): "eu mando a mensagem pra você, você ainda tá no
 * turno mas pode receber a mensagem alguns segundos ou minutos depois — e não tem opção de forçar
 * envio, de já mandar a mensagem da fila para a IA receber".
 *
 * A fila espera o turno FECHAR, e essa é a regra certa por padrão: uma mensagem dobrada no meio de
 * um raciocínio em curso entra como interrupção de contexto, não como pergunta nova. Mas esperar
 * nem sempre é o que a pessoa quer — às vezes o recado é justamente para agora ("para, tá errado",
 * "o que você tá fazendo?"), e o driver ACEITA isso: a mensagem entra no turno em andamento e volta
 * marcada "entrou no turno em andamento" (o `turn_absorbed`).
 *
 * Então a espera vira uma ESCOLHA, não uma sentença: cada mensagem da fila carrega o gesto de
 * atropelar a espera e ir agora.
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
    ws.deliver({ type: "assistant_delta", text: "trabalhando…" }); // turno rodando: o resto espera
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
    expect(JSON.parse(ws.sent[1]!)).toMatchObject({ type: "user", text: "o que você tá fazendo ?" });
    // saiu da espera e virou conversa: é isso que "foi entregue" significa nesta tela
    await waitFor(() => expect(screen.queryByTestId("sdk-queued")).not.toBeInTheDocument());
    const bubbles = screen.getAllByTestId("sdk-user");
    expect(bubbles[bubbles.length - 1]).toHaveTextContent("o que você tá fazendo ?");
  });

  /**
   * "ONDE EU CLICO EM ENVIAR AGORA?" (César, 2026-09-28) — a pergunta que condena um gesto.
   *
   * Os três botões da fila nasceram copiando o padrão das linhas da conversa: `md:opacity-0
   * md:group-hover:opacity-100`, ou seja, invisíveis no desktop até o mouse passar por cima. Para
   * um gesto que já se conhece isso é discrição; para um que acabou de existir é o mesmo que não
   * ter sido feito. E "manda agora" é justamente o gesto com PRESSA — quem quer atropelar a espera
   * não vai caçar um ícone escondido.
   *
   * A bandeja da fila não é a conversa: ela só aparece quando há algo esperando, e já existe para
   * chamar atenção. Aqui os gestos ficam à vista.
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
    act(() => { ws.readyState = 3; ws.onclose?.(); }); // o fio caiu antes do clique

    await userEvent.click(screen.getByTestId("sdk-queued-send-now"));

    expect(ws.sent.length).toBe(1); // nada saiu
    expect(screen.getByTestId("sdk-queued")).toHaveTextContent("o que você tá fazendo ?"); // e continua guardada
    expect(screen.queryByTestId("sdk-user-undelivered")).not.toBeInTheDocument(); // sem bolha condenada
  });
});

/**
 * A FILA ANDA NO RESPIRO (pedido do César, 2026-09-28): "no Cursor e no Claude Code as mensagens
 * ficam lá enquanto ele tá trabalhando, mas quando ele tiver tranquilo ele puxa as mensagens".
 *
 * Antes daqui a fila esperava o `result` — o fim do turno inteiro. Um turno de quinze minutos
 * segurava por quinze minutos um "para, tá errado", e a pessoa ficava olhando a própria mensagem
 * parada enquanto o agente seguia no caminho errado. Agora ela sai no primeiro bloco FECHADO: o
 * turno continua de pé, e a mensagem entra nele pelo streaming input.
 */
describe("SdkChatView — a fila anda no respiro do turno, não só no fim", () => {
  it("ferramenta rodando: a mensagem continua esperando", async () => {
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

    // escrita COM a ferramenta já rodando: não há respiro nenhum à vista
    await userEvent.type(box, "o que você tá fazendo ?{Enter}");
    await screen.findByTestId("sdk-queued");

    expect(ws.sent.length).toBe(1); // nada saiu: ferramenta rodando é o oposto de tranquilo
    expect(screen.getByTestId("sdk-queued")).toBeInTheDocument();
  });

  it("bloco FECHADO no meio do turno: ela vai — sem o turno ter acabado", async () => {
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
    ws.deliver({ type: "tool_use", id: "t1", name: "Bash", input: { command: "npm test" } });
    expect(ws.sent.length).toBe(1); // ainda ocupado

    ws.deliver({ type: "assistant_text", text: "os testes passaram" }); // o respiro

    await waitFor(() => expect(ws.sent.length).toBe(2));
    expect(JSON.parse(ws.sent[1]!)).toMatchObject({ type: "user", text: "o que você tá fazendo ?" });
    // e nada disso precisou do fim do turno: NENHUM `result` foi entregue nesta conversa
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

    ws.deliver({ type: "assistant_text", text: "os testes passaram" }); // um respiro
    ws.deliver({ type: "turn_absorbed" }); // o driver confirma a dobra da primeira

    await waitFor(() => expect(ws.sent.length).toBe(2));
    expect(JSON.parse(ws.sent[1]!)).toMatchObject({ text: "recado um" });
    // a segunda NÃO foi junto: o respiro foi da primeira, e ela ainda é sua
    expect(screen.getAllByTestId("sdk-queued")).toHaveLength(1);
    expect(screen.getByTestId("sdk-queued")).toHaveTextContent("recado dois");
  });
});

/**
 * "PARECE MENSAGEM GENÉRICA" (César, 2026-09-28): o que mais se via num turno longo era
 * "ferramenta demorada, ainda rodando" — a mesma frase para qualquer ferramenta, escolhida por uma
 * tabela a partir do relógio. O raciocínio do modelo e a descrição que ele mesmo escreveu para o
 * comando estavam a um passo dali, no estado, e nunca chegavam à tela.
 *
 * Agora a palavra do modelo ganha da frase pronta. A enlatada segue existindo para quando não há
 * nada a dizer — o "Preparando…" de uma sessão subindo não tem raciocínio nenhum para mostrar.
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
    await userEvent.type(box, "sobe pra prod{Enter}"); // sem `ready`: a sessão ainda está subindo

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
    await userEvent.click(agent); // e fecha de novo
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
    expect(screen.queryByTestId("sdk-workflow-agent")).toBeNull(); // recolhida
    expect(screen.getByTestId("sdk-workflow-count")).toHaveTextContent(/1\/1/);
    expect(screen.getByTestId("sdk-workflow")).toHaveTextContent(/concluído|done/);
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
 * O RACIOCÍNIO TRADUZIDO NA TELA. O modelo não recebe mais instrução de idioma (era o gatilho do
 * bloqueio do Opus, e nem funcionava sempre): o navegador traduz o bloco TERMINADO, com o tradutor
 * local do Chrome/Edge — zero token. Sem a API, o original, e nada quebra.
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
  // O idioma é global e persistido: deixá-lo trocado vazaria para os outros arquivos de teste.
  // os globais (Translator, LanguageDetector) o afterEach de fora desfaz, junto com o WebSocket
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

  // LOW-4 da revisão: baixar o modelo CONSOME o gesto. No pointerdown em captura, o primeiro clique
  // da pessoa perdia o gesto antes do próprio app (popup, tela cheia). No click, o app já agiu.
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

/* ------------------------------------------- duas pessoas no mesmo card */

describe("SdkChatView — quem escreve e quem está digitando", () => {
  const OPERATOR = { id: "1", username: "operator", role: "owner" };
  const CESAR = { id: "2", username: "cesar", role: "user" };
  let me: typeof OPERATOR = OPERATOR;

  beforeEach(() => {
    me = OPERATOR;
    localStorage.clear();
    // os blocos anteriores podem deixar o idioma em pt-BR; as frases aqui são afirmadas em inglês
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

  /** Espera a tela saber quem é o leitor (o `/auth/me` resolveu). */
  async function signedIn(): Promise<void> {
    await waitFor(() => expect(vi.mocked(get)).toHaveBeenCalledWith("/auth/me"));
    await act(async () => { await Promise.resolve(); });
  }

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
    // para quem escreveu, é a própria bolha: sem nome de autor
    expect(screen.getByTestId("sdk-user")).not.toHaveAttribute("data-role");
    // troca de conta antes do recibo: o outbox guarda a cópia, e a nova conexão a redesenha
    me = CESAR;
    await act(async () => { await queryClient.invalidateQueries({ queryKey: ME_KEY }); });
    await waitFor(() => expect(FakeSocket.instances.length).toBe(2));
    const next = FakeSocket.instances[1]!;
    next.accept();
    next.deliver({ type: "ready" });
    await waitFor(() => expect(screen.getByTestId("sdk-user")).toHaveTextContent("continua nao para"));
    // para o cesar, ela é do operator — com o nome, não como se fosse dele
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
    // só agora o navegador entrega o close do socket velho
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
    // troca de conta com a mensagem ainda esperando
    me = CESAR;
    await act(async () => { await queryClient.invalidateQueries({ queryKey: ME_KEY }); });
    await waitFor(() => expect(FakeSocket.instances.length).toBe(2));
    const next = FakeSocket.instances[1]!;
    next.accept();
    next.deliver({ type: "ready" });
    next.deliver({ type: "result", isError: false });
    await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
    // nada do operator saiu assinado pela conexão do cesar
    expect(next.sent.some((raw) => raw.includes("isto é do operator"))).toBe(false);
    // ela continua na tela, como do operator, não entregue — e sem "Reenviar" para o cesar
    const bubble = screen.getAllByTestId("sdk-user").find((el) => el.textContent?.includes("isto é do operator"));
    expect(bubble).toBeDefined();
    expect(bubble).toHaveTextContent("operator");
    // (a primeira, sem recibo, também é do operator: nenhuma das duas oferece "Reenviar" ao cesar)
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
});

/**
 * O CUSTO DO TRANSCRIPT. Cada token que chega (`assistant_delta`) e cada segundo do relógio do
 * turno re-renderizavam a conversa INTEIRA — toda bolha antiga redesenhada e todo Markdown
 * re-parseado, dezenas de vezes por segundo numa conversa longa (e é no celular que isso dói).
 * Uma linha que não mudou não tem o que redesenhar.
 */
describe("SdkChatView — o custo do transcript", () => {
  /** Quantas vezes a bolha com este texto foi desenhada até agora. */
  function drawsOf(text: string): number {
    return vi.mocked(LinkifiedText).mock.calls.filter(([props]) => props.text === text).length;
  }

  it("um token novo não redesenha as bolhas antigas", async () => {
    renderSdkChat();
    const ws = await socket();
    ws.accept();
    ws.deliver({ type: "user", text: "a mensagem antiga" });
    ws.deliver({ type: "assistant_text", text: "a resposta antiga" });
    ws.deliver({ type: "ready" });
    ws.deliver({ type: "assistant_delta", text: "Come" });
    const before = drawsOf("a mensagem antiga");
    expect(before).toBeGreaterThan(0);

    ws.deliver({ type: "assistant_delta", text: "çando" });
    ws.deliver({ type: "assistant_delta", text: " a nova" });
    ws.deliver({ type: "assistant_delta", text: " resposta" });

    expect(screen.getAllByTestId("sdk-assistant")[1]).toHaveTextContent("Começando a nova resposta");
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
});
