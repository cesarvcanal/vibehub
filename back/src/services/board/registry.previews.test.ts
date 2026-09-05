import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertPreviewPort,
  normalizePreviewLabel,
  PREVIEW_LABEL_MAX,
} from "./registry.js";

/**
 * REGISTERED PREVIEWS on a card — what `vibehub_preview` writes and the chip/menu read:
 * registration deduped by port, label normalization, and the prune that drops previews whose port
 * stopped listening. Same freshRegistry pattern as registry.test.ts.
 */

let dir = "";

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "vibehub-previews-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function freshRegistry() {
  vi.resetModules();
  const env = await import("../../config/env.js");
  env.config.dataDir = dir;
  return await import("./registry.js");
}

type Registry = Awaited<ReturnType<typeof freshRegistry>>;

async function withCard(reg: Registry): Promise<string> {
  const project = await reg.createProject({ name: "Shop" });
  const card = await reg.createCard({ projectId: project.id, title: "Checkout" });
  return card.id;
}

describe("preview validation (pure)", () => {
  it("assertPreviewPort: accepts 1-65535, rejects everything else", () => {
    expect(assertPreviewPort(1)).toBe(1);
    expect(assertPreviewPort(5173)).toBe(5173);
    expect(assertPreviewPort(65535)).toBe(65535);
    for (const bad of [0, -1, 65536, 1.5, NaN, Infinity]) {
      expect(() => assertPreviewPort(bad)).toThrow(/invalid preview port/);
    }
  });

  it("normalizePreviewLabel: one trimmed line, capped, empty -> undefined", () => {
    expect(normalizePreviewLabel("  front \n dev  ")).toBe("front dev");
    expect(normalizePreviewLabel("")).toBeUndefined();
    expect(normalizePreviewLabel(null)).toBeUndefined();
    expect(normalizePreviewLabel("x".repeat(200))).toHaveLength(PREVIEW_LABEL_MAX);
  });
});

describe("registerCardPreview", () => {
  it("records port + label + stamp on the card", async () => {
    const reg = await freshRegistry();
    const id = await withCard(reg);
    const card = await reg.registerCardPreview(id, 5173, { label: "front" });
    expect(card?.previews).toEqual([{ port: 5173, label: "front", createdAt: expect.any(Number) }]);
  });

  it("dedupes by port: re-registering refreshes the label instead of stacking", async () => {
    const reg = await freshRegistry();
    const id = await withCard(reg);
    await reg.registerCardPreview(id, 5173, { label: "front" });
    await reg.registerCardPreview(id, 3000, { label: "api" });
    const card = await reg.registerCardPreview(id, 5173, { label: "vite" });
    expect(card?.previews?.map((p) => [p.port, p.label])).toEqual([
      [3000, "api"],
      [5173, "vite"],
    ]);
  });

  it("no label -> no label field; unknown card -> undefined; bad port throws before writing", async () => {
    const reg = await freshRegistry();
    const id = await withCard(reg);
    const card = await reg.registerCardPreview(id, 8080);
    expect(card?.previews?.[0]).toEqual({ port: 8080, createdAt: expect.any(Number) });
    expect(await reg.registerCardPreview("nope", 8080)).toBeUndefined();
    await expect(reg.registerCardPreview(id, 0)).rejects.toThrow(/invalid preview port/);
  });
});

describe("registerCardPreview — relaunch recipe (command/cwd)", () => {
  it("stores command and cwd; a re-announce WITHOUT them keeps the stored recipe", async () => {
    const reg = await freshRegistry();
    const id = await withCard(reg);
    await reg.registerCardPreview(id, 5173, { label: "front", command: "npm run dev", cwd: "/work/app" });
    const card = await reg.registerCardPreview(id, 5173, { label: "vite" });
    expect(card?.previews?.[0]).toEqual({
      port: 5173, label: "vite", command: "npm run dev", cwd: "/work/app", createdAt: expect.any(Number),
    });
  });

  it("normalizePreviewCommand: single trimmed line, capped hard, empty -> undefined", async () => {
    const reg = await freshRegistry();
    expect(reg.normalizePreviewCommand("  npm run dev  ")).toBe("npm run dev");
    expect(reg.normalizePreviewCommand("")).toBeUndefined();
    expect(() => reg.normalizePreviewCommand("a\nb")).toThrow(/single line/);
    expect(() => reg.normalizePreviewCommand("x".repeat(500))).toThrow(/longer than/);
  });

  it("normalizePreviewCwd: absolute plain path or nothing", async () => {
    const reg = await freshRegistry();
    expect(reg.normalizePreviewCwd("/work/app")).toBe("/work/app");
    expect(reg.normalizePreviewCwd("")).toBeUndefined();
    for (const bad of ["relative", "/a/../b", "/a b", "/a;rm"]) {
      expect(() => reg.normalizePreviewCwd(bad)).toThrow(/invalid preview cwd/);
    }
  });
});

describe("removeCardPreview", () => {
  it("removes one preview and returns it; removing again (or from nowhere) -> undefined", async () => {
    const reg = await freshRegistry();
    const id = await withCard(reg);
    await reg.registerCardPreview(id, 5173, { label: "front" });
    await reg.registerCardPreview(id, 3000, { label: "api" });
    const gone = await reg.removeCardPreview(id, 5173);
    expect(gone?.port).toBe(5173);
    expect((await reg.getCard(id))?.previews?.map((p) => p.port)).toEqual([3000]);
    expect(await reg.removeCardPreview(id, 5173)).toBeUndefined();
    expect(await reg.removeCardPreview("nope", 3000)).toBeUndefined();
  });
});

describe("pruneCardPreviews", () => {
  it("SPARES a dead preview that has a stored command — it renders as 'parado', not as gone", async () => {
    const reg = await freshRegistry();
    const id = await withCard(reg);
    await reg.registerCardPreview(id, 5173, { command: "npm run dev", cwd: "/work/app" });
    await reg.registerCardPreview(id, 3000);
    expect(await reg.pruneCardPreviews([])).toBe(1);
    expect((await reg.getCard(id))?.previews?.map((p) => p.port)).toEqual([5173]);
  });

  it("drops previews whose port is not listening; keeps the live ones", async () => {
    const reg = await freshRegistry();
    const id = await withCard(reg);
    await reg.registerCardPreview(id, 5173, { label: "front" });
    await reg.registerCardPreview(id, 3000, { label: "api" });
    const pruned = await reg.pruneCardPreviews([5173, 9999]);
    expect(pruned).toBe(1);
    const card = await reg.getCard(id);
    expect(card?.previews?.map((p) => p.port)).toEqual([5173]);
  });

  it("clears the field entirely when every preview died; cards with none are untouched", async () => {
    const reg = await freshRegistry();
    const id = await withCard(reg);
    await reg.registerCardPreview(id, 5173);
    expect(await reg.pruneCardPreviews([])).toBe(1);
    const card = await reg.getCard(id);
    expect(card?.previews).toBeUndefined();
    // idempotent: nothing left to prune
    expect(await reg.pruneCardPreviews([])).toBe(0);
  });
});

describe("findCardPreviewByPort", () => {
  it("finds the card that registered the port, with its preview", async () => {
    const reg = await freshRegistry();
    const cardId = await withCard(reg);
    await reg.registerCardPreview(cardId, 3100, { label: "front", command: "npm run dev", cwd: "/work/app" });

    const found = await reg.findCardPreviewByPort(3100);
    expect(found?.card.id).toBe(cardId);
    expect(found?.preview).toMatchObject({ port: 3100, label: "front", command: "npm run dev" });
    expect(await reg.findCardPreviewByPort(3101)).toBeUndefined();
  });

  it("prefers the NEWEST registration when two cards claimed the same port", async () => {
    const reg = await freshRegistry();
    const older = await withCard(reg);
    const newer = await withCard(reg);
    await reg.registerCardPreview(older, 3100, {});
    await new Promise((r) => setTimeout(r, 5)); // createdAt is a Date.now() stamp
    await reg.registerCardPreview(newer, 3100, {});

    expect((await reg.findCardPreviewByPort(3100))?.card.id).toBe(newer);
  });

  it("validates the port instead of scanning with garbage", async () => {
    const reg = await freshRegistry();
    await expect(reg.findCardPreviewByPort(0)).rejects.toThrow(/invalid preview port/);
  });
});
