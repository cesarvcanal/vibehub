import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * BROWSER SLOTS — every card gets its own display, VNC port and CDP port, and two cards NEVER share
 * them. The slot used to be derived from the id alone (`hex6 % 900`), which collides about one time
 * in five on a board with twenty cards: card B's agent then drove card A's logged-in Chromium
 * through PW_CDP_ENDPOINT, and deleting B killed A's browser. The slot is now ALLOCATED by the
 * registry (first free one, the hashed one preferred so a running browser keeps its display) and
 * stored on the card.
 *
 * `randomUUID` is mocked so the test can mint ids that collide under the old derivation on purpose:
 * 0x000000 and 0x000384 (= 900) both land on slot 0.
 */

const uuids: string[] = [];
vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return { ...actual, randomUUID: () => uuids.shift() ?? actual.randomUUID() };
});

const A = "00000000-1111-4111-8111-111111111111";
const B = "00038400-2222-4222-8222-222222222222"; // 0x000384 % 900 === 0x000000 % 900

let dir = "";

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "vibehub-slots-"));
  uuids.length = 0;
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function fresh() {
  vi.resetModules();
  const env = await import("../../config/env.js");
  env.config.dataDir = dir;
  const registry = await import("./registry.js");
  const ports = await import("../browser/ports.js");
  return { registry, ports };
}

describe("browser slot allocation", () => {
  it("hands two cards whose ids collide under the old hash DIFFERENT displays and ports", async () => {
    const { registry, ports } = await fresh();
    expect(ports.cardBrowserSlot(A)).toBe(ports.cardBrowserSlot(B)); // the fixture really collides
    const project = await registry.createProject({ name: "Shop" });
    uuids.push(A, B);
    const a = await registry.createCard({ projectId: project.id, title: "One" });
    const b = await registry.createCard({ projectId: project.id, title: "Two" });
    expect([a.id, b.id]).toEqual([A, B]);
    expect(a.browserSlot).not.toBe(b.browserSlot);
    const pa = ports.cardBrowserPorts(A);
    const pb = ports.cardBrowserPorts(B);
    expect(pa.display).not.toBe(pb.display);
    expect(pa.vncPort).not.toBe(pb.vncPort);
    expect(pa.cdpPort).not.toBe(pb.cdpPort);
    expect(ports.cardCdpEndpoint(A)).not.toBe(ports.cardCdpEndpoint(B));
  });

  it("keeps the hashed slot when it is free, so a browser already running keeps its display", async () => {
    const { registry, ports } = await fresh();
    const project = await registry.createProject({ name: "Shop" });
    uuids.push(A);
    const a = await registry.createCard({ projectId: project.id, title: "One" });
    expect(a.browserSlot).toBe(ports.cardBrowserSlot(A));
  });

  it("persists the slot: a restart resolves the same ports", async () => {
    let first = await fresh();
    const project = await first.registry.createProject({ name: "Shop" });
    uuids.push(A, B);
    await first.registry.createCard({ projectId: project.id, title: "One" });
    await first.registry.createCard({ projectId: project.id, title: "Two" });
    const before = first.ports.cardBrowserPorts(B);
    const onDisk = JSON.parse(await readFile(join(dir, "board.json"), "utf8")) as { cards: { browserSlot?: number }[] };
    expect(onDisk.cards.every((c) => Number.isInteger(c.browserSlot))).toBe(true);

    first = await fresh();
    await first.registry.listAllCards();
    expect(first.ports.cardBrowserPorts(B)).toEqual(before);
  });

  it("gives LEGACY cards (no slot on disk) distinct slots on load — the first one keeps its hashed slot", async () => {
    const legacy = (id: string, title: string) => ({
      id, projectId: "p1", title, column: "backlog", position: 0, base: "dev",
      tmuxSession: `card-${id.slice(0, 8)}`, worktreeSlug: `${title}-${id.slice(0, 4)}`, status: null,
      createdAt: 1, updatedAt: 1,
    });
    await writeFile(
      join(dir, "board.json"),
      JSON.stringify({
        config: {}, accounts: [], mcps: [], githubConnections: [], shares: [],
        projects: [{ id: "p1", name: "Shop", baseBranch: "dev", createdAt: 1 }],
        cards: [legacy(A, "one"), legacy(B, "two")],
      }),
    );
    const { registry, ports } = await fresh();
    const [a, b] = await Promise.all([registry.getCard(A), registry.getCard(B)]);
    expect(a?.browserSlot).toBe(ports.cardBrowserSlot(A));
    expect(b?.browserSlot).toBeDefined();
    expect(b?.browserSlot).not.toBe(a?.browserSlot);
    expect(ports.cardBrowserPorts(A).display).not.toBe(ports.cardBrowserPorts(B).display);
  });

  it("a colliding LEGACY card never takes the hashed slot of a legacy card loaded after it", async () => {
    // A and B both hash to slot 0; C hashes to slot 1 — the lowest free one once A holds 0. C's
    // Chromium is ALREADY running on slot 1 (it was opened under the old derivation): handing slot 1
    // to B just because B came first in the file would point B's agent at C's logged-in browser.
    const C = "00000100-3333-4333-8333-333333333333";
    const legacy = (id: string, title: string) => ({
      id, projectId: "p1", title, column: "backlog", position: 0, base: "dev",
      tmuxSession: `card-${id.slice(0, 8)}`, worktreeSlug: `${title}-${id.slice(0, 4)}`, status: null,
      createdAt: 1, updatedAt: 1,
    });
    await writeFile(
      join(dir, "board.json"),
      JSON.stringify({
        config: {}, accounts: [], mcps: [], githubConnections: [], shares: [],
        projects: [{ id: "p1", name: "Shop", baseBranch: "dev", createdAt: 1 }],
        cards: [legacy(A, "one"), legacy(B, "two"), legacy(C, "three")],
      }),
    );
    const { registry, ports } = await fresh();
    expect(ports.cardBrowserSlot(C)).toBe(1); // the fixture really sits on the lowest free slot
    const [a, b, c] = await Promise.all([registry.getCard(A), registry.getCard(B), registry.getCard(C)]);
    expect(a?.browserSlot).toBe(0);
    expect(c?.browserSlot).toBe(1);
    expect(b?.browserSlot).toBe(2);
  });

  it("a removed card's ports still resolve (the project purge stops its browser AFTER it left the board)", async () => {
    const { registry, ports } = await fresh();
    const project = await registry.createProject({ name: "Shop" });
    uuids.push(A, B);
    await registry.createCard({ projectId: project.id, title: "One" });
    await registry.createCard({ projectId: project.id, title: "Two" });
    const before = ports.cardBrowserPorts(B);
    await registry.removeProject(project.id);
    expect(ports.cardBrowserPorts(B)).toEqual(before);
  });
});
