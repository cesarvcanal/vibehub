import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * A RETOMADA E O AVISO DE "TURNO TERMINOU" (services/events/cardEvents.ts, #182). No CLI real a
 * retomada fecha primeiro um turno vazio — o da notificação de que a tarefa de fundo morreu — e só
 * segundos depois roda a continuação (E2E, 2026-10-20). Esse `result` vazio e o `Stop` do CLI que vem
 * com ele não podem chegar a quem está longe do quadro como "o card terminou": o aviso sairia no meio
 * da retomada, e a pessoa voltaria a um card ainda trabalhando. Registry, status e log de eventos
 * REAIS contra uma pasta temporária; só o processo do driver é falso.
 */

let dir = "";

function fakeChild() {
  const child = new EventEmitter() as EventEmitter & Record<string, unknown>;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  const stdin = new EventEmitter() as EventEmitter & Record<string, unknown>;
  stdin.writable = true;
  stdin.write = () => true;
  stdin.end = () => { stdin.writable = false; };
  child.stdin = stdin;
  child.exitCode = null;
  child.kill = () => {};
  return child;
}

async function load() {
  vi.resetModules();
  const env = await import("../../config/env.js");
  env.config.dataDir = dir;
  vi.doMock("../board/workspace.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../board/workspace.js")>()),
    killCardSession: vi.fn(async () => undefined),
    restartCard: vi.fn(async () => undefined),
  }));
  vi.doMock("../board/outbox.js", () => ({ flushCard: vi.fn(async () => undefined) }));
  const registry = await import("../board/registry.js");
  const users = await import("../../auth/users.js");
  const events = await import("../events/cardEvents.js");
  const { reportCardStatus } = await import("../board/status.js");
  const manager = await import("./manager.js");
  const children: Array<ReturnType<typeof fakeChild>> = [];
  manager.setDriverSpawnerForTesting(() => {
    const child = fakeChild();
    children.push(child);
    return child as never;
  });
  const owner = users.publicUser(await users.createUser("cesar", "senha-forte-123", "owner"));
  const project = await registry.createProject({ name: "vibehub" });
  const card = await registry.createCard({ projectId: project.id, title: "retomada" });
  await registry.applyOpenTerminal(card.id);
  const session = manager.ensureDriverSession({ cardId: card.id, label: "t", command: { file: "docker", args: ["exec"] } });
  const emit = (event: object) => (children[0]!.stdout as EventEmitter).emit("data", Buffer.from(JSON.stringify(event) + "\n"));
  const kinds = async () => (await events.inboxFor(owner)).events.map((e) => e.kind);
  return { manager, registry, reportCardStatus, card, session, emit, kinds };
}

/** Deixa as gravações fire-and-forget (bolinha, eventos) assentarem. */
const settle = () => new Promise((r) => setTimeout(r, 60));

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "vibehub-resume-events-"));
});
afterEach(async () => {
  vi.useRealTimers();
  const manager = await import("./manager.js");
  manager.resetSdkSessionsForTesting();
  manager.setDriverSpawnerForTesting(null);
  vi.doUnmock("../board/workspace.js");
  vi.doUnmock("../board/outbox.js");
  await rm(dir, { recursive: true, force: true });
});

describe("retomada × aviso de turno terminado", () => {
  it("o result vazio do arranque e o Stop do CLI não viram 'turno terminou'; o fim real vira UM", async () => {
    const env = await load();
    env.manager.injectSystemTurn(env.session, "continue", env.manager.SYSTEM_ORIGIN, 1);
    await settle();
    env.emit({ type: "result", isError: false }); // o turno vazio da notificação
    await env.reportCardStatus(env.card.id, "waiting"); // o hook Stop que vem com ele
    await settle();
    expect((await env.registry.getCard(env.card.id))?.status).toBe("working");
    expect(await env.kinds()).toEqual([]);

    env.emit({ type: "tool_use", id: "t1", name: "Bash", input: {} }); // a continuação pegou
    env.emit({ type: "result", isError: false });
    await env.reportCardStatus(env.card.id, "waiting");
    await vi.waitFor(async () => expect(await env.kinds()).toEqual(["turn_finished"]));
  });

  it("a retomada que não pegou nem com o reenvio: aí sim o card para — e o aviso sai uma vez", async () => {
    const env = await load();
    env.manager.injectSystemTurn(env.session, "continue", env.manager.SYSTEM_ORIGIN, 1);
    await settle(); // o `working` da retomada assenta antes (em produção, 90 s antes da desistência)
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    for (let i = 0; i < 2; i++) {
      env.emit({ type: "result", isError: false });
      vi.advanceTimersByTime(env.manager.RESUME_CONFIRM_MS + 1);
    }
    vi.useRealTimers();
    await vi.waitFor(async () => {
      expect((await env.registry.getCard(env.card.id))?.status).toBe("waiting");
      expect(await env.kinds()).toEqual(["turn_finished"]);
    });
  });
});
