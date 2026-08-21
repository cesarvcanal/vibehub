import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The brain (the global CLAUDE.md planted in every runner profile). INVARIANTS:
 *  - the MULTI-LINE text travels inside the script over STDIN in a QUOTED heredoc (<<'DELIM'), so
 *    backticks, $VAR and quotes stay literal and can never be expanded by the runner's shell;
 *  - a line equal to a heredoc delimiter is REJECTED — it would close the heredoc early and turn
 *    the rest of the document into shell commands;
 *  - injection is idempotent by signature: the hot path is guarded by a `.brain-<sig>` marker,
 *    "Apply now" forces the rewrite;
 *  - the text is written by ABSOLUTE path into every profile, and is never logged in full.
 *
 * The board registry and the JsonStore are REAL against a temp data directory; the host executor is
 * mocked.
 */

const runScript = vi.fn();
vi.mock("../../runtime/host.js", async (orig) => ({
  ...(await orig<typeof import("../../runtime/host.js")>()),
  hostExecutor: () => ({ kind: "local", label: "this machine", runScript, ptyCommand: vi.fn(), writeFile: vi.fn() }),
}));

let dir = "";

async function fresh() {
  vi.resetModules();
  const env = await import("../../config/env.js");
  env.config.dataDir = dir;
  env.config.secretKey = "test-master-key";
  const reg = await import("../board/registry.js");
  const mod = await import("./brain.js");
  const { logger } = await import("../../utils/logger.js");
  return { reg, mod, logger, container: env.config.runner.container };
}

beforeEach(async () => {
  vi.clearAllMocks();
  runScript.mockResolvedValue({ stdout: "", stderr: "" });
  dir = await mkdtemp(join(tmpdir(), "vibehub-brain-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("brainSignature", () => {
  it("is stable for the same text and moves when the text moves", async () => {
    const { mod } = await fresh();
    expect(mod.brainSignature("hello\nworld")).toBe(mod.brainSignature("hello\nworld"));
    expect(mod.brainSignature("hello\nworld")).toMatch(/^[0-9a-f]+$/);
    expect(mod.brainSignature("hello\nworld")).not.toBe(mod.brainSignature("hello\nworld!"));
    expect(mod.brainSignature("")).toMatch(/^[0-9a-f]+$/);
  });
});

describe("assertBrainText", () => {
  it("rejects a line equal to a reserved delimiter and accepts ordinary shell-looking text", async () => {
    const { mod } = await fresh();
    expect(() => mod.assertBrainText("a\nVIBEHUB_OPEN\nb")).toThrow(/reserved line/);
    expect(() => mod.assertBrainText("VIBEHUB_BRAIN")).toThrow(/reserved line/);
    expect(() => mod.assertBrainText("a\r\nVIBEHUB_BRAIN\r\nb")).toThrow(/reserved line/); // CRLF too
    // a delimiter MENTIONED inside a line is harmless — only a whole line closes a heredoc
    expect(() => mod.assertBrainText("do not write VIBEHUB_BRAIN here")).not.toThrow();
    expect(() => mod.assertBrainText("text with `backticks`, $VAR, \"quotes\" and 'single'")).not.toThrow();
  });
});

describe("brainInjectLines", () => {
  const text = "# Brain\nline with `backticks`, $VAR, \"quotes\" and 'single'\nend";

  it("writes CLAUDE.md by absolute path into every profile, text literal in a quoted heredoc", async () => {
    const { mod } = await fresh();
    const s = mod.brainInjectLines([undefined, "/root/.claude-profiles/work"], text).join("\n");
    expect(s).toContain("mkdir -p '/root/.claude'");
    expect(s).toContain("cat > '/root/.claude/CLAUDE.md' <<'VIBEHUB_BRAIN_TEXT_");
    // absolute path means it needs no CLAUDE_CONFIG_DIR (unlike the MCP injection)
    expect(s).not.toContain("CLAUDE_CONFIG_DIR=");
    // the text goes in WHOLE and literal
    expect(s).toContain(text);
    expect(s).toContain("mkdir -p '/root/.claude-profiles/work'");
    expect(s).toContain("cat > '/root/.claude-profiles/work/CLAUDE.md' <<'VIBEHUB_BRAIN_TEXT_");
  });

  it("opens and closes the heredoc exactly once per profile", async () => {
    const { mod } = await fresh();
    const delim = `VIBEHUB_BRAIN_TEXT_${mod.brainSignature(text)}`;
    const lines = mod.brainInjectLines([undefined], text);
    // one line opening it, one line being the bare terminator
    expect(lines.filter((l) => l === delim).length).toBe(1);
    expect(lines.filter((l) => l.startsWith("cat > ") && l.endsWith(`<<'${delim}'`)).length).toBe(1);
  });

  it("guards the hot path with a marker and drops the guard when forced", async () => {
    const { mod } = await fresh();
    const hot = mod.brainInjectLines([undefined], text).join("\n");
    expect(hot).toContain("if [ ! -f '/root/.claude/.brain-");
    expect(hot.endsWith("fi")).toBe(true);
    expect(hot).toContain("rm -f '/root/.claude'/.brain-* 2>/dev/null || true");

    const forced = mod.brainInjectLines([undefined], text, true).join("\n");
    expect(forced).not.toContain("if [ ! -f");
    expect(forced).toContain(": > '/root/.claude/.brain-");
  });

  it("is idempotent for the same text and re-fires when the text changes", async () => {
    const { mod } = await fresh();
    const sig = (s: string) => /\.brain-([0-9a-f]+)/.exec(s)?.[1];
    const a = mod.brainInjectLines([undefined], "one").join("\n");
    expect(a).toBe(mod.brainInjectLines([undefined], "one").join("\n"));
    expect(sig(a)).not.toBe(sig(mod.brainInjectLines([undefined], "two").join("\n")));
  });

  it("refuses an unsafe profile path and a text that would break the heredoc", async () => {
    const { mod } = await fresh();
    expect(() => mod.brainInjectLines(["/root/../etc"], text)).toThrow(/\.\./);
    expect(() => mod.brainInjectLines(["relative"], text)).toThrow(/absolute/);
    expect(() => mod.brainInjectLines([undefined], "a\nVIBEHUB_BRAIN\nb")).toThrow(/reserved line/);
  });
});

describe("buildBrainInjectScript", () => {
  it("wraps the body in `docker exec -i … bash -s` fed over stdin", async () => {
    const { mod } = await fresh();
    const s = mod.buildBrainInjectScript("vibehub-runner", [undefined], "hi");
    expect(s.startsWith("set -e\ndocker exec -i 'vibehub-runner' bash -s <<'VIBEHUB_BRAIN'\nset -e\n")).toBe(true);
    expect(s.endsWith("\nVIBEHUB_BRAIN")).toBe(true);
  });
});

describe("DEFAULT_BRAIN", () => {
  it("is a usable, injectable seed", async () => {
    const { mod } = await fresh();
    expect(mod.DEFAULT_BRAIN.length).toBeGreaterThan(200);
    expect(() => mod.assertBrainText(mod.DEFAULT_BRAIN)).not.toThrow();
    expect(() => mod.brainInjectLines([undefined], mod.DEFAULT_BRAIN, true)).not.toThrow();
  });

  it("describes the environment, not a particular person or company", async () => {
    const { mod } = await fresh();
    // The seed ships to every install, so it must never carry someone's identity or paths.
    expect(mod.DEFAULT_BRAIN).not.toMatch(/@[\w.-]+\.(com|br|net|org)\b/);
    expect(mod.DEFAULT_BRAIN).not.toMatch(/~\/Documents|\/Users\/|Co-Authored-By/);
    expect(mod.DEFAULT_BRAIN).toMatch(/vibehub/);
  });
});

describe("the stored text", () => {
  it("falls back to the seed until something is saved", async () => {
    const { mod } = await fresh();
    expect(await mod.resolveBrainText()).toBe(mod.DEFAULT_BRAIN);
    const view = await mod.brainView();
    expect(view.text).toBe(mod.DEFAULT_BRAIN);
    expect(view.defaultText).toBe(mod.DEFAULT_BRAIN);
    expect(view.updatedAt).toBeUndefined();
    expect(view.by).toBeUndefined();
  });

  it("saves, reports metadata, and survives a reload from disk at mode 600", async () => {
    const { mod } = await fresh();
    await mod.setBrainText("my own brain", "alice");
    const view = await mod.brainView();
    expect(view.text).toBe("my own brain");
    expect(view.by).toBe("alice");
    expect(typeof view.updatedAt).toBe("string");
    expect((await stat(join(dir, "brain.json"))).mode & 0o777).toBe(0o600);

    const reloaded = await fresh(); // brand new module + store, same directory
    expect(await reloaded.mod.resolveBrainText()).toBe("my own brain");
  });

  it("refuses empty text and text that would break the heredoc, at SAVE time", async () => {
    const { mod } = await fresh();
    await expect(mod.setBrainText("   ")).rejects.toThrow(/cannot be empty/);
    await expect(mod.setBrainText("a\nVIBEHUB_BRAIN\nb")).rejects.toThrow(/reserved line/);
    // nothing was stored, so the seed still applies
    expect(await mod.resolveBrainText()).toBe(mod.DEFAULT_BRAIN);
  });

  it("resetBrain brings the seed back", async () => {
    const { mod } = await fresh();
    await mod.setBrainText("temporary");
    await mod.resetBrain("alice");
    expect(await mod.resolveBrainText()).toBe(mod.DEFAULT_BRAIN);
    expect((await mod.brainView()).updatedAt).toBeUndefined();
  });
});

describe("applyBrainEverywhere", () => {
  it("force-writes the text into every profile of the ONE runner, in a single host call", async () => {
    const { mod, reg, logger, container } = await fresh();
    await reg.createAccount({ name: "Work" });
    await mod.setBrainText("BRAIN TEXT 42");
    const info = vi.spyOn(logger, "info");

    const out = await mod.applyBrainEverywhere("alice");
    expect(out).toEqual({ runners: 1, bytes: Buffer.byteLength("BRAIN TEXT 42") });
    expect(runScript).toHaveBeenCalledTimes(1);

    const [script, opts] = runScript.mock.calls[0]!;
    expect(script).toContain(`docker exec -i '${container}' bash -s`);
    expect(script).toContain("BRAIN TEXT 42");
    expect(script).toContain("cat > '/root/.claude/CLAUDE.md'");
    expect(script).toContain("cat > '/root/.claude-profiles/work/CLAUDE.md'");
    expect(script).not.toContain("if [ ! -f"); // forced
    expect(opts).toMatchObject({ timeoutMs: 300_000 });
    // audit records the size, never the document
    for (const call of info.mock.calls) expect(JSON.stringify(call)).not.toContain("BRAIN TEXT 42");
  });

  it("applies the seed when nothing was ever saved", async () => {
    const { mod } = await fresh();
    const out = await mod.applyBrainEverywhere();
    expect(out.bytes).toBe(Buffer.byteLength(mod.DEFAULT_BRAIN));
    expect(runScript.mock.calls[0]![0]).toContain("cat > '/root/.claude/CLAUDE.md'");
  });

  it("applying twice sends the identical script", async () => {
    const { mod } = await fresh();
    await mod.setBrainText("stable");
    await mod.applyBrainEverywhere();
    await mod.applyBrainEverywhere();
    expect(runScript.mock.calls[0]![0]).toBe(runScript.mock.calls[1]![0]);
  });

  it("propagates a host-executor failure instead of reporting success", async () => {
    const { mod } = await fresh();
    runScript.mockRejectedValue(new Error("host command timed out"));
    await expect(mod.applyBrainEverywhere()).rejects.toThrow("host command timed out");
  });
});
