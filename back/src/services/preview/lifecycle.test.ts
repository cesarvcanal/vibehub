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
  env.config.publicUrl = "http://192.0.2.10:3010";
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
      url: "http://192.0.2.10:3010/preview/5173/",
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

/**
 * A DELETED CARD MUST NOT LEAVE ITS DEV SERVERS RUNNING.
 *
 * The preview lives outside the card pane's process tree on purpose — that is what makes it survive
 * a pause. The same property made it survive the card's DELETION: a server still listening, still
 * proxied at `/preview/<port>/` for any logged-in user, on a card nobody can see any more.
 */
describe("stopAllCardPreviews (the card is being deleted)", () => {
  const CARD = "a1b2c3d4-e5f6-4a4a-8b8b-000011112222";

  it("asks TMUX what is running in the card's name, by prefix", async () => {
    const { lifecycle } = await boot();
    expect(lifecycle.previewSessionPrefix(CARD)).toBe("preview-a1b2c3d4-");
    const s = lifecycle.buildPreviewSessionListScript("vibehub-runner", CARD);
    expect(s).toContain("tmux list-sessions -F");
    expect(s).toContain("preview-a1b2c3d4-");
    expect(s).toContain("|| true"); // no sessions at all is an empty answer, not an error
    expect(() => lifecycle.previewSessionPrefix("../x")).toThrow(/invalid card id/);
  });

  it("keeps only this card's sessions out of the listing (never another card's)", async () => {
    const { lifecycle } = await boot();
    const parsed = lifecycle.parsePreviewSessions(
      ["preview-a1b2c3d4-5173", "preview-a1b2c3d4-6006", "preview-ffffffff-5173", "card-a1b2c3d4", "", "junk; rm -rf /"]
        .join("\n"),
      CARD,
    );
    expect(parsed).toEqual(["preview-a1b2c3d4-5173", "preview-a1b2c3d4-6006"]);
  });

  it("tree-kills every one of them, and a card with no preview costs one read", async () => {
    const { lifecycle } = await boot();
    runScript.mockResolvedValueOnce({ stdout: "preview-a1b2c3d4-5173\npreview-a1b2c3d4-6006\n", stderr: "" });
    runScript.mockResolvedValueOnce({ stdout: "", stderr: "" });

    expect(await lifecycle.stopAllCardPreviews(CARD)).toEqual([
      "preview-a1b2c3d4-5173", "preview-a1b2c3d4-6006",
    ]);
    const kill = String(runScript.mock.calls[1]?.[0]);
    expect(kill).toContain("tmux kill-session -t 'preview-a1b2c3d4-5173'");
    expect(kill).toContain("tmux kill-session -t 'preview-a1b2c3d4-6006'");
    expect(kill).toContain("kill -TERM $PIDS"); // the same tree-kill discipline as a card session

    runScript.mockReset();
    runScript.mockResolvedValueOnce({ stdout: "", stderr: "" });
    expect(await lifecycle.stopAllCardPreviews(CARD)).toEqual([]);
    expect(runScript).toHaveBeenCalledTimes(1);
  });

  it("a runner that cannot be asked is not an error — the purge reports it and the sweep retries", async () => {
    const { lifecycle } = await boot();
    runScript.mockRejectedValue(new Error("runner down"));
    expect(await lifecycle.stopAllCardPreviews(CARD)).toEqual([]);
  });
});
