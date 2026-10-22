import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * A `working` DOT THE HOOKS NEVER CLOSED (produção, 22/10/2026): the card's hooks posted to a
 * blue/green port the app no longer listened on, the Stop that ended the turn was lost, and the
 * board kept the loader on a Claude idle at its prompt for a day. The sweep asks the runner and
 * delivers the `waiting` the hook could not. Real registry against a temp data dir; the runner probe,
 * the session side and the outbox are mocked.
 */

let dir = "";
const probeSessions = vi.fn<(sessions: string[]) => Promise<Map<string, string>>>();
const restartCard = vi.fn(async () => undefined);

async function load() {
  vi.resetModules();
  const env = await import("../../config/env.js");
  env.config.dataDir = dir;
  vi.doMock("./workspace.js", () => ({ killCardSession: vi.fn(async () => undefined), restartCard, probeSessions }));
  vi.doMock("./outbox.js", () => ({ flushCard: vi.fn(async () => undefined) }));
  const registry = await import("./registry.js");
  const agentState = await import("./agentState.js");
  const status = await import("./status.js");
  const project = await registry.createProject({ name: "erp" });
  const card = await registry.createCard({ projectId: project.id, title: "agentes" });
  await registry.applyOpenTerminal(card.id);
  await status.reportCardStatus(card.id, "working");
  return { registry, agentState, status, card };
}

const LATER = 11 * 60_000;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "vibehub-status-reconcile-"));
  probeSessions.mockReset();
  restartCard.mockClear();
});
afterEach(async () => {
  vi.doUnmock("./workspace.js");
  vi.doUnmock("./outbox.js");
  await rm(dir, { recursive: true, force: true });
});

describe("reconcileStaleWorking", () => {
  it("a silent `working` whose terminal is idle turns `waiting`", async () => {
    const env = await load();
    probeSessions.mockResolvedValue(new Map([[env.card.tmuxSession, "idle"]]));
    expect(await env.status.reconcileStaleWorking(Date.now() + LATER)).toBe(1);
    const card = await env.registry.getCard(env.card.id);
    expect(card?.status).toBe("waiting");
    expect(card?.column).not.toBe("working");
  });

  it("a session that is gone also stops showing the loader", async () => {
    const env = await load();
    probeSessions.mockResolvedValue(new Map([[env.card.tmuxSession, "gone"]]));
    expect(await env.status.reconcileStaleWorking(Date.now() + LATER)).toBe(1);
    expect((await env.registry.getCard(env.card.id))?.status).toBe("waiting");
  });

  it("carries out the restart a deploy left pending — it waited for exactly this `waiting`", async () => {
    const env = await load();
    await env.registry.markRestartPending(env.card.id, "deploy");
    probeSessions.mockResolvedValue(new Map([[env.card.tmuxSession, "idle"]]));
    await env.status.reconcileStaleWorking(Date.now() + LATER);
    expect(restartCard).toHaveBeenCalledWith(env.card.id);
  });

  it("a terminal still generating keeps `working` (a long thought fires no hook)", async () => {
    const env = await load();
    probeSessions.mockResolvedValue(new Map([[env.card.tmuxSession, "busy"]]));
    expect(await env.status.reconcileStaleWorking(Date.now() + LATER)).toBe(0);
    expect((await env.registry.getCard(env.card.id))?.status).toBe("working");
  });

  it("a runner that does not answer changes nothing", async () => {
    const env = await load();
    probeSessions.mockResolvedValue(new Map());
    expect(await env.status.reconcileStaleWorking(Date.now() + LATER)).toBe(0);
    expect((await env.registry.getCard(env.card.id))?.status).toBe("working");
  });

  it("a recent hook is trusted: the runner is not even asked", async () => {
    const env = await load();
    expect(await env.status.reconcileStaleWorking(Date.now() + 60_000)).toBe(0);
    expect(probeSessions).not.toHaveBeenCalled();
  });

  it("the native chat's driver holding a turn or a background task keeps `working`", async () => {
    const env = await load();
    const off = env.agentState.onCardBackgroundProbe((id) => id === env.card.id);
    try {
      probeSessions.mockResolvedValue(new Map([[env.card.tmuxSession, "gone"]]));
      expect(await env.status.reconcileStaleWorking(Date.now() + LATER)).toBe(0);
      expect((await env.registry.getCard(env.card.id))?.status).toBe("working");
    } finally {
      off();
    }
  });
});
