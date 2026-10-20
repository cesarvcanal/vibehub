import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * THE STATUS REPORT FEEDS THE CARD-EVENT LOG (services/events/cardEvents.ts): a turn that ends is
 * what a person away from the board hears as "the card finished"; a turn that starts clears it.
 * Real registry and log against a temp data dir; the session side (kill, restart, outbox) is mocked.
 */

let dir = "";

async function load() {
  vi.resetModules();
  const env = await import("../../config/env.js");
  env.config.dataDir = dir;
  vi.doMock("./workspace.js", () => ({ killCardSession: vi.fn(async () => undefined), restartCard: vi.fn(async () => undefined) }));
  vi.doMock("./outbox.js", () => ({ flushCard: vi.fn(async () => undefined) }));
  const registry = await import("./registry.js");
  const users = await import("../../auth/users.js");
  const events = await import("../events/cardEvents.js");
  const { reportCardStatus } = await import("./status.js");
  const owner = users.publicUser(await users.createUser("cesar", "senha-forte-123", "owner"));
  const project = await registry.createProject({ name: "erp" });
  const card = await registry.createCard({ projectId: project.id, title: "login" });
  await registry.applyOpenTerminal(card.id);
  return { registry, events, reportCardStatus, owner, card };
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "vibehub-status-events-"));
});
afterEach(async () => {
  vi.doUnmock("./workspace.js");
  vi.doUnmock("./outbox.js");
  await rm(dir, { recursive: true, force: true });
});

describe("reportCardStatus → card events", () => {
  it("working then waiting records one turn_finished", async () => {
    const env = await load();
    await env.reportCardStatus(env.card.id, "working");
    await env.reportCardStatus(env.card.id, "waiting");
    await env.reportCardStatus(env.card.id, "waiting"); // a repeated hook is not a second turn
    await vi.waitFor(async () => {
      const inbox = await env.events.inboxFor(env.owner);
      expect(inbox.events.map((e) => e.kind)).toEqual(["turn_finished"]);
      expect(inbox.events[0]).toMatchObject({ cardId: env.card.id, title: "login" });
    });
  });

  it("the next turn starting clears it", async () => {
    const env = await load();
    await env.reportCardStatus(env.card.id, "working");
    await env.reportCardStatus(env.card.id, "waiting");
    await vi.waitFor(async () => expect((await env.events.inboxFor(env.owner)).events).toHaveLength(1));
    await env.reportCardStatus(env.card.id, "working");
    await vi.waitFor(async () => expect((await env.events.inboxFor(env.owner)).events).toEqual([]));
  });
});
