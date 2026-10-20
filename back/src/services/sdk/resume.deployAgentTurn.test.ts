import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * O DEPLOY NO MEIO DE UMA ORDEM DO MAESTRO (produção, card a28ffa23, 2026-10-20 21:56 UTC). A ordem
 * veio pelo MCP externo (ChatGPT, em nome do César) → `sendToTerminal` → `sendAgentTurn`. O blue/green
 * do #181 matou o back antigo com o CLI esperando a resposta da API logo depois de um commit; o turno
 * não tinha marcador em voo, então o boot novo não tinha o que retomar, e o board ficou `working`
 * (gravado pelo processo morto) até alguém escrever. O "No response requested." que o agente leu
 * depois era o filler `<synthetic>` que o CLI insere ao retomar a sessão — não uma decisão do modelo.
 *
 * Dois processos do back, de verdade: módulos recarregados (outra identidade de dono, memória
 * zerada), registry, marcadores e histórico REAIS na mesma pasta de dados. Só o driver é falso.
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

/** Um processo do back: módulos novos sobre a mesma pasta de dados. */
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
  await import("../board/status.js"); // registra o sink da bolinha, como o boot real
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

/** O sweep de boot do processo novo com as peças reais; só o runner (install, comando) é falso. */
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
    appendNote: (cardId, text) => import("./history.js").then((h) => h.appendHistory(cardId, { type: "system_note", text, at: Date.now() })),
    readMarker: inflight.readInflightMarker,
    selfOwner: inflight.INFLIGHT_OWNER,
    ownerAlive: inflight.isInflightOwnerAlive,
    turnRunning: manager.driverTurnRunning,
    stopping: () => false,
    reportIdle: (cardId) => { void import("../board/agentState.js").then((a) => a.reportCardStatusFromDriver(cardId, "waiting")); },
    wait: async () => undefined,
  });
}

const settle = () => new Promise((r) => setTimeout(r, 60));
const OWNER_ORIGIN = { kind: "owner", name: "cesar" } as const;

/**
 * O processo ANTIGO: card aberto, driver vivo, a ordem do ChatGPT entra pelo maestro e o agente
 * começa a trabalhar (commit). Depois disso o processo "morre": nada mais dele roda, e o batimento
 * dele nunca foi tocado (o SIGKILL do blue/green não larga nada).
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

    // O turno fecha normalmente: o marcador sai, como o de qualquer turno.
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

    // A retomada trabalha e fecha: o marcador sai e a bolinha apaga.
    b.emit(0, { type: "tool_use", id: "t2", name: "Bash", input: { command: "git status" } });
    b.emit(0, { type: "result", isError: false });
    await settle();
    expect(await b.inflight.readInflightMarker(cardId)).toBeNull();
    expect((await b.registry.getCard(cardId))?.status).toBe("waiting");

    // O deploy seguinte (outro processo) não tem o que retomar: nada é injetado de novo.
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
    expect(card?.status ?? null).toBeNull(); // a pausa apagou a bolinha com a sessão
    expect(card?.pausedAt).toBeTruthy();
    expect(await b.inflight.readInflightMarker(cardId)).toBeNull();
  });

  it("card hibernado com marcador órfão continua hibernado (nenhum relato o dá por vivo)", async () => {
    const { a, cardId } = await oldProcessRunsAMaestroOrder();
    a.emit(0, { type: "result", isError: false }); // ocioso: só assim o sweep de ociosidade hiberna
    await settle();
    await a.inflight.writeInflightMarker(cardId, { startedAt: Date.now(), preview: "turno morto", attempts: 0 });
    expect(await a.registry.hibernateCard(cardId)).toBeTruthy();
    const b = await bootProcess();
    expect(await sweep(b, { sdkDriver: true, sdkAutoResume: true })).toEqual({ resumed: [], noted: [] });
    await settle();
    expect((await b.registry.getCard(cardId))?.hibernatedAt).toBeTruthy();
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
    // B morre também, antes de o agente produzir qualquer coisa (o marcador diz attempts 1, sem progresso).
    const c = await bootProcess();
    const summary = await sweep(c, { sdkDriver: true, sdkAutoResume: true });
    expect(summary).toEqual({ resumed: [], noted: [cardId] });
    expect(c.children).toHaveLength(0);
    await settle();
    expect((await c.registry.getCard(cardId))?.status).toBe("waiting");
  });
});
