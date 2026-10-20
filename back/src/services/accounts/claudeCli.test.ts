import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, mkdir, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolvedClaudeCommand, CLAUDE_MISSING_MESSAGE, SDK_CLAUDE_GLOB } from "./claudeCli.js";

/**
 * The login terminal's `claude`. The snippet is RUN for real in bash with a controlled PATH and fake
 * binaries: what broke in production was "the global CLI is gone", and only a run proves the
 * fallback picks something up.
 */

let dir = "";
let globalBin = "";
let sdkRoot = "";

/** A fake `claude` that just says who it is and echoes its arguments. */
async function fakeClaude(path: string, name: string): Promise<void> {
  await writeFile(path, `#!/bin/sh\necho "${name} $*"\n`);
  await chmod(path, 0o755);
}

function run(sdkGlob: string): { out: string; status: number | null } {
  const r = spawnSync("bash", ["-c", resolvedClaudeCommand("/login", sdkGlob)], {
    // PATH holds only our fake global dir plus the basics (`ls`, `head`).
    env: { PATH: `${globalBin}:/usr/bin:/bin` },
    encoding: "utf8",
  });
  return { out: r.stdout.trim(), status: r.status };
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "vh-claudecli-"));
  globalBin = join(dir, "bin");
  sdkRoot = join(dir, "sdk");
  await mkdir(globalBin);
  await mkdir(join(sdkRoot, "claude-agent-sdk-linux-x64"), { recursive: true });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe.skipIf(process.platform === "win32")("resolvedClaudeCommand", () => {
  const glob = () => join(sdkRoot, "claude-agent-sdk-linux-*", "claude");

  it("prefers the global CLI when it is on PATH", async () => {
    await fakeClaude(join(globalBin, "claude"), "global");
    await fakeClaude(join(sdkRoot, "claude-agent-sdk-linux-x64", "claude"), "sdk");
    expect(run(glob())).toEqual({ out: "global /login", status: 0 });
  });

  it("falls back to the SDK's binary when the global CLI is missing", async () => {
    await fakeClaude(join(sdkRoot, "claude-agent-sdk-linux-x64", "claude"), "sdk");
    expect(run(glob())).toEqual({ out: "sdk /login", status: 0 });
  });

  it("says what is missing, and fails, when there is no binary at all", () => {
    const r = run(glob());
    expect(r.out).toBe(CLAUDE_MISSING_MESSAGE);
    expect(r.status).not.toBe(0);
  });

  it("does not run an SDK file that is not executable", async () => {
    await writeFile(join(sdkRoot, "claude-agent-sdk-linux-x64", "claude"), "not a binary");
    expect(run(glob()).out).toBe(CLAUDE_MISSING_MESSAGE);
  });

  it("a runner prefix bounds the binary: a login left open is killed at the deadline", async () => {
    await writeFile(join(globalBin, "claude"), "#!/bin/sh\nexec sleep 30\n");
    await chmod(join(globalBin, "claude"), 0o755);
    const started = Date.now();
    const r = spawnSync("bash", ["-c", resolvedClaudeCommand("/login", glob(), "timeout --foreground -s KILL 1")], {
      env: { PATH: `${globalBin}:/usr/bin:/bin` },
      encoding: "utf8",
    });
    expect(r.status).toBe(137);
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it("looks for the SDK binary under the driver's directory by default", () => {
    expect(SDK_CLAUDE_GLOB).toBe("/root/.vibehub-sdk/node_modules/@anthropic-ai/claude-agent-sdk-linux-*/claude");
    expect(resolvedClaudeCommand("/login")).toContain(SDK_CLAUDE_GLOB);
  });
});
