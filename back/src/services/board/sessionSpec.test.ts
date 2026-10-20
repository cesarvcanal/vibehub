import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const restartStaggered = vi.fn(async () => ({ restarted: 2, pending: 1 }));
let dir = "";

async function load() {
  vi.resetModules();
  const env = await import("../../config/env.js");
  env.config.dataDir = dir;
  vi.doMock("./workspace.js", async () => {
    const actual = await vi.importActual<typeof import("./workspace.js")>("./workspace.js");
    return { ...actual, restartStaggered };
  });
  return await import("./sessionSpec.js");
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "vibehub-spec-"));
  restartStaggered.mockClear();
  restartStaggered.mockResolvedValue({ restarted: 2, pending: 1 });
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe("sessionSpecFingerprint", () => {
  it("is stable, and carries what a session is born with (the test-worker cap among it)", async () => {
    const spec = await load();
    expect(spec.sessionSpecFingerprint()).toBe(spec.sessionSpecFingerprint());
    expect(spec.sessionSpecFingerprint()).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes when the session environment changes", async () => {
    const before = (await load()).sessionSpecFingerprint();
    vi.doMock("../../runtime/testWorkers.js", async () => {
      const actual = await vi.importActual<typeof import("../../runtime/testWorkers.js")>("../../runtime/testWorkers.js");
      return { ...actual, testWorkerExports: () => "export VITEST_MAX_THREADS=3; ", testWorkerTmuxArgs: () => ["-e", "VITEST_MAX_THREADS=3"] };
    });
    const after = (await load()).sessionSpecFingerprint();
    vi.doUnmock("../../runtime/testWorkers.js");
    expect(after).not.toBe(before);
  });
});

describe("restartSessionsIfSpecChanged", () => {
  it("no recorded fingerprint (sessions from before this existed): staggered restart, then records it", async () => {
    const spec = await load();
    expect(await spec.restartSessionsIfSpecChanged()).toEqual({ changed: true, restarted: 2, pending: 1 });
    expect(restartStaggered).toHaveBeenCalledWith("deploy");
    const stored = JSON.parse(await readFile(join(dir, "session-spec.json"), "utf8"));
    expect(stored.fingerprint).toBe(spec.sessionSpecFingerprint());
  });

  it("a deploy that did not change the session setup restarts nothing", async () => {
    const spec = await load();
    await spec.restartSessionsIfSpecChanged();
    restartStaggered.mockClear();
    expect(await spec.restartSessionsIfSpecChanged()).toEqual({ changed: false, restarted: 0, pending: 0 });
    expect(restartStaggered).not.toHaveBeenCalled();
  });

  it("a sweep that failed does not record — the next boot tries again — and never throws", async () => {
    const spec = await load();
    restartStaggered.mockRejectedValueOnce(new Error("runner down"));
    await expect(spec.restartSessionsIfSpecChanged()).resolves.toMatchObject({ changed: true, restarted: 0 });
    await expect(readFile(join(dir, "session-spec.json"), "utf8")).rejects.toThrow();
    expect(await spec.restartSessionsIfSpecChanged()).toMatchObject({ changed: true, restarted: 2 });
  });
});
