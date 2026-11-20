import { describe, it, expect, beforeEach, afterEach, onTestFinished, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";

/**
 * VOICE INSIDE THE CARD'S CHAT — the call is born with the context of the card's conversation, and the
 * spoken turns go into the SAME chat log (idempotent by `vid`). The OpenAI fetch is fake.
 */
vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

const OFFER = "v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\ns=-\r\n";
const KEY = "sk-test-voice-key-never-leaks";

let dir = "";
let app: FastifyInstance;
let owner = "";
const upstream = vi.fn();
const delivery = { failure: null as Error | null };
const sendToTerminal = vi.fn(async (cardId: string) => {
  if (delivery.failure) throw delivery.failure;
  return { sent: true, cardId, title: "", project: "" };
});

async function boot(): Promise<FastifyInstance> {
  vi.resetModules();
  const env = await import("../config/env.js");
  env.config.dataDir = dir;
  env.config.secretKey = "";
  env.config.sessionSecret = "";
  env.config.insecureCookies = true;
  env.config.voiceLive = { enabled: true, apiKey: KEY };
  vi.doMock("../runtime/runner.js", () => ({
    provisionRunner: vi.fn(async () => undefined),
    startRunner: vi.fn(async () => undefined),
    runnerToken: vi.fn(async () => "runner-token"),
    runnerStatus: vi.fn(async () => ({
      running: true, exists: true, claudeInstalled: true, dockerReachable: true,
      container: "vibehub-runner", host: "this machine",
    })),
  }));
  vi.doMock("../services/board/workspace.js", async () => {
    const actual = await vi.importActual<typeof import("../services/board/workspace.js")>("../services/board/workspace.js");
    return { ...actual, prepareCard: vi.fn(async () => undefined), openCard: vi.fn(async () => undefined) };
  });
  vi.doMock("../services/maestro/maestro.js", async () => ({
    ...(await vi.importActual<typeof import("../services/maestro/maestro.js")>("../services/maestro/maestro.js")),
    sendToTerminal,
    waitTerminalReady: vi.fn(async () => ({ ready: true })),
  }));
  const { buildServer } = await import("../index.js");
  const server = await buildServer();
  await server.ready();
  return server;
}

function cookieOf(res: { cookies: { name: string; value: string }[] }): string {
  return `vibehub_session=${res.cookies.find((c) => c.name === "vibehub_session")?.value ?? ""}`;
}

async function makeCard(): Promise<string> {
  const projectId = (await app.inject({
    method: "POST", url: "/api/projects", headers: { cookie: owner }, payload: { name: "p" },
  })).json().project.id as string;
  return (await app.inject({
    method: "POST", url: "/api/cards", headers: { cookie: owner }, payload: { projectId, title: "voz" },
  })).json().card.id as string;
}

function saveTurns(cardId: string, turns: unknown[], cookie = owner) {
  return app.inject({ method: "POST", url: `/api/cards/${cardId}/voice/turns`, headers: { cookie }, payload: { turns } });
}

async function history(cardId: string) {
  const { readHistory } = await import("../services/sdk/history.js");
  return await readHistory(cardId);
}

const RESPONSES_URL = "https://api.openai.com/v1/responses";
const LIVE_SESSIONS_URL = "https://api.openai.com/v1/live/sessions";

function summaryAnswer(text: string) {
  return new Response(JSON.stringify({ status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text }] }] }), {
    status: 200, headers: { "content-type": "application/json" },
  });
}

function openAi(summary: () => Response) {
  upstream.mockImplementation(async (url: string) => (url === RESPONSES_URL ? summary() : answer()));
}

function sentSession() {
  const live = upstream.mock.calls.find(([url]) => url !== RESPONSES_URL) as [string, RequestInit];
  return JSON.parse(String(live[1].body));
}

function answer() {
  return new Response(JSON.stringify({ session: { id: "live_9" }, transport: { type: "webrtc", sdp: "v=0 answer" } }), {
    status: 201, headers: { "content-type": "application/json" },
  });
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "vibehub-voice-card-"));
  upstream.mockReset();
  sendToTerminal.mockClear();
  delivery.failure = null;
  vi.stubGlobal("fetch", upstream);
  app = await boot();
  owner = cookieOf(await app.inject({
    method: "POST", url: "/api/setup/owner", payload: { username: "owner", password: "supersecret" },
  }));
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await app.close();
  await rm(dir, { recursive: true, force: true });
});

describe("POST /api/cards/:id/voice/turns", () => {
  it("writes the spoken turns into the card's chat log, in order, stamped with who held the call", async () => {
    const id = await makeCard();
    const at = Date.now();
    const res = await saveTurns(id, [
      { vid: "turn-user-1", role: "user", text: "  qual o status do deploy?  ", at },
      { vid: "turn-ai-1", role: "assistant", text: "O agente terminou o build.", at: at + 900 },
    ]);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ saved: ["turn-user-1", "turn-ai-1"], duplicate: [] });
    const log = (await history(id)).filter((e) => e.type === "voice_turn");
    expect(log).toEqual([
      { type: "voice_turn", vid: "turn-user-1", role: "user", text: "qual o status do deploy?", at, from: { kind: "owner", name: "owner" } },
      { type: "voice_turn", vid: "turn-ai-1", role: "assistant", text: "O agente terminou o build.", at: at + 900, from: { kind: "owner", name: "owner" } },
    ]);
  });

  it("is idempotent on vid: a retry, or two saves racing, writes the turn once", async () => {
    const id = await makeCard();
    const turn = { vid: "turn-user-2", role: "user", text: "oi", at: Date.now() };
    const [a, b] = await Promise.all([saveTurns(id, [turn]), saveTurns(id, [turn])]);
    expect([...a.json().saved, ...b.json().saved]).toEqual(["turn-user-2"]);
    expect((await saveTurns(id, [turn])).json()).toEqual({ saved: [], duplicate: ["turn-user-2"] });
    expect((await history(id)).filter((e) => e.type === "voice_turn")).toHaveLength(1);
  });

  it("remembers the ids already on disk after a restart", async () => {
    const id = await makeCard();
    const turn = { vid: "turn-user-3", role: "user", text: "persistiu", at: Date.now() };
    await saveTurns(id, [turn]);
    await app.close();
    app = await boot();
    owner = cookieOf(await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "owner", password: "supersecret" } }));
    expect((await saveTurns(id, [turn])).json()).toEqual({ saved: [], duplicate: ["turn-user-3"] });
  });

  it("a retry after a long conversation (past the replay window) still finds its turn", async () => {
    const id = await makeCard();
    const turn = { vid: "turn-early-1", role: "user", text: "lá atrás", at: Date.now() };
    await saveTurns(id, [turn]);
    const { appendHistoryReported } = await import("../services/sdk/history.js");
    for (let i = 0; i < 600; i++) await appendHistoryReported(id, { type: "user", text: `msg ${i}` });
    await app.close();
    app = await boot();
    owner = cookieOf(await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "owner", password: "supersecret" } }));
    expect((await saveTurns(id, [turn])).json()).toEqual({ saved: [], duplicate: ["turn-early-1"] });
  });

  it("drops blank turns and clamps a skewed clock to the server's", async () => {
    const id = await makeCard();
    const res = await saveTurns(id, [
      { vid: "turn-blank", role: "user", text: "   ", at: Date.now() },
      { vid: "turn-skew", role: "assistant", text: "ok", at: 1 },
    ]);
    expect(res.json().saved).toEqual(["turn-skew"]);
    const [turn] = (await history(id)).filter((e) => e.type === "voice_turn");
    expect(Math.abs((turn.at ?? 0) - Date.now())).toBeLessThan(60_000);
  });

  it.each([
    [{ vid: "x", role: "user", text: "a", at: 1 }, "short id"],
    [{ vid: "turn-ok-1", role: "system", text: "a", at: 1 }, "bad role"],
    [{ vid: "turn-ok-1", role: "user", text: 3, at: 1 }, "no text"],
    [{ vid: "turn-ok-1", role: "user", text: "a".repeat(8_001), at: 1 }, "too long"],
  ])("400s a bad turn (%j: %s) and writes nothing", async (turn) => {
    const id = await makeCard();
    expect((await saveTurns(id, [turn])).statusCode).toBe(400);
    expect((await history(id)).filter((e) => e.type === "voice_turn")).toHaveLength(0);
  });

  it("401s without a session, 404s an unknown card", async () => {
    const id = await makeCard();
    expect((await saveTurns(id, [{ vid: "turn-x-1", role: "user", text: "a", at: 1 }], "")).statusCode).toBe(401);
    expect((await saveTurns("ghost", [{ vid: "turn-x-1", role: "user", text: "a", at: 1 }])).statusCode).toBe(404);
  });

  it("refuses a read-only share: reading the chat is not holding a call in it", async () => {
    const id = await makeCard();
    const memberId = (await app.inject({
      method: "POST", url: "/api/users", headers: { cookie: owner },
      payload: { username: "alex", password: "supersecret", role: "member" },
    })).json().user.id as string;
    await app.inject({ method: "POST", url: `/api/cards/${id}/shares`, headers: { cookie: owner }, payload: { userId: memberId, level: "view" } });
    const member = cookieOf(await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "alex", password: "supersecret" } }));
    expect((await saveTurns(id, [{ vid: "turn-ro-1", role: "user", text: "a", at: Date.now() }], member)).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: `/api/cards/${id}/voice/sessions`, headers: { cookie: member }, payload: { sdp: OFFER } })).statusCode).toBe(403);
    expect(upstream).not.toHaveBeenCalled();
  });
});

describe("POST /api/cards/:id/voice/sessions", () => {
  it("opens the call knowing the card's recent thread — typed, answered and spoken", async () => {
    const id = await makeCard();
    const { appendHistoryReported } = await import("../services/sdk/history.js");
    await appendHistoryReported(id, { type: "user", text: "corrige o teste do login", at: 1 });
    await appendHistoryReported(id, { type: "tool_use", id: "t1", name: "Bash", input: { command: "cat .env" } });
    await appendHistoryReported(id, { type: "assistant_text", text: "Corrigido, 12 testes verdes." } as never);
    await saveTurns(id, [{ vid: "turn-ctx-1", role: "user", text: "e o deploy?", at: Date.now() }]);
    openAi(() => summaryAnswer("resumo"));

    const res = await app.inject({ method: "POST", url: `/api/cards/${id}/voice/sessions`, headers: { cookie: owner }, payload: { sdp: OFFER } });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({ sessionId: "live_9", sdp: "v=0 answer" });
    const sent = sentSession();
    const instructions = sent.session.instructions as string;
    expect(instructions).toContain("agente do card");
    expect(instructions).toContain("Pessoa (digitou): corrige o teste do login");
    expect(instructions).toContain("Agente do card (Claude): Corrigido, 12 testes verdes.");
    expect(instructions).toContain("Pessoa (falou): e o deploy?");
    // Tool calls never reach the voice: noise, and sometimes secrets the agent printed.
    expect(instructions).not.toContain(".env");
    expect(instructions.indexOf("corrige")).toBeLessThan(instructions.indexOf("e o deploy?"));
    expect(instructions).toContain("Generate <|SpawnThinking|> when:");
    expect(instructions).toContain("recapitular");
  });

  it("a chamada no card delega ao backend Responses com as ferramentas da voz", async () => {
    const id = await makeCard();
    openAi(() => summaryAnswer("resumo"));
    await app.inject({ method: "POST", url: `/api/cards/${id}/voice/sessions`, headers: { cookie: owner }, payload: { sdp: OFFER } });
    const { delegation, instructions } = sentSession().session;
    const { VOICE_TOOL_NAMES } = await import("../services/voice/executor.js");
    expect(delegation.type).toBe("responses");
    expect(delegation.responses.model).toBe("gpt-6-luna");
    expect(delegation.responses.tools.map((tool: { name: string }) => tool.name)).toEqual([...VOICE_TOOL_NAMES]);
    expect(delegation.responses.parallel_tool_calls).toBe(false);
    expect(delegation.responses.instructions).toContain('card "voz"');
    expect(delegation.responses.instructions).toContain('projeto "p"');
    expect(instructions).toContain("criar card");
  });

  it("abre a chamada já sabendo o resumo da conversa inteira do card, pedido antes de criar a sessão", async () => {
    const id = await makeCard();
    const { appendHistoryReported } = await import("../services/sdk/history.js");
    await appendHistoryReported(id, { type: "user", text: "revisa a PR 647", at: 1 });
    await appendHistoryReported(id, { type: "assistant_text", text: "Revisei: 9 de 12 achados fechados, o gate estourou o prazo." } as never);
    openAi(() => summaryAnswer("O card revisa a PR 647: nove achados fechados, merge travado pelo gate."));

    const res = await app.inject({ method: "POST", url: `/api/cards/${id}/voice/sessions`, headers: { cookie: owner }, payload: { sdp: OFFER } });
    expect(res.statusCode).toBe(201);
    expect(upstream.mock.calls.map(([url]) => url)).toEqual([RESPONSES_URL, LIVE_SESSIONS_URL]);
    const summaryBody = JSON.parse(String((upstream.mock.calls[0] as [string, RequestInit])[1].body));
    expect(summaryBody.input).toContain("Revisei: 9 de 12 achados fechados");
    const instructions = sentSession().session.instructions as string;
    expect(instructions).toContain("Resumo da conversa deste card até agora:\nO card revisa a PR 647: nove achados fechados, merge travado pelo gate.");
    expect(instructions).toContain("Agente do card (Claude): Revisei: 9 de 12 achados fechados");
  });

  it("sem resumo (a OpenAI falhou nele), a chamada abre com a conversa recente", async () => {
    const id = await makeCard();
    const { appendHistoryReported } = await import("../services/sdk/history.js");
    await appendHistoryReported(id, { type: "user", text: "roda os testes", at: 1 });
    openAi(() => new Response("{}", { status: 500 }));

    const res = await app.inject({ method: "POST", url: `/api/cards/${id}/voice/sessions`, headers: { cookie: owner }, payload: { sdp: OFFER } });
    expect(res.statusCode).toBe(201);
    const instructions = sentSession().session.instructions as string;
    expect(instructions).not.toContain("Resumo da conversa deste card até agora");
    expect(instructions).toContain("O resumo da conversa deste card não ficou pronto");
    expect(instructions).toContain("Pessoa (digitou): roda os testes");
  });

  it("um card sem conversa abre a chamada sem pedir resumo", async () => {
    const id = await makeCard();
    openAi(() => summaryAnswer("nunca"));
    expect((await app.inject({ method: "POST", url: `/api/cards/${id}/voice/sessions`, headers: { cookie: owner }, payload: { sdp: OFFER } })).statusCode).toBe(201);
    expect(upstream.mock.calls.map(([url]) => url)).toEqual([LIVE_SESSIONS_URL]);
  });

  it("as instruções mandam esclarecer a dúvida e falar o pedido completo antes de delegar", async () => {
    const id = await makeCard();
    openAi(() => summaryAnswer("resumo"));
    await app.inject({ method: "POST", url: `/api/cards/${id}/voice/sessions`, headers: { cookie: owner }, payload: { sdp: OFFER } });
    const instructions = sentSession().session.instructions as string;
    expect(instructions).toContain("pergunte antes de passar ao agente");
    expect(instructions).toContain("fale em voz alta o pedido completo");
  });

  it.each([
    ["pergunta da pessoa vem antes de qualquer novidade do agente", "Pergunta da pessoa é urgente"],
    ["o que o agente faz e por quê é delegado na hora", "- A pessoa pergunta sobre o que o agente está fazendo, por que fez ou vai fazer algo."],
    ["criar card e delegar a outro card são ações delegadas", "criar um card, delegar a outro card"],
    ["nada é confirmado sem a delegação na mesma vez", "Nunca diga que vai fazer ou que está fazendo algo sem gerar <|SpawnThinking|>"],
    ["feito só quando o resultado disser", "Só diga que algo foi feito quando o resultado da tarefa disser"],
    ["a voz nunca manda a pessoa conferir o chat", "Nunca mande a pessoa conferir ou ler o chat"],
    ["perguntas e ordens pendentes não caem", "Guarde as perguntas e ordens da pessoa que ainda não tiveram resultado"],
  ])("as instruções da chamada: %s", async (_rule, text) => {
    const id = await makeCard();
    openAi(() => summaryAnswer("resumo"));
    await app.inject({ method: "POST", url: `/api/cards/${id}/voice/sessions`, headers: { cookie: owner }, payload: { sdp: OFFER } });
    expect(sentSession().session.instructions as string).toContain(text);
  });

  it("still 404s while the mode is off, without calling OpenAI", async () => {
    const id = await makeCard();
    const env = await import("../config/env.js");
    env.config.voiceLive = { enabled: false, apiKey: KEY };
    expect((await app.inject({ method: "POST", url: `/api/cards/${id}/voice/sessions`, headers: { cookie: owner }, payload: { sdp: OFFER } })).statusCode).toBe(404);
    expect(upstream).not.toHaveBeenCalled();
  });
});

function voiceAction(cardId: string, body: Record<string, unknown>, cookie = owner) {
  return app.inject({ method: "POST", url: `/api/cards/${cardId}/voice/actions`, headers: { cookie }, payload: body });
}

async function cardsOf(cardId: string) {
  const registry = await import("../services/board/registry.js");
  const card = await registry.getCard(cardId);
  return await registry.listCards(card!.projectId);
}

async function memberWith(cardId: string, level: "view" | "work") {
  const memberId = (await app.inject({
    method: "POST", url: "/api/users", headers: { cookie: owner },
    payload: { username: "alex", password: "supersecret", role: "member" },
  })).json().user.id as string;
  await app.inject({ method: "POST", url: `/api/cards/${cardId}/shares`, headers: { cookie: owner }, payload: { userId: memberId, level } });
  return cookieOf(await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "alex", password: "supersecret" } }));
}

describe("POST /api/cards/:id/voice/actions", () => {
  it("o dono cria um card pela voz e o resultado volta em output", async () => {
    const id = await makeCard();
    const projectId = (await cardsOf(id))[0]!.projectId;
    const res = await voiceAction(id, { callId: "call_a", name: "create_card", arguments: JSON.stringify({ projectId, title: "Relatório", instruction: "Faça a tarefa." }) });
    expect(res.statusCode).toBe(200);
    expect(res.json().output).toMatchObject({ title: "Relatório", projectId, delivered: true });
    expect(sendToTerminal.mock.calls[0]?.slice(0, 2)).toEqual([res.json().output.cardId, "Faça a tarefa."]);
    expect((await cardsOf(id)).map((card) => card.title)).toContain("Relatório");
  });

  it("card criado pela voz cuja instrução não chegou volta 200 com delivered false e o motivo, para a voz contar", async () => {
    const id = await makeCard();
    const projectId = (await cardsOf(id))[0]!.projectId;
    delivery.failure = new Error("runner fora do ar");
    const res = await voiceAction(id, { callId: "call_e", name: "create_card", arguments: JSON.stringify({ projectId, title: "Sem entrega", instruction: "Faça a tarefa." }) });
    expect(res.statusCode).toBe(200);
    expect(res.json().output).toMatchObject({ title: "Sem entrega", delivered: false, deliveryError: "runner fora do ar" });
    expect((await cardsOf(id)).map((card) => card.title)).toContain("Sem entrega");
  });

  it("o mesmo callId repetido não cria dois cards", async () => {
    const id = await makeCard();
    const projectId = (await cardsOf(id))[0]!.projectId;
    const body = { callId: "call_b", name: "create_card", arguments: JSON.stringify({ projectId, title: "Uma vez", instruction: "Faça a tarefa." }) };
    const [first, second] = await Promise.all([voiceAction(id, body), voiceAction(id, body)]);
    expect(second.json()).toEqual(first.json());
    expect((await cardsOf(id)).filter((card) => card.title === "Uma vez")).toHaveLength(1);
  });

  it("callId diferente é outra ordem", async () => {
    const id = await makeCard();
    const projectId = (await cardsOf(id))[0]!.projectId;
    const order = JSON.stringify({ projectId, title: "Duas vezes", instruction: "Faça a tarefa." });
    await voiceAction(id, { callId: "call_c1", name: "create_card", arguments: order });
    await voiceAction(id, { callId: "call_c2", name: "create_card", arguments: order });
    expect((await cardsOf(id)).filter((card) => card.title === "Duas vezes")).toHaveLength(2);
  });

  it("falha da ordem responde o status do service e repetir a mesma ordem executa de novo", async () => {
    const id = await makeCard();
    const member = await memberWith(id, "work");
    const body = { callId: "call_d", name: "create_card", arguments: JSON.stringify({ projectId: (await cardsOf(id))[0]!.projectId, title: "x", instruction: "Faça a tarefa." }) };
    const refused = await voiceAction(id, body, member);
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error).toContain("only the owner");
    expect((await voiceAction(id, body, member)).statusCode).toBe(403);
  });

  it("ordem que o board recusa volta com o status e o motivo, para a voz dizer à pessoa", async () => {
    const id = await makeCard();
    const res = await voiceAction(id, { callId: "call_j", name: "create_card", arguments: JSON.stringify({ projectId: "inventado", title: "x", instruction: "Faça a tarefa." }) });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "project not found" });
  });

  it("ordem que o board recusa não vira falha da plataforma", async () => {
    const { onLogLine } = await import("../utils/logger.js");
    const { isPlatformFailureLogLine } = await import("../services/platformFailures/backendError.js");
    const loggedLines: import("../utils/logger.js").LogLine[] = [];
    onTestFinished(onLogLine("warn", (line) => loggedLines.push(line)));
    const id = await makeCard();
    const res = await voiceAction(id, { callId: "call_r", name: "create_card", arguments: JSON.stringify({ projectId: "inventado", title: "x" }) });
    expect(res.statusCode).toBe(404);
    expect(loggedLines.filter((line) => isPlatformFailureLogLine(line, undefined, Date.now()))).toEqual([]);
  });

  it("o mesmo callId com outra ferramenta executa a outra, não devolve o resultado guardado", async () => {
    const id = await makeCard();
    const projectId = (await cardsOf(id))[0]!.projectId;
    expect((await voiceAction(id, { callId: "call_m", name: "list_projects", arguments: "{}" })).statusCode).toBe(200);
    const created = await voiceAction(id, { callId: "call_m", name: "create_card", arguments: JSON.stringify({ projectId, title: "Outra ferramenta", instruction: "Faça a tarefa." }) });
    expect(created.json().output.title).toBe("Outra ferramenta");
  });

  it("falha de infraestrutura ao executar a ordem é 502, sem a mensagem interna na resposta", async () => {
    const id = await makeCard();
    const other = await makeCard();
    delivery.failure = new Error("docker exec failed: no such container");
    const res = await voiceAction(id, { callId: "call_k", name: "send_to_card", arguments: JSON.stringify({ cardId: other, text: "rode os testes" }) });
    expect(res.statusCode).toBe(502);
    expect(res.json()).toEqual({ error: "the board failed to run send_to_card; the server log has the detail" });
  });

  it("compartilhamento view não usa a voz", async () => {
    const id = await makeCard();
    const member = await memberWith(id, "view");
    expect((await voiceAction(id, { callId: "call_e", name: "list_projects", arguments: "{}" }, member)).statusCode).toBe(403);
  });

  it("sem acesso ao card da chamada responde 404", async () => {
    const id = await makeCard();
    const other = await makeCard();
    const member = await memberWith(other, "work");
    expect((await voiceAction(id, { callId: "call_f", name: "list_projects", arguments: "{}" }, member)).statusCode).toBe(404);
  });

  it("voz desligada responde 404", async () => {
    const id = await makeCard();
    const env = await import("../config/env.js");
    env.config.voiceLive = { enabled: false, apiKey: KEY };
    expect((await voiceAction(id, { callId: "call_g", name: "list_projects", arguments: "{}" })).statusCode).toBe(404);
  });

  it.each([
    ["sem callId", { name: "list_projects", arguments: "{}" }],
    ["arguments que não é texto", { callId: "call_h", name: "list_projects", arguments: {} }],
    ["ferramenta desconhecida", { callId: "call_i", name: "drop_db", arguments: "{}" }],
  ])("corpo inválido (%s) responde 400 { error }", async (_case, body) => {
    const id = await makeCard();
    const res = await voiceAction(id, body);
    expect(res.statusCode).toBe(400);
    expect(typeof res.json().error).toBe("string");
  });
});

describe("formatVoiceContext", () => {
  it("keeps the newest lines inside the budget and clips a long answer", async () => {
    const { formatVoiceContext, CONTEXT_ITEM_MAX_CHARS } = await import("../services/voice/context.js");
    const events = [
      { type: "user", text: "primeira" },
      { type: "assistant_text", text: "x".repeat(5_000) },
      { type: "voice_turn", vid: "v1", role: "assistant", text: "última" },
    ] as never[];
    const all = formatVoiceContext(events);
    expect(all).toContain("primeira");
    expect(all).toContain(`${"x".repeat(CONTEXT_ITEM_MAX_CHARS - 1)}…`);
    const tight = formatVoiceContext(events, 40);
    expect(tight).toBe("Você (voz): última");
    expect(formatVoiceContext([])).toBe("");
  });
});
