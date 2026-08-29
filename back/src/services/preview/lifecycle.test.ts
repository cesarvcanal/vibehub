import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { previewSessionFor, buildPreviewStartScript, buildCapturePaneScript } from "./lifecycle.js";
import { PROC_MARKER } from "./preview.js";

/**
 * The preview's own life: the dedicated session name (outside the card kill tree), the relaunch
 * script, and restart/stop end to end against a fresh registry with the runner mocked. The point
 * under test is the CONTRACT the UI depends on: restart waits for the port, refuses without a
 * stored command, and stop removes the record even when the kill fails.
 */

let dir = "";
const runScript = vi.fn();

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "vibehub-lifecycle-"));
  runScript.mockReset();
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

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
  env.config.publicUrl = "http://10.8.0.25:3010";
  vi.doMock("../../runtime/host.js", async () => {
    const actual = await vi.importActual<typeof import("../../runtime/host.js")>("../../runtime/host.js");
    return { ...actual, hostExecutor: () => ({ kind: "local", label: "test", runScript }) };
  });
  const registry = await import("../board/registry.js");
  const lifecycle = await import("./lifecycle.js");
  const project = await registry.createProject({ name: "Shop" });
  const card = await registry.createCard({ projectId: project.id, title: "Checkout" });
  return { registry, lifecycle, cardId: card.id };
}

describe("previewSessionFor / scripts (pure)", () => {
  it("derives a shell-safe session OUTSIDE the card-<8> namespace", () => {
    const s = previewSessionFor("a1b2c3d4-e5f6-4a4a-8b8b-000011112222", 5173);
    expect(s).toBe("preview-a1b2c3d4-5173");
    expect(() => previewSessionFor("../x", 5173)).toThrow(/invalid card id/);
    expect(() => previewSessionFor("a1b2c3d4", 0)).toThrow(/invalid preview port/);
  });

  it("start script kills any previous instance, then launches detached in the cwd via bash -lc", () => {
    const s = buildPreviewStartScript("vibehub-runner", "preview-a1b2c3d4-5173", "/work/app", "npm run dev");
    // The inner line rides shell-quoted inside `bash -c '<inner>'`, so single quotes are escaped.
    expect(s).toContain("tmux kill-session -t '\\''preview-a1b2c3d4-5173'\\''");
    expect(s).toContain(
      "tmux new-session -d -s '\\''preview-a1b2c3d4-5173'\\'' -c '\\''/work/app'\\'' bash -lc '\\''npm run dev'\\''",
    );
    expect(() => buildPreviewStartScript("c", "s", "", "npm run dev")).toThrow(/needs both/);
    expect(() => buildPreviewStartScript("c", "s", "/work", "a\nb")).toThrow(/single line/);
  });

  it("capture script is read-only and tolerates a session that is gone", () => {
    const s = buildCapturePaneScript("vibehub-runner", "preview-a1b2c3d4-5173");
    expect(s).toContain("capture-pane");
    expect(s).toContain("|| true");
  });
});

describe("restartPreview", () => {
  it("relaunches and resolves once the port listens, answering with the proxy path and URL", async () => {
    const { registry, lifecycle, cardId } = await boot();
    await registry.registerCardPreview(cardId, 5173, { label: "front", command: "npm run dev", cwd: "/work/app" });

    runScript.mockImplementation((script: string) => {
      if (script.includes("new-session")) return Promise.resolve({ stdout: "", stderr: "", code: 0 });
      return Promise.resolve({ stdout: scanOutput([5173]), stderr: "", code: 0 });
    });
    const out = await lifecycle.restartPreview(cardId, 5173);
    expect(out).toEqual({
      restarted: true,
      port: 5173,
      path: "/preview/5173/",
      url: "http://10.8.0.25:3010/preview/5173/",
    });
    const start = runScript.mock.calls.find((c) => String(c[0]).includes("new-session"))?.[0] as string;
    expect(start).toContain("preview-");
    expect(start).toContain("'npm run dev'");
  });

  it("refuses a preview with no stored command — the UI's 'ask the agent' case", async () => {
    const { registry, lifecycle, cardId } = await boot();
    await registry.registerCardPreview(cardId, 5173, { label: "old" });
    await expect(lifecycle.restartPreview(cardId, 5173)).rejects.toThrow(/no stored start command/);
    expect(runScript).not.toHaveBeenCalled();
  });

  it("fails with the pane's last output when the port never listens", async () => {
    vi.useFakeTimers();
    try {
      const { registry, lifecycle, cardId } = await boot();
      await registry.registerCardPreview(cardId, 5173, { command: "npm run dev", cwd: "/work/app" });
      runScript.mockImplementation((script: string) => {
        if (script.includes("capture-pane")) return Promise.resolve({ stdout: "npm ERR! missing script: dev", stderr: "", code: 0 });
        if (script.includes("new-session")) return Promise.resolve({ stdout: "", stderr: "", code: 0 });
        return Promise.resolve({ stdout: scanOutput([]), stderr: "", code: 0 });
      });
      const p = lifecycle.restartPreview(cardId, 5173);
      const guard = p.catch((e: Error) => e);
      await vi.advanceTimersByTimeAsync(30_000);
      const err = await guard;
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toMatch(/did not start listening/);
      expect((err as Error).message).toMatch(/npm ERR! missing script/);
    } finally {
      vi.useRealTimers();
    }
  });

  it("unknown preview / card are their own distinct errors", async () => {
    const { lifecycle, cardId } = await boot();
    await expect(lifecycle.restartPreview(cardId, 5173)).rejects.toThrow(/no preview registered/);
    await expect(lifecycle.restartPreview("nope", 5173)).rejects.toThrow(/card not found/);
  });
});

describe("stopPreview", () => {
  it("tree-kills the dedicated session and removes the record (chip gone)", async () => {
    const { registry, lifecycle, cardId } = await boot();
    await registry.registerCardPreview(cardId, 5173, { command: "npm run dev", cwd: "/work/app" });
    runScript.mockResolvedValue({ stdout: "", stderr: "", code: 0 });

    const out = await lifecycle.stopPreview(cardId, 5173);
    expect(out).toEqual({ stopped: true, port: 5173 });
    expect(String(runScript.mock.calls[0]?.[0])).toContain("kill-session");
    expect((await registry.getCard(cardId))?.previews).toBeUndefined();
    // stopping twice: the record is already gone
    await expect(lifecycle.stopPreview(cardId, 5173)).rejects.toThrow(/no preview registered/);
  });

  it("removes the record even when the kill script fails (best-effort kill, strict record)", async () => {
    const { registry, lifecycle, cardId } = await boot();
    await registry.registerCardPreview(cardId, 5173, { command: "npm run dev", cwd: "/work/app" });
    runScript.mockRejectedValue(new Error("runner down"));
    await lifecycle.stopPreview(cardId, 5173);
    expect((await registry.getCard(cardId))?.previews).toBeUndefined();
  });
});
