import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { act } from "react";
import { OUTBOX_TICK_MS, SdkChatView } from "@/features/board/components/SdkChatView";
import { OUTBOX_ACK_TIMEOUT_MS } from "@/features/board/lib/sdkOutbox";
import { RECONNECT_MAX_MS } from "@/features/board/lib/reconnect";
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
   * aba), e essa mensagem tem de chegar rotulada: ela entrou no meio de um raciocínio em curso.
   */
  it("labels the bubble 'entrou no turno em andamento' when the driver folds an outside send in", async () => {
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

    const label = await screen.findByTestId("sdk-user-absorbed");
    expect(label).toHaveTextContent(/entrou no turno em andamento|joined the running turn/);
    // only the folded bubble carries it — the first message opened the turn normally
    expect(screen.getAllByTestId("sdk-user-absorbed")).toHaveLength(1);
    const bubbles = screen.getAllByTestId("sdk-user");
    expect(bubbles[1]).toHaveTextContent("aproveita e ajusta o título");
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
