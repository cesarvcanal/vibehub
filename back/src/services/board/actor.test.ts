import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * WHO a card's commits belong to. The rule under test is the one the four routes share: touching a
 * card you may WORK makes you its author; touching one you may only VIEW must not.
 *
 * The registry is REAL (temp data dir). The runner is not: `reapplyCardIdentity` is the only thing
 * that would reach docker, and what matters here is WHETHER it is called — once per real switch,
 * never for the same person twice.
 */

let dir = "";
const reapply = vi.fn(async () => undefined);

async function load() {
  vi.resetModules();
  const env = await import("../../config/env.js");
  env.config.dataDir = dir;
  vi.doMock("./workspace.js", () => ({ reapplyCardIdentity: reapply }));
  const registry = await import("./registry.js");
  registry.resetForTesting();
  const { recordCardActor } = await import("./actor.js");
  return { registry, recordCardActor };
}

const owner = { id: "u-cesar", username: "cesar", role: "owner" as const, createdAt: "" };
const mussa = { id: "u-mussa", username: "mussa", role: "member" as const, createdAt: "" };
const viewer = { id: "u-view", username: "espectador", role: "member" as const, createdAt: "" };

beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "vibehub-actor-")); reapply.mockClear(); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); vi.doUnmock("./workspace.js"); });

async function seed(registry: Awaited<ReturnType<typeof load>>["registry"]) {
  const project = await registry.createProject({ name: "widgets" });
  const card = await registry.createCard({ projectId: project.id, title: "um card" });
  return card;
}

describe("o ator do card decide a identidade do commit", () => {
  it("quem só PODE VER não vira autor; quem trabalha, vira", async () => {
    const { registry, recordCardActor } = await load();
    const card = await seed(registry);

    await registry.shareWith({ kind: "card", targetId: card.id, userId: viewer.id, level: "view" });
    await recordCardActor(viewer, card.id);
    expect((await registry.getCard(card.id))?.actorUserId).toBeUndefined();
    expect(reapply).not.toHaveBeenCalled();

    await registry.shareWith({ kind: "card", targetId: card.id, userId: mussa.id, level: "work" });
    await recordCardActor(mussa, card.id);
    expect((await registry.getCard(card.id))?.actorUserId).toBe(mussa.id);
  });

  it("o César retoma a autoria quando volta a trabalhar no card do Mussa", async () => {
    const { registry, recordCardActor } = await load();
    const card = await seed(registry);

    await registry.shareWith({ kind: "card", targetId: card.id, userId: mussa.id, level: "work" });
    await recordCardActor(mussa, card.id);
    expect((await registry.getCard(card.id))?.actorUserId).toBe(mussa.id);

    await recordCardActor(owner, card.id);
    expect((await registry.getCard(card.id))?.actorUserId).toBe(owner.id);
  });

  it("reaplica no runner UMA vez por troca real, não a cada toque", async () => {
    const { registry, recordCardActor } = await load();
    const card = await seed(registry);

    await recordCardActor(owner, card.id);
    const afterFirst = reapply.mock.calls.length;
    await recordCardActor(owner, card.id);
    await recordCardActor(owner, card.id);
    // Mesmo ator: nada de docker exec por prompt.
    expect(reapply.mock.calls.length).toBe(afterFirst);

    await registry.shareWith({ kind: "card", targetId: card.id, userId: mussa.id, level: "work" });
    await recordCardActor(mussa, card.id);
    expect(reapply.mock.calls.length).toBe(afterFirst + 1);
  });

  it("sessão sem usuário não estampa nada", async () => {
    const { registry, recordCardActor } = await load();
    const card = await seed(registry);
    await recordCardActor(null, card.id);
    expect((await registry.getCard(card.id))?.actorUserId).toBeUndefined();
  });
});
