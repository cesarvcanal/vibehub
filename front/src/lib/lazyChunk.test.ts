import { describe, expect, it, vi } from "vitest";
import { ChunkLoadFailure, chunkUrlOf, importChunk, isChunkLoadError, waitForServer } from "@/lib/lazyChunk";

/**
 * A lazy chunk (`import()`) that fails because the vibehub was restarting for a deploy at that very
 * moment. The browser CACHES that failure for the URL (checked on Chromium 153: the same URL keeps
 * failing after the file is back, a new URL loads), so "Try again" with the same import can never
 * work — only a page reload did. These tests pin the recovery: wait for the server, then load the
 * same chunk under a fresh URL; and when even that fails, say that the page needs a reload.
 */

const CHUNK = "https://vibehub.example.com/assets/rfb-6tS6afZT.js";
const chromeError = () => new TypeError(`Failed to fetch dynamically imported module: ${CHUNK}`);

describe("isChunkLoadError / chunkUrlOf", () => {
  it("recognises the chunk-load failure of each engine", () => {
    expect(isChunkLoadError(chromeError())).toBe(true);
    expect(isChunkLoadError(new TypeError("Importing a module script failed."))).toBe(true); // Safari
    expect(isChunkLoadError(new TypeError(`error loading dynamically imported module: ${CHUNK}`))).toBe(true); // Firefox
    expect(isChunkLoadError(new Error("RFB is not a constructor"))).toBe(false);
    expect(isChunkLoadError("nope")).toBe(false);
  });

  it("extracts the chunk URL when the engine names it", () => {
    expect(chunkUrlOf(chromeError())).toBe(CHUNK);
    expect(chunkUrlOf(new TypeError("Importing a module script failed."))).toBeNull();
  });
});

describe("importChunk", () => {
  const deps = (over: Partial<Parameters<typeof importChunk>[1]> = {}) => ({
    importUrl: vi.fn(async (url: string) => ({ default: `loaded ${url}` })),
    waitForServer: vi.fn(async () => true),
    onRecovering: vi.fn(),
    now: () => 42,
    ...over,
  });

  it("returns the module straight away when the first import works — no probing", async () => {
    const d = deps();
    await expect(importChunk(async () => ({ default: "first" }), d)).resolves.toEqual({ default: "first" });
    expect(d.waitForServer).not.toHaveBeenCalled();
    expect(d.importUrl).not.toHaveBeenCalled();
  });

  it("after a chunk failure: waits for the server, then loads the SAME chunk under a fresh URL", async () => {
    const d = deps();
    const mod = await importChunk(async () => { throw chromeError(); }, d);
    expect(d.onRecovering).toHaveBeenCalledOnce();
    expect(d.waitForServer).toHaveBeenCalledOnce();
    expect(d.importUrl).toHaveBeenCalledWith(`${CHUNK}?retry=42`);
    expect(mod).toEqual({ default: `loaded ${CHUNK}?retry=42` });
  });

  it("keeps an existing query string valid", async () => {
    const d = deps();
    const err = new TypeError(`Failed to fetch dynamically imported module: ${CHUNK}?v=1`);
    await importChunk(async () => { throw err; }, d);
    expect(d.importUrl).toHaveBeenCalledWith(`${CHUNK}?v=1&retry=42`);
  });

  it("rethrows anything that is not a chunk failure untouched", async () => {
    const d = deps();
    const boom = new Error("RFB is not a constructor");
    await expect(importChunk(async () => { throw boom; }, d)).rejects.toBe(boom);
    expect(d.waitForServer).not.toHaveBeenCalled();
  });

  it("server never came back → ChunkLoadFailure('server_down')", async () => {
    const d = deps({ waitForServer: vi.fn(async () => false) });
    const err = await importChunk(async () => { throw chromeError(); }, d).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ChunkLoadFailure);
    expect((err as ChunkLoadFailure).reason).toBe("server_down");
    expect(d.importUrl).not.toHaveBeenCalled();
  });

  it("the fresh URL fails too (the deploy renamed the chunk) → ChunkLoadFailure('stale'): only a reload helps", async () => {
    const d = deps({ importUrl: vi.fn(async () => { throw chromeError(); }) });
    const err = await importChunk(async () => { throw chromeError(); }, d).catch((e: unknown) => e);
    expect((err as ChunkLoadFailure).reason).toBe("stale");
  });

  it("an engine that does not name the URL (Safari) → 'stale' once the server is up", async () => {
    const d = deps();
    const err = await importChunk(async () => { throw new TypeError("Importing a module script failed."); }, d).catch((e: unknown) => e);
    expect((err as ChunkLoadFailure).reason).toBe("stale");
    expect(d.importUrl).not.toHaveBeenCalled();
  });
});

describe("waitForServer", () => {
  it("polls /api/health until it answers ok", async () => {
    const answers = [new Error("down"), { ok: false }, { ok: true }];
    const fetcher = vi.fn(async () => {
      const next = answers.shift()!;
      if (next instanceof Error) throw next;
      return next as Response;
    });
    const sleep = vi.fn(async () => undefined);
    await expect(waitForServer({ fetcher, sleep, budgetMs: 60_000, intervalMs: 2000, now: () => 0 })).resolves.toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(fetcher).toHaveBeenCalledWith("/api/health", { cache: "no-store" });
  });

  it("gives up after the budget", async () => {
    let clock = 0;
    const fetcher = vi.fn(async () => { throw new Error("down"); });
    const sleep = vi.fn(async (ms: number) => { clock += ms; });
    await expect(waitForServer({ fetcher, sleep, budgetMs: 10_000, intervalMs: 2000, now: () => clock })).resolves.toBe(false);
    expect(fetcher.mock.calls.length).toBeLessThanOrEqual(7);
  });
});
