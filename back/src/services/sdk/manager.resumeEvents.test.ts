import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * THE RESUME AND THE "TURNO TERMINOU" NOTICE (services/events/cardEvents.ts, #182). In the real CLI
 * the resume first closes an empty turn — the one for the notification that the background task
 * died — and only seconds later runs the continuation (E2E, 2026-10-20). That empty `result` and the
 * CLI's `Stop` that comes with it must not reach whoever is away from the board as "o card terminou":
 * the notice would go out in the middle of the resume, and the person would come back to a card still
 * working. REAL registry, status and event log against a temporary folder; only the driver process is fake.
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

/** Lets the fire-and-forget writes (dot, events) settle. */
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
    env.emit({ type: "result", isError: false }); // the notification's empty turn
    await env.reportCardStatus(env.card.id, "waiting"); // the Stop hook that comes with it
    await settle();
    expect((await env.registry.getCard(env.card.id))?.status).toBe("working");
    expect(await env.kinds()).toEqual([]);

    env.emit({ type: "tool_use", id: "t1", name: "Bash", input: {} }); // the continuation took
    env.emit({ type: "result", isError: false });
    await env.reportCardStatus(env.card.id, "waiting");
    await vi.waitFor(async () => expect(await env.kinds()).toEqual(["turn_finished"]));
  });

  it("a retomada que não pegou nem com o reenvio: aí sim o card para — e o aviso sai uma vez", async () => {
    const env = await load();
    env.manager.injectSystemTurn(env.session, "continue", env.manager.SYSTEM_ORIGIN, 1);
    await settle(); // the resume's `working` settles first (in production, 90 s before giving up)
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
