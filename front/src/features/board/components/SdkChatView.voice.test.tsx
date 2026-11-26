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
import { SERVER_BACK_CONTEXT } from "@/features/voice/voiceContext";
import { DELEGATION_INTERRUPTED, DELEGATION_QUEUED } from "@/features/voice/voiceDelegation";
import { QUESTION_ANSWER_SENT } from "@/features/voice/voiceQuestion";

function toolCall(callId: string, name: string, args: Record<string, unknown>) {
  return {
    type: "response.event",
    delegation_id: "item_r1",
    event: { type: "response.output_item.done", item: { type: "function_call", call_id: callId, name, arguments: JSON.stringify(args) } },
  };
}

function toolOutput(sent: Record<string, unknown>[], callId: string): unknown {
  const created = sent.find((event) => event.type === "response.item.create" && (event.item as { call_id: string }).call_id === callId);
  return created ? JSON.parse((created.item as { output: string }).output) : undefined;
}

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
  get frames(): { type: string; text?: string; id?: string; answers?: { selected: string[] }[] }[] {
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
    expect(bar).toHaveTextContent(/attachments go to the card.s agent; the voice only gets the context/);
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

  it("typing during the call goes through the chat's own flow, and the voice is told to say it got a text", async () => {
    // Production, 2026-11-16: sent as quiet context (thinking), the voice never mentioned the text
    // the person had just typed — it looked ignored.
    const { ws } = await openChat();
    await startCall();
    await userEvent.type(screen.getByRole("textbox"), "roda os testes{Enter}");
    await waitFor(() => expect(ws.frames.some((f) => f.type === "user" && f.text === "roda os testes")).toBe(true));
    expect(screen.getByTestId("sdk-user")).toHaveTextContent("roda os testes");
    await waitFor(() =>
      expect(channel().sent).toContainEqual({
        type: "session.commentary.append",
        delegation_id: null,
        content: expect.stringContaining("«roda os testes»"),
      }),
    );
    expect(thinkingSent()).toEqual([]);
    // Waiting on the agent: the call shows it is processing (the living mark), not a frozen sphere.
    await waitFor(() => expect(screen.getByTestId("voice-call-bar")).toHaveAttribute("data-phase", "thinking"));
    expect(screen.getByTestId("voice-call-orb")).toHaveAttribute("data-orb", "logo");
  });

  it("a mensagem que outra pessoa digita durante a chamada chega à voz com o nome dela, uma vez só, mesmo depois de um reconnect", async () => {
    const { ws } = await openChat();
    ws.deliver({ type: "user", text: "pedido de antes da chamada", at: 1, from: { kind: "user", name: "mussa" } });
    await startCall();
    ws.deliver({ type: "user", text: "olha a requisição que mandei", at: 2, from: { kind: "user", name: "mussa" } });
    const peerNotes = () =>
      channel().sent.filter((sentEvent) => sentEvent.type === "session.commentary.append" && sentEvent.content !== SERVER_BACK_CONTEXT);
    await waitFor(() =>
      expect(peerNotes()).toEqual([expect.objectContaining({ content: expect.stringMatching(/mussa.*«olha a requisição que mandei»/) })]),
    );

    ws.drop();
    await waitFor(() => expect(FakeSocket.instances.length).toBe(2), { timeout: 5_000 });
    const again = FakeSocket.instances[1]!;
    again.accept();
    again.deliver({ type: "user", text: "pedido de antes da chamada", at: 1, from: { kind: "user", name: "mussa" } });
    again.deliver({ type: "user", text: "olha a requisição que mandei", at: 2, from: { kind: "user", name: "mussa" } });
    again.deliver({ type: "ready" });
    expect(peerNotes()).toHaveLength(1);
  });

  it("a mensagem da mesma pessoa vinda de outro dispositivo chega à voz; a que esta aba enviou não se repete depois de um reconnect", async () => {
    const { ws } = await openChat();
    await startCall();
    const commentary = () =>
      channel().sent.filter((sentEvent) => sentEvent.type === "session.commentary.append" && sentEvent.content !== SERVER_BACK_CONTEXT);
    await userEvent.type(screen.getByRole("textbox"), "daqui da aba{Enter}");
    await waitFor(() => expect(commentary()).toHaveLength(1));
    ws.deliver({ type: "user", text: "do notebook", at: 3, from: { kind: "owner", name: "operator" } });
    await waitFor(() => expect(commentary()).toHaveLength(2));
    expect(commentary()[1]).toEqual(expect.objectContaining({ content: expect.stringMatching(/operator.*«do notebook»/) }));

    ws.drop();
    await waitFor(() => expect(FakeSocket.instances.length).toBe(2), { timeout: 5_000 });
    const again = FakeSocket.instances[1]!;
    again.accept();
    again.deliver({ type: "user", text: "daqui da aba", at: 2, from: { kind: "owner", name: "operator" } });
    again.deliver({ type: "user", text: "do notebook", at: 3, from: { kind: "owner", name: "operator" } });
    again.deliver({ type: "ready" });
    expect(commentary()).toHaveLength(2);
  });

  it("com o agente ocupado, a mensagem que outra pessoa deixou na fila chega à voz na hora, e não se repete quando sai da fila", async () => {
    const { ws } = await openChat();
    await startCall();
    const commentary = () =>
      channel().sent.filter((sentEvent) => sentEvent.type === "session.commentary.append" && sentEvent.content !== SERVER_BACK_CONTEXT);
    ws.deliver({ type: "peer_queued", name: "mussa", text: "olha a requisição" });
    await waitFor(() =>
      expect(commentary()).toEqual([expect.objectContaining({ content: expect.stringMatching(/mussa.*«olha a requisição».*fila/) })]),
    );
    ws.deliver({ type: "user", text: "olha a requisição", at: 9, from: { kind: "user", name: "mussa" } });
    ws.deliver({ type: "result", isError: false });
    expect(commentary()).toHaveLength(1);
  });

  it("o mesmo texto vindo do outro dispositivo depois de esta aba já ter mandado ele também chega à voz", async () => {
    const { ws } = await openChat();
    await startCall();
    const commentary = () =>
      channel().sent.filter((sentEvent) => sentEvent.type === "session.commentary.append" && sentEvent.content !== SERVER_BACK_CONTEXT);
    await userEvent.type(screen.getByRole("textbox"), "sim{Enter}");
    await waitFor(() => expect(commentary()).toHaveLength(1));
    ws.deliver({ type: "result", isError: false });
    ws.deliver({ type: "user", text: "sim", at: 3, from: { kind: "owner", name: "operator" } });
    await waitFor(() => expect(commentary()).toHaveLength(2));
    expect(commentary()[1]).toEqual(expect.objectContaining({ content: expect.stringMatching(/operator.*«sim»/) }));
  });

  it("a mensagem longa que o servidor cortou no aviso da fila não é anunciada de novo quando sai da fila inteira", async () => {
    const { ws } = await openChat();
    await startCall();
    const commentary = () =>
      channel().sent.filter((sentEvent) => sentEvent.type === "session.commentary.append" && sentEvent.content !== SERVER_BACK_CONTEXT);
    const fullText = "log ".repeat(1_500);
    ws.deliver({ type: "peer_queued", name: "mussa", text: fullText.slice(0, 4_000) });
    await waitFor(() => expect(commentary()).toHaveLength(1));
    ws.deliver({ type: "user", text: fullText, at: 9, from: { kind: "user", name: "mussa" } });
    ws.deliver({ type: "result", isError: false });
    expect(commentary()).toHaveLength(1);
  });

  it("o mesmo texto deixado duas vezes na fila pela mesma pessoa é anunciado duas vezes e não se repete quando as duas saem da fila", async () => {
    const { ws } = await openChat();
    await startCall();
    const commentary = () =>
      channel().sent.filter((sentEvent) => sentEvent.type === "session.commentary.append" && sentEvent.content !== SERVER_BACK_CONTEXT);
    ws.deliver({ type: "peer_queued", name: "mussa", text: "ok" });
    ws.deliver({ type: "peer_queued", name: "mussa", text: "ok" });
    await waitFor(() => expect(commentary()).toHaveLength(2));
    ws.deliver({ type: "user", text: "ok", at: 9, from: { kind: "user", name: "mussa" } });
    ws.deliver({ type: "result", isError: false });
    ws.deliver({ type: "user", text: "ok", at: 10, from: { kind: "user", name: "mussa" } });
    ws.deliver({ type: "result", isError: false });
    expect(commentary()).toHaveLength(2);
  });

  it("a mensagem que fica na fila desta aba avisa as outras abas do card", async () => {
    const { ws } = await openChat();
    await userEvent.type(screen.getByRole("textbox"), "primeira{Enter}");
    await waitFor(() => expect(ws.frames.some((f) => f.type === "user" && f.text === "primeira")).toBe(true));
    await userEvent.type(screen.getByRole("textbox"), "segunda{Enter}");
    const queuedNotes = () =>
      ws.rawSent.map((raw) => JSON.parse(raw) as { type: string; text?: string }).filter((frame) => frame.type === "queued_note");
    await waitFor(() => expect(queuedNotes()).toEqual([{ type: "queued_note", text: "segunda" }]));
  });

  it("o chat diz ao servidor quando a chamada entra no ar, repete depois de um reconnect e avisa quando ela termina", async () => {
    const { ws } = await openChat();
    const callFrames = (socket: FakeSocket) =>
      socket.rawSent.map((raw) => JSON.parse(raw) as { type: string; active?: boolean }).filter((frame) => frame.type === "voice_call");
    expect(callFrames(ws)).toEqual([]);
    await startCall();
    await waitFor(() => expect(callFrames(ws)).toEqual([{ type: "voice_call", active: true }]));

    ws.drop();
    await waitFor(() => expect(FakeSocket.instances.length).toBe(2), { timeout: 5_000 });
    const again = FakeSocket.instances[1]!;
    again.accept();
    again.deliver({ type: "ready" });
    await waitFor(() => expect(callFrames(again)).toEqual([{ type: "voice_call", active: true }]));

    await userEvent.click(screen.getByTestId("voice-call-end"));
    act(() => channel().emit({ type: "session.closed", reason: "close_requested" }));
    await waitFor(() => expect(callFrames(again)).toEqual([{ type: "voice_call", active: true }, { type: "voice_call", active: false }]));
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

  it("a pergunta da voz vai ao agente do card, e a resposta dele volta para a voz falar", async () => {
    const { ws } = await openChat();
    await startCall();
    act(() => channel().emit({ type: "session.input_transcript.delta", delta: "recapitula tudo que tem no chat", start_ms: 0, end_ms: 900 }));
    act(() => channel().emit(toolCall("call_d1", "ask_card_agent", { request: "Recapitule a conversa do card e liste as decisões pendentes." })));
    act(() => channel().emit({ type: "session.output_transcript.delta", delta: "Claro, vou pedir ao agente.", start_ms: 1000, end_ms: 2000 }));

    await waitFor(() => expect(ws.frames.some((f) => f.type === "user" && f.text?.includes("Recapitule a conversa do card"))).toBe(true));
    expect(toolOutput(channel().sent, "call_d1")).toMatchObject({ ok: true });
    await waitFor(() => expect(screen.getByTestId("voice-call-bar")).toHaveAttribute("data-phase", "thinking"), { timeout: 3_000 });

    ws.deliver({ type: "assistant_text", text: "Resumo: falta decidir o layout da planilha e quem aprova as metas." });
    ws.deliver({ type: "result", isError: false });
    await waitFor(() =>
      expect(channel().sent).toContainEqual(expect.objectContaining({
        type: "session.commentary.append",
        delegation_id: null,
        content: expect.stringContaining("Resumo: falta decidir o layout da planilha e quem aprova as metas."),
      })),
    );
    expect(thinkingSent().join(" ")).not.toContain("falta decidir o layout");
  });

  it("a dropped wire mid-turn does not close a delegation early: the voice waits for the turn's real end", async () => {
    const { ws } = await openChat();
    await startCall();
    act(() => channel().emit(toolCall("call_d3", "ask_card_agent", { request: "Rode os testes." })));
    await waitFor(() => expect(ws.frames.some((f) => f.type === "user" && f.text?.includes("Rode os testes."))).toBe(true));
    ws.deliver({ type: "assistant_text", text: "Vou rodar." });
    ws.drop();
    const results = () => channel().sent.filter((sentEvent) => sentEvent.type === "session.commentary.append" && sentEvent.content !== SERVER_BACK_CONTEXT);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(results()).toEqual([]);

    await waitFor(() => expect(FakeSocket.instances.length).toBe(2), { timeout: 5_000 });
    const again = FakeSocket.instances[1]!;
    again.accept();
    again.deliver({ type: "ready" });
    again.deliver({ type: "assistant_text", text: "Os 12 testes passaram." });
    again.deliver({ type: "result", isError: false });
    await waitFor(() => expect(results()).toEqual([expect.objectContaining({ delegation_id: null, content: expect.stringContaining("Os 12 testes passaram.") })]));
  });

  it("deploy no meio do pedido: depois da reconexão, a voz espera a retomada do painel e fala a resposta dela, sem nada mandado de novo", async () => {
    const { ws } = await openChat();
    await startCall();
    act(() => channel().emit(toolCall("call_d4", "ask_card_agent", { request: "Rode os testes." })));
    await waitFor(() => expect(ws.frames.some((frame) => frame.type === "user" && frame.text?.includes("Rode os testes."))).toBe(true));
    const request = ws.frames.find((frame) => frame.type === "user")!.text!;
    ws.deliver({ type: "assistant_text", text: "Vou rodar a suíte." });
    ws.drop();

    await waitFor(() => expect(FakeSocket.instances.length).toBe(2), { timeout: 5_000 });
    const again = FakeSocket.instances[1]!;
    again.accept();
    again.deliver({ type: "user", text: request, at: 1 });
    again.deliver({ type: "assistant_text", text: "Vou rodar a suíte." });
    again.deliver({ type: "system_note", text: "O turno foi interrompido por uma atualização do painel — retomando automaticamente…", at: 2 });
    again.deliver({ type: "ready" });
    await waitFor(() => expect(thinkingSent()).toContainEqual(expect.stringContaining(DELEGATION_INTERRUPTED)));
    const spoken = () => channel().sent.filter((sentEvent) => sentEvent.type === "session.commentary.append" && sentEvent.content !== SERVER_BACK_CONTEXT);
    expect(spoken()).toEqual([]);

    again.deliver({ type: "user", text: "Continue de onde parou", at: 3, from: { kind: "system", name: "vibehub" } });
    again.deliver({ type: "assistant_text", text: "Os 12 testes passaram." });
    again.deliver({ type: "result", isError: false });
    await waitFor(() => expect(spoken()).toEqual([expect.objectContaining({ content: expect.stringContaining("Os 12 testes passaram.") })]));
    expect(again.frames.filter((frame) => frame.type === "user")).toEqual([]);
  });

  it("um pedido da voz com o agente ocupado fura a fila: vai urgente, como o enviar agora do chat", async () => {
    const { ws } = await openChat();
    ws.deliver({ type: "assistant_delta", text: "Subindo o back isolado…" });
    await startCall();
    act(() => channel().emit(toolCall("call_u1", "ask_card_agent", { request: "Por que você vai abrir uma tela?" })));

    await waitFor(() =>
      expect(ws.frames).toContainEqual(expect.objectContaining({ type: "user", now: true, text: expect.stringContaining("Por que você vai abrir uma tela?") })),
    );
    expect(screen.queryByTestId("sdk-queued")).not.toBeInTheDocument();
  });

  it("o result do turno que o pedido urgente cortou não faz a voz achar que o agente parou: ela espera e fala a resposta", async () => {
    const { ws } = await openChat();
    ws.deliver({ type: "tool_use", id: "t1", name: "Bash", input: { command: "npm test" } });
    await startCall();
    act(() => channel().emit(toolCall("call_u2", "ask_card_agent", { request: "Qual é a branch?" })));
    await waitFor(() => expect(ws.frames).toContainEqual(expect.objectContaining({ type: "user", now: true })));
    ws.deliver({ type: "result", isError: false, subtype: "error_during_execution", turnActive: true });
    const commentary = () => channel().sent.filter((sentEvent) => sentEvent.type === "session.commentary.append").map((sentEvent) => String(sentEvent.content));
    expect(thinkingSent().some((content) => content.includes(DELEGATION_INTERRUPTED))).toBe(false);
    ws.deliver({ type: "assistant_text", text: "card/recuperar-pedidos." });
    ws.deliver({ type: "result", isError: false, turnActive: false });
    await waitFor(() => expect(commentary()).toContainEqual(expect.stringContaining("card/recuperar-pedidos.")));
    expect(thinkingSent().some((content) => content.includes(DELEGATION_INTERRUPTED))).toBe(false);
  });

  it("com o card parado numa pergunta de múltipla escolha desde antes da chamada, a voz lê a pergunta e o pedido dela vai como resposta, sem fechar a pergunta", async () => {
    const { ws } = await openChat();
    ws.deliver({ type: "user_question", id: "q_1", questions: [{ question: "Qual caminho?", header: "Caminho", options: [{ label: "A", description: "a" }, { label: "B", description: "b" }] }] });
    await startCall();
    await waitFor(() =>
      expect(channel().sent).toContainEqual(expect.objectContaining({ type: "session.commentary.append", delegation_id: null, content: expect.stringContaining("Qual caminho?") })),
    );
    act(() => channel().emit({ type: "session.input_transcript.delta", delta: "abre um card pra esse bug e delega", start_ms: 0, end_ms: 900 }));
    act(() => channel().emit(toolCall("call_q1", "ask_card_agent", { request: "A pessoa quer abrir um card para esse bug." })));

    await waitFor(() =>
      expect(ws.frames).toContainEqual({ type: "question_answer", id: "q_1", answers: [{ selected: [expect.stringContaining("abre um card pra esse bug")] }] }),
    );
    expect(ws.frames.filter((frame) => frame.type === "user")).toEqual([]);
  });

  it("sem conexão, o pedido da voz fica guardado, sai sozinho quando ela volta, e a resposta chega à voz", async () => {
    const { ws } = await openChat();
    await startCall();
    ws.drop();
    act(() => channel().emit(toolCall("call_d2", "ask_card_agent", { request: "Rode os testes." })));
    await waitFor(() => expect(toolOutput(channel().sent, "call_d2")).toEqual({ ok: true, status: DELEGATION_QUEUED }));
    expect(ws.frames.some((frame) => frame.type === "user")).toBe(false);

    await waitFor(() => expect(FakeSocket.instances.length).toBe(2), { timeout: 5_000 });
    const again = FakeSocket.instances[1]!;
    again.accept();
    again.deliver({ type: "ready" });
    await waitFor(() => expect(again.frames.filter((frame) => frame.type === "user" && frame.text?.includes("Rode os testes."))).toHaveLength(1));
    again.deliver({ type: "assistant_text", text: "Os 12 testes passaram." });
    again.deliver({ type: "result", isError: false });
    await waitFor(() =>
      expect(channel().sent).toContainEqual(expect.objectContaining({ type: "session.commentary.append", content: expect.stringContaining("Os 12 testes passaram.") })),
    );
    expect(again.frames.filter((frame) => frame.type === "user")).toHaveLength(1);
  });

  it("ordem dada na chamada executa pela rota da voz e não interrompe o agente do card", async () => {
    const { ws } = await openChat();
    ws.deliver({ type: "assistant_delta", text: "Rodando a suíte…" });
    await startCall();
    vi.mocked(post).mockImplementation(((url: string) =>
      Promise.resolve(url.endsWith("/voice/actions") ? { output: { cardId: "c9", title: "Relatório" } } : { saved: [], duplicate: [] })) as never);
    act(() => channel().emit(toolCall("call_o1", "create_card", { projectId: "p1", title: "Relatório" })));

    await waitFor(() => expect(toolOutput(channel().sent, "call_o1")).toEqual({ cardId: "c9", title: "Relatório" }));
    expect(post).toHaveBeenCalledWith("/cards/c1/voice/actions", { callId: "call_o1", name: "create_card", arguments: '{"projectId":"p1","title":"Relatório"}' });
    expect(ws.frames.filter((f) => f.type === "user")).toEqual([]);
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

  it("the chat losing the server and getting it back mid-call makes the voice say so, once per return", async () => {
    const { ws } = await openChat();
    await startCall();
    const told = () => channel().sent.filter((sentEvent) => sentEvent.type === "session.commentary.append" && sentEvent.delegation_id === null);
    expect(told()).toEqual([]);

    ws.drop();
    await waitFor(() => expect(FakeSocket.instances.length).toBe(2), { timeout: 5_000 });
    expect(told()).toEqual([]);
    const second = FakeSocket.instances[1]!;
    second.accept();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(told()).toEqual([]);
    second.deliver({ type: "ready" });
    await waitFor(() => expect(told()).toEqual([expect.objectContaining({ content: SERVER_BACK_CONTEXT })]));

    second.drop();
    await waitFor(() => expect(FakeSocket.instances.length).toBe(3), { timeout: 5_000 });
    const third = FakeSocket.instances[2]!;
    third.accept();
    third.deliver({ type: "ready" });
    await waitFor(() => expect(told()).toHaveLength(2));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(told()).toHaveLength(2);
  });

  it("a server drop still going on when the call starts is announced when the server comes back", async () => {
    const { ws } = await openChat();
    ws.drop();
    await startCall();
    const told = () => channel().sent.filter((sentEvent) => sentEvent.type === "session.commentary.append" && sentEvent.delegation_id === null);
    expect(told()).toEqual([]);
    await waitFor(() => expect(FakeSocket.instances.length).toBe(2), { timeout: 5_000 });
    const again = FakeSocket.instances[1]!;
    again.accept();
    again.deliver({ type: "ready" });
    await waitFor(() => expect(told()).toEqual([expect.objectContaining({ content: SERVER_BACK_CONTEXT })]));
  });

  it("a server drop already over before the call is not announced when the call starts", async () => {
    const { ws } = await openChat();
    ws.drop();
    await waitFor(() => expect(FakeSocket.instances.length).toBe(2), { timeout: 5_000 });
    const again = FakeSocket.instances[1]!;
    again.accept();
    again.deliver({ type: "ready" });
    await startCall();
    expect(channel().sent.filter((sentEvent) => sentEvent.type === "session.commentary.append")).toEqual([]);
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

describe("a pergunta com opções do agente durante a chamada", () => {
  const QUESTION = {
    type: "user_question",
    id: "q_1_100",
    questions: [
      {
        question: "Onde guardo as metas?",
        header: "Metas",
        options: [
          { label: "Planilha (Recomendado)", description: "Rápido de editar" },
          { label: "Banco novo", description: "Exige migração" },
        ],
      },
    ],
  };
  const commentary = () => channel().sent.filter((event) => event.type === "session.commentary.append");
  const sayAndAsk = (said: string, callId: string) => {
    act(() => channel().emit({ type: "session.input_transcript.delta", delta: said, start_ms: 0, end_ms: 500 }));
    act(() => channel().emit(toolCall(callId, "ask_card_agent", { request: said })));
  };

  it("a voz lê a pergunta, as opções e a recomendada, e pede a escolha por voz — sem mandar ao chat", async () => {
    const { ws } = await openChat();
    await startCall();
    ws.deliver({ type: "user", text: "decide a planilha", at: 1 });
    ws.deliver(QUESTION);
    await waitFor(() => expect(commentary()).toHaveLength(1));
    const spoken = commentary()[0]!;
    expect(spoken.delegation_id).toBeNull();
    for (const part of ["Onde guardo as metas?", "Planilha (Recomendado)", "Rápido de editar", "Banco novo", "recomendada"]) {
      expect(spoken.content).toContain(part);
    }
    expect(spoken.content).not.toMatch(/conferir no chat|veja no chat|olhe o chat/i);
  });

  it("com um pedido da voz esperando o agente, a pergunta é o que a voz ouve sobre esse pedido", async () => {
    const { ws } = await openChat();
    await startCall();
    sayAndAsk("organiza as metas", "call_m1");
    await waitFor(() => expect(ws.frames.some((frame) => frame.type === "user" && frame.text?.includes("organiza as metas"))).toBe(true));
    ws.deliver(QUESTION);
    ws.deliver({ type: "result", isError: false });
    await waitFor(() => expect(commentary()).toEqual([expect.objectContaining({ delegation_id: null, content: expect.stringContaining("Onde guardo as metas?") })]));
  });

  it("a escolha dita volta ao agente como resposta daquela pergunta (question_answer), sem fechar a pergunta com um envio urgente", async () => {
    const { ws } = await openChat();
    await startCall();
    ws.deliver({ type: "user", text: "decide a planilha", at: 1 });
    ws.deliver(QUESTION);
    await waitFor(() => expect(commentary()).toHaveLength(1));

    sayAndAsk("pode ser o banco novo", "call_m2");
    await waitFor(() => expect(ws.frames.some((frame) => frame.type === "question_answer")).toBe(true));
    const answer = ws.frames.find((frame) => frame.type === "question_answer")!;
    expect(answer.id).toBe("q_1_100");
    expect(answer.answers).toEqual([{ selected: [expect.stringContaining("pode ser o banco novo")] }]);
    expect(ws.frames.filter((frame) => frame.type === "user")).toEqual([]);
    expect(toolOutput(channel().sent, "call_m2")).toEqual({ ok: true, status: QUESTION_ANSWER_SENT });

    ws.deliver({ type: "question_result", id: "q_1_100", answers: answer.answers });
    ws.deliver({ type: "assistant_text", text: "Feito: as metas vão para o banco novo." });
    ws.deliver({ type: "result", isError: false });
    await waitFor(() =>
      expect(commentary()).toContainEqual(expect.objectContaining({ delegation_id: null, content: expect.stringContaining("Feito: as metas vão para o banco novo.") })),
    );
  });

  it("a pergunta que um reconnect repete não é lida de novo", async () => {
    const { ws } = await openChat();
    await startCall();
    ws.deliver({ type: "user", text: "decide a planilha", at: 1 });
    ws.deliver(QUESTION);
    await waitFor(() => expect(commentary()).toHaveLength(1));
    ws.drop();
    await waitFor(() => expect(FakeSocket.instances.length).toBe(2), { timeout: 5_000 });
    const again = FakeSocket.instances[1]!;
    again.accept();
    again.deliver({ type: "user", text: "decide a planilha", at: 1 });
    again.deliver(QUESTION);
    again.deliver({ type: "ready" });
    await waitFor(() => expect(commentary()).toContainEqual(expect.objectContaining({ content: SERVER_BACK_CONTEXT })));
    expect(commentary().filter((event) => String(event.content).includes("Onde guardo as metas?"))).toHaveLength(1);
  });
});
