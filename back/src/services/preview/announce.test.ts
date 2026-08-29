import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { previewPublicUrl, portNotListeningError, PREVIEW_BASE_HINT } from "./announce.js";
import { PROC_MARKER } from "./preview.js";

/**
 * `vibehub_preview`'s engine: the pure URL/error builders, and announcePreview end to end against
 * a fresh registry with the runner scan mocked (same module-reset pattern as the registry tests —
 * the scan itself is unit-tested in preview.test.ts).
 */

let dir = "";
const runScript = vi.fn();

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "vibehub-announce-"));
  runScript.mockReset();
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** /proc/net/tcp rows for the given LISTENING ports (state 0A, inode 1). */
function scanOutput(ports: number[]): string {
  const rows = ports.map(
    (p, i) =>
      `${i}: 0100007F:${p.toString(16).toUpperCase().padStart(4, "0")} 00000000:0000 0A 0:0 0:0 0 0 1 1`,
  );
  return `sl local rem st tq tr re uid to inode\n${rows.join("\n")}\n${PROC_MARKER}\n`;
}

async function boot() {
  vi.resetModules();
  const env = await import("../../config/env.js");
  env.config.dataDir = dir;
  env.config.publicUrl = "http://10.8.0.25:3010/";
  vi.doMock("../../runtime/host.js", async () => {
    const actual = await vi.importActual<typeof import("../../runtime/host.js")>("../../runtime/host.js");
    return { ...actual, hostExecutor: () => ({ kind: "local", label: "test", runScript }) };
  });
  const registry = await import("../board/registry.js");
  const announce = await import("./announce.js");
  const project = await registry.createProject({ name: "Shop" });
  const card = await registry.createCard({ projectId: project.id, title: "Checkout" });
  return { registry, announce, cardId: card.id };
}

describe("previewPublicUrl (pure)", () => {
  it("joins publicUrl and the proxy path, tolerating trailing slashes", () => {
    expect(previewPublicUrl("http://10.8.0.25:3010", 5173)).toBe("http://10.8.0.25:3010/preview/5173/");
    expect(previewPublicUrl("http://vibehub.multi/", 3000)).toBe("http://vibehub.multi/preview/3000/");
  });

  it("refuses a port that could not be proxied", () => {
    expect(() => previewPublicUrl("http://x", 0)).toThrow(/invalid preview port/);
  });
});

describe("portNotListeningError (pure)", () => {
  it("names what IS listening so the agent can act", () => {
    const err = portNotListeningError(5173, [{ port: 3000, address: "all", process: "node" }]);
    expect(err.message).toMatch(/nothing is listening on port 5173/);
    expect(err.message).toMatch(/3000 \(node\)/);
  });

  it("says when nothing at all is listening", () => {
    expect(portNotListeningError(5173, []).message).toMatch(/Nothing is listening at all/);
  });
});

describe("announcePreview", () => {
  it("verifies the port, registers the preview and returns the full clickable URL", async () => {
    const { registry, announce, cardId } = await boot();
    runScript.mockResolvedValue({ stdout: scanOutput([5173]), stderr: "", code: 0 });

    const out = await announce.announcePreview(cardId, 5173, { label: "  front  " });
    expect(out).toEqual({
      registered: true,
      cardId,
      port: 5173,
      label: "front",
      url: "http://10.8.0.25:3010/preview/5173/",
      hint: PREVIEW_BASE_HINT,
    });
    const card = await registry.getCard(cardId);
    expect(card?.previews).toEqual([{ port: 5173, label: "front", createdAt: expect.any(Number) }]);
  });

  it("stores the relaunch recipe: command as announced, cwd defaulting to the card's worktree", async () => {
    const { registry, announce, cardId } = await boot();
    runScript.mockResolvedValue({ stdout: scanOutput([5173]), stderr: "", code: 0 });

    await announce.announcePreview(cardId, 5173, { label: "front", command: "npm run dev -- --port 5173" });
    const preview = (await registry.getCard(cardId))?.previews?.[0];
    expect(preview?.command).toBe("npm run dev -- --port 5173");
    // A project with no repository puts the card in the scratch directory — that is its cwd.
    expect(preview?.cwd).toMatch(/^\/work\/scratch\//);

    // An explicit cwd wins; a malformed one is refused before anything is scanned or written.
    await announce.announcePreview(cardId, 5173, { command: "npm start", cwd: "/work/app" });
    expect((await registry.getCard(cardId))?.previews?.[0]?.cwd).toBe("/work/app");
    await expect(
      announce.announcePreview(cardId, 5173, { command: "npm start", cwd: "../etc" }),
    ).rejects.toThrow(/invalid preview cwd/);
    await expect(
      announce.announcePreview(cardId, 5173, { command: "a\nb" }),
    ).rejects.toThrow(/single line/);
  });

  it("refuses a silent port WITHOUT registering anything", async () => {
    const { registry, announce, cardId } = await boot();
    runScript.mockResolvedValue({ stdout: scanOutput([3000]), stderr: "", code: 0 });

    await expect(announce.announcePreview(cardId, 5173)).rejects.toThrow(/nothing is listening on port 5173/);
    expect((await registry.getCard(cardId))?.previews).toBeUndefined();
  });

  it("unknown card and invalid port fail with actionable errors (no scan for the bad port)", async () => {
    const { announce, cardId } = await boot();
    runScript.mockResolvedValue({ stdout: scanOutput([5173]), stderr: "", code: 0 });
    await expect(announce.announcePreview("nope", 5173)).rejects.toThrow(/VIBEHUB_CARD_ID/);
    await expect(announce.announcePreview(cardId, 70000)).rejects.toThrow(/invalid preview port/);
  });
});
