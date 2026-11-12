import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * THE DEPLOY IN THE MIDDLE OF A MAESTRO ORDER (production, card a28ffa23, 2026-10-20 21:56 UTC). The order
 * came through the external MCP (ChatGPT, on César's behalf) → `sendToTerminal` → `sendAgentTurn`. The blue/green
 * from #181 killed the old back with the CLI waiting for the API's answer right after a commit; the turn
 * had no in-flight marker, so the new boot had nothing to resume, and the board stayed `working`
 * (written by the dead process) until someone wrote. The "No response requested." the agent read
 * afterwards was the `<synthetic>` filler the CLI inserts when resuming the session — not a decision of the model.
 *
 * Two back processes, for real: reloaded modules (another owner identity, memory
 * reset), REAL registry, markers and history in the same data folder. Only the driver is fake.
 */

let dir = "";

function fakeChild() {
  const child = new EventEmitter() as EventEmitter & Record<string, unknown>;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  const written: string[] = [];
  const stdin = new EventEmitter() as EventEmitter & Record<string, unknown>;
  stdin.writable = true;
  stdin.write = (s: string) => { written.push(s); return true; };
  stdin.end = () => { stdin.writable = false; };
  child.stdin = stdin;
  child.exitCode = null;
  child.kill = () => {};
  return Object.assign(child, { written });
}
type Child = ReturnType<typeof fakeChild>;

/** A back process: fresh modules over the same data folder. */
async function bootProcess() {
  vi.resetModules();
  const env = await import("../../config/env.js");
  env.config.dataDir = dir;
  vi.doMock("../board/workspace.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../board/workspace.js")>()),
    killCardSession: vi.fn(async () => undefined),
    restartCard: vi.fn(async () => undefined),
    restoreMissingWorkspace: vi.fn(async () => undefined),
  }));
  vi.doMock("../board/outbox.js", () => ({ flushCard: vi.fn(async () => undefined) }));
  const registry = await import("../board/registry.js");
  await import("../board/status.js"); // registers the dot's sink, like the real boot
  const manager = await import("./manager.js");
  const inflight = await import("./inflight.js");
  const resume = await import("./resume.js");
  const maestro = await import("../maestro/maestro.js");
  const children: Child[] = [];
  manager.setDriverSpawnerForTesting(() => {
    const child = fakeChild();
    children.push(child);
    return child as never;
  });
  const emit = (i: number, event: object) =>
    (children[i]!.stdout as EventEmitter).emit("data", Buffer.from(JSON.stringify(event) + "\n"));
  return { registry, manager, inflight, resume, maestro, children, emit };
}
type Proc = Awaited<ReturnType<typeof bootProcess>>;

/** The new process's boot sweep with the real pieces; only the runner (install, command) is fake. */
function sweep(b: Proc, settings: { sdkDriver: boolean; sdkAutoResume: boolean }) {
  const { registry, manager, inflight, resume } = b;
  return resume.resumeInterruptedTurns({
    listMarkers: inflight.listInflightMarkers,
    clearMarker: inflight.clearInflightMarker,
    getCard: registry.getCard,
    getProject: registry.getProject,
    settings: async () => settings as never,
    installDriver: async () => undefined,
    restoreWorkspace: async () => undefined,
    commandFor: async () => ({ file: "docker", args: ["exec"] }),
    ensureSession: manager.ensureDriverSession,
    inject: manager.injectSystemTurn,
    appendNote: (cardId, text, extra) => import("./history.js").then((h) => h.appendHistory(cardId, { type: "system_note", text, ...(extra?.lostBackground ? { lostBackground: extra.lostBackground } : {}), at: Date.now() })),
    readMarker: inflight.readInflightMarker,
    selfOwner: inflight.INFLIGHT_OWNER,
    ownerAlive: inflight.isInflightOwnerAlive,
    turnRunning: manager.driverTurnRunning,
    stopping: () => false,
    reportIdle: (cardId) => { void import("../board/agentState.js").then((a) => a.reportCardStatusFromDriver(cardId, "waiting")); },
    awaitingAnswer: resume.awaitingAnswerInHistory,
    markAwaitingDecision: (cardId) => registry.setCardAwaitingDecision(cardId, Date.now()),
    wait: async () => undefined,
  });
}

const settle = () => new Promise((r) => setTimeout(r, 60));
const OWNER_ORIGIN = { kind: "owner", name: "cesar" } as const;

/**
 * The OLD process: card open, driver alive, ChatGPT's order comes in through the maestro and the agent
 * starts working (commit). After that the process "dies": nothing of it runs any more, and its
 * heartbeat was never touched (blue/green's SIGKILL lets go of nothing).
 */
async function oldProcessRunsAMaestroOrder() {
  const a = await bootProcess();
  const project = await a.registry.createProject({ name: "vibehub" });
  const card = await a.registry.createCard({ projectId: project.id, title: "notificações" });
  await a.registry.applyOpenTerminal(card.id);
  a.manager.ensureDriverSession({ cardId: card.id, label: "a28f", command: { file: "docker", args: ["exec"] } });
  a.emit(0, { type: "ready" });
  await a.maestro.sendToTerminal(card.id, "implemente o adaptador MCP Events e commite", {
    origin: OWNER_ORIGIN, viaNativeChat: true, by: "cesar",
  });
  a.emit(0, { type: "tool_use", id: "t1", name: "Bash", input: { command: "git commit -m 'feat(mcp): MCP events adapter'" } });
  a.emit(0, { type: "tool_result", id: "t1", toolResult: { lines: 4 } });
  await settle();
  return { a, cardId: card.id };
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "vibehub-deploy-agent-turn-"));
});
afterEach(async () => {
  const manager = await import("./manager.js");
  manager.resetSdkSessionsForTesting();
  manager.setDriverSpawnerForTesting(null);
  vi.doUnmock("../board/workspace.js");
  vi.doUnmock("../board/outbox.js");
  await rm(dir, { recursive: true, force: true });
});

describe("deploy no meio de uma ordem do maestro (card a28ffa23)", () => {
  it("a ordem que entra pelo maestro é durável: o turno em voo tem marcador", async () => {
    const { a, cardId } = await oldProcessRunsAMaestroOrder();
    const marker = await a.inflight.readInflightMarker(cardId);
    expect(marker).toMatchObject({ attempts: 0, preview: "implemente o adaptador MCP Events e commite" });
    expect((await a.registry.getCard(cardId))?.status).toBe("working");

    // The turn closes normally: the marker goes away, like any turn's.
    a.emit(0, { type: "result", isError: false });
    await settle();
    expect(await a.inflight.readInflightMarker(cardId)).toBeNull();
  });

  it("o processo novo retoma o turno que o deploy matou — uma vez, com a continuação de sistema", async () => {
    const { cardId } = await oldProcessRunsAMaestroOrder();
    const b = await bootProcess();
    const summary = await sweep(b, { sdkDriver: true, sdkAutoResume: true });
    expect(summary.resumed).toEqual([cardId]);
    const frames = b.children[0]!.written.map((s) => JSON.parse(s) as { type: string; text?: string });
    expect(frames.filter((f) => f.type === "user")).toHaveLength(1);
    expect(frames[0]!.text).toContain("Continue de onde parou");
    await settle();
    expect((await b.registry.getCard(cardId))?.status).toBe("working");

    // The resume works and closes: the marker goes away and the dot clears.
    b.emit(0, { type: "tool_use", id: "t2", name: "Bash", input: { command: "git status" } });
    b.emit(0, { type: "result", isError: false });
    await settle();
    expect(await b.inflight.readInflightMarker(cardId)).toBeNull();
    expect((await b.registry.getCard(cardId))?.status).toBe("waiting");

    // The next deploy (another process) has nothing to resume: nothing is injected again.
    const c = await bootProcess();
    expect(await sweep(c, { sdkDriver: true, sdkAutoResume: true })).toEqual({ resumed: [], noted: [] });
    expect(c.children).toHaveLength(0);
  });

  it("card pausado depois da queda não é revivido, e a bolinha não reacende", async () => {
    const { a, cardId } = await oldProcessRunsAMaestroOrder();
    await a.registry.pauseCard(cardId, { effective: true });
    const b = await bootProcess();
    expect(await sweep(b, { sdkDriver: true, sdkAutoResume: true })).toEqual({ resumed: [], noted: [] });
    expect(b.children).toHaveLength(0);
    await settle();
    const card = await b.registry.getCard(cardId);
    expect(card?.status ?? null).toBeNull(); // the pause cleared the dot along with the session
    expect(card?.pausedAt).toBeTruthy();
    expect(await b.inflight.readInflightMarker(cardId)).toBeNull();
  });

  it("card hibernado com marcador órfão continua hibernado (nenhum relato o dá por vivo)", async () => {
    const { a, cardId } = await oldProcessRunsAMaestroOrder();
    a.emit(0, { type: "result", isError: false }); // idle: only then does the idle sweep hibernate
    await settle();
    await a.inflight.writeInflightMarker(cardId, { startedAt: Date.now(), preview: "turno morto", attempts: 0 });
    expect(await a.registry.hibernateCard(cardId)).toBeTruthy();
    const b = await bootProcess();
    expect(await sweep(b, { sdkDriver: true, sdkAutoResume: true })).toEqual({ resumed: [], noted: [] });
    await settle();
    const card = await b.registry.getCard(cardId);
    expect(card?.hibernatedAt).toBeTruthy();
    expect(card?.status ?? null).toBeNull(); // no report: the hibernation cleared the dot along with the session
  });

  it("sem retomada (auto-resume desligado), a bolinha não fica 'working' do processo morto", async () => {
    const { cardId } = await oldProcessRunsAMaestroOrder();
    const b = await bootProcess();
    const summary = await sweep(b, { sdkDriver: true, sdkAutoResume: false });
    expect(summary.noted).toEqual([cardId]);
    await settle();
    expect((await b.registry.getCard(cardId))?.status).toBe("waiting");
    expect(await b.inflight.readInflightMarker(cardId)).toBeNull();
  });

  it("guarda de loop: a retomada que morre sem avançar não é retomada de novo, e o card não fica 'working'", async () => {
    const { cardId } = await oldProcessRunsAMaestroOrder();
    const b = await bootProcess();
    expect((await sweep(b, { sdkDriver: true, sdkAutoResume: true })).resumed).toEqual([cardId]);
    await settle();
    // B dies too, before the agent produces anything (the marker says attempts 1, no progress).
    const c = await bootProcess();
    const summary = await sweep(c, { sdkDriver: true, sdkAutoResume: true });
    expect(summary).toEqual({ resumed: [], noted: [cardId] });
    expect(c.children).toHaveLength(0);
    await settle();
    expect((await c.registry.getCard(cardId))?.status).toBe("waiting");
  });
});

/**
 * THE DEPLOY WITH THE QUESTION CARD UP (production, 2026-11-03): the person was ticking the options of
 * four questions when the panel updated. The resume closed the card and the agent asked
 * again, blank. Now the new process leaves the card open and the click reaches the model.
 */
describe("deploy com o agente esperando resposta num cartão", () => {
  const QUESTIONS = [
    { question: "Como marcamos o trucado?", header: "Trucado", options: [{ label: "Tipo no cadastro" }, { label: "Faixa de capacidade" }] },
    { question: "Produto sem peso?", header: "Sem peso", options: [{ label: "Bloqueia o envio" }, { label: "Avisa e deixa seguir" }] },
  ];

  it("o processo novo não retoma: o cartão segue aberto, a bolinha aguarda, e o clique vai ao modelo", async () => {
    const { a, cardId } = await oldProcessRunsAMaestroOrder();
    a.emit(0, { type: "user_question", id: "q_1_1793740462180", questions: QUESTIONS });
    await settle();

    const b = await bootProcess();
    const summary = await sweep(b, { sdkDriver: true, sdkAutoResume: true });
    expect(summary).toEqual({ resumed: [], noted: [cardId] });
    expect(b.children).toHaveLength(0); // no "Continue de onde parou", no question asked again
    await settle();
    const { readHistory } = await import("./history.js");
    const history = await readHistory(cardId);
    expect(history.some((e) => e.type === "question_result")).toBe(false);
    expect((history.at(-1) as { text?: string }).text).toBe(b.resume.NOTE_AWAITING_ANSWER);
    expect((await b.registry.getCard(cardId))?.status).toBe("waiting");
    expect((await b.registry.getCard(cardId))?.awaitingDecisionAt).toBeTruthy(); // "precisa de você"

    // The person answers the SAME card: the new driver comes up and receives the choices as a message.
    const session = b.manager.ensureDriverSession({ cardId, label: "a28f", command: { file: "docker", args: ["exec"] } });
    const socket = Object.assign(new EventEmitter(), { readyState: 1, send: () => undefined, close: () => undefined });
    b.manager.attachSocket(session, socket as never, OWNER_ORIGIN);
    socket.emit("message", Buffer.from(JSON.stringify({
      type: "question_answer", id: "q_1_1793740462180",
      answers: [{ selected: ["Faixa de capacidade", "pela placa"] }, { selected: ["Bloqueia o envio"] }],
    })));
    await vi.waitFor(() => {
      const sent = b.children[0]!.written.map((w) => JSON.parse(w) as { type: string; text?: string });
      const answer = sent.find((f) => f.type === "user")?.text ?? "";
      expect(answer).toContain("Faixa de capacidade, pela placa");
      expect(answer).toContain("Bloqueia o envio");
    });
    // answered, the card clears the "precisa de você"
    await vi.waitFor(async () => expect((await b.registry.getCard(cardId))?.awaitingDecisionAt ?? null).toBeNull());
  });
});
