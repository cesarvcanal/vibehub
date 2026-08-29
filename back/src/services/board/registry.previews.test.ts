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
    const card = await reg.registerCardPreview(id, 5173, "front");
    expect(card?.previews).toEqual([{ port: 5173, label: "front", createdAt: expect.any(Number) }]);
  });

  it("dedupes by port: re-registering refreshes the label instead of stacking", async () => {
    const reg = await freshRegistry();
    const id = await withCard(reg);
    await reg.registerCardPreview(id, 5173, "front");
    await reg.registerCardPreview(id, 3000, "api");
    const card = await reg.registerCardPreview(id, 5173, "vite");
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

describe("pruneCardPreviews", () => {
  it("drops previews whose port is not listening; keeps the live ones", async () => {
    const reg = await freshRegistry();
    const id = await withCard(reg);
    await reg.registerCardPreview(id, 5173, "front");
    await reg.registerCardPreview(id, 3000, "api");
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
