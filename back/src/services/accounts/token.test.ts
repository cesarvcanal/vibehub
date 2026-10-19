import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, stat, utimes, writeFile, readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * LONG-LIVED ACCOUNT TOKEN. The invariants under test are the ones a reviewer would hunt for:
 *  - the value goes into the vault and into the runner file, and NEVER into argv or a log line;
 *  - the file lands in the EFFECTIVE profile (default → /root/.claude, account → its own), mode 600;
 *  - a runner that is down does not lose the token — the vault keeps it and the card open re-seeds it;
 *  - nothing user-supplied reaches the shell: slug and token are validated first.
 * The vault and the board are REAL (temp data dir); only the host executor is mocked.
 */

const TOKEN = "sk-ant-oat01-LONGLIVEDTOKEN1234567890abcdef";

vi.mock("../../runtime/host.js", async (orig) => ({
  ...(await orig<typeof import("../../runtime/host.js")>()),
  hostExecutor: vi.fn(),
}));

let dir = "";
let runScript: ReturnType<typeof vi.fn>;

async function fresh() {
  vi.resetModules();
  const env = await import("../../config/env.js");
  env.config.dataDir = dir;
  env.config.secretKey = "test-key";
  env.config.runner.container = "vibehub-runner";
  const host = await import("../../runtime/host.js");
  runScript = vi.fn(async () => ({ stdout: "", stderr: "" }));
  vi.mocked(host.hostExecutor).mockReturnValue({
    kind: "local", label: "this machine", runScript,
    writeFile: vi.fn(), ptyCommand: () => ({ file: "bash", args: [] }),
  } as unknown as import("../../runtime/host.js").HostExecutor);
  return {
    token: await import("./token.js"),
    registry: await import("../board/registry.js"),
    vault: await import("../../secrets/vault.js"),
    host,
  };
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "vibehub-token-"));
  vi.clearAllMocks();
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("accountTokenKey (pure)", () => {
  it("ACCOUNT_TOKEN_<SLUG>, upper case, dashes as underscores", async () => {
    const { token } = await fresh();
    expect(token.accountTokenKey("default")).toBe("ACCOUNT_TOKEN_DEFAULT");
    expect(token.accountTokenKey("personal")).toBe("ACCOUNT_TOKEN_PERSONAL");
    expect(token.accountTokenKey("work-2")).toBe("ACCOUNT_TOKEN_WORK_2");
  });

  it("a hostile slug never becomes a vault key", async () => {
    const { token } = await fresh();
    expect(() => token.accountTokenKey("a/b")).toThrow(/invalid account slug/);
    expect(() => token.accountTokenKey("x; rm -rf /")).toThrow(/invalid account slug/);
  });

  it("the derived key is accepted by the vault's own key rule", async () => {
    const { token, vault } = await fresh();
    expect(() => vault.assertSecretKey(token.accountTokenKey("a".repeat(30)))).not.toThrow();
  });
});

describe("assertOauthToken (pure)", () => {
  it("accepts a setup-token value", async () => {
    const { token } = await fresh();
    expect(token.assertOauthToken(` ${TOKEN} `)).toBe(TOKEN);
  });
  it("refuses shell metacharacters, spaces, newlines and anything too short", async () => {
    const { token } = await fresh();
    for (const bad of ["short", "sk-ant-oat01-abc def ghi jkl mno", "sk-ant$(reboot)-aaaaaaaaaaaaaaaaaaaa", "sk-ant-oat01-aaaaaaaaaaaaaaaaaaaa\nrm -rf /", "'; rm -rf /; '"]) {
      expect(() => token.assertOauthToken(bad)).toThrow(/invalid token/);
    }
  });
});

describe("script builders (pure)", () => {
  it("writes the token into the profile with mode 600, through a heredoc on stdin", async () => {
    const { token } = await fresh();
    const script = token.buildWriteTokenScript("vibehub-runner", "/root/.claude", TOKEN);
    expect(script).toContain("docker exec -i 'vibehub-runner' bash -s <<'VIBEHUB_TOKEN'");
    expect(script).toContain("umask 077");
    expect(script).toContain(`printf '%s' '${TOKEN}' > '/root/.claude/.oauth-token'`);
    expect(script).toContain("chmod 600 '/root/.claude/.oauth-token'");
    // mkdir first: a brand new account has no profile directory yet
    expect(script.indexOf("mkdir -p '/root/.claude'")).toBeLessThan(script.indexOf("printf"));
  });

  it("the account profile variant targets that profile only", async () => {
    const { token } = await fresh();
    const script = token.buildWriteTokenScript("c", "/root/.claude-profiles/personal", TOKEN);
    expect(script).toContain("'/root/.claude-profiles/personal/.oauth-token'");
    expect(script).not.toContain("/root/.claude/.oauth-token");
  });

  it("a traversal profile path THROWS before any script exists", async () => {
    const { token } = await fresh();
    expect(() => token.writeTokenLines("/root/../etc", TOKEN)).toThrow(/\.\./);
    expect(() => token.buildRemoveTokenScript("c", "relative/path")).toThrow(/absolute/);
  });

  it("remove is a plain rm -f (idempotent)", async () => {
    const { token } = await fresh();
    const script = token.buildRemoveTokenScript("vibehub-runner", "/root/.claude-profiles/personal");
    expect(script).toContain("rm -f '/root/.claude-profiles/personal/.oauth-token'");
  });
});

/**
 * The token file's AGE decides who signs a session in (see `oauthTokenGuard`): the card open must
 * not refresh it when nothing changed, or every open would bring a revoked token back over a newer
 * `/login`. Run in a real bash.
 */
describe("writeTokenLines — the file's age only moves when the value does (real bash)", () => {
  async function run(
    force: boolean,
    existing?: string,
    credentials?: string,
  ): Promise<{ value: string | null; touched: boolean }> {
    const { token } = await fresh();
    const dir = await mkdtemp(join(tmpdir(), "vh-tokfile-"));
    try {
      const file = join(dir, ".oauth-token");
      const old = Date.now() / 1000 - 86_400;
      if (existing !== undefined) {
        await writeFile(file, existing);
        await utimes(file, old, old);
      }
      if (credentials !== undefined) await writeFile(join(dir, ".credentials.json"), credentials);
      execFileSync("bash", ["-c", ["set -e", ...token.writeTokenLines(dir, TOKEN, { force })].join("\n")]);
      const value = await readFile(file, "utf8").catch(() => null);
      if (value === null) return { value, touched: false };
      const touched = existing === undefined || (await stat(file)).mtimeMs / 1000 > old + 1;
      expect((await stat(file)).mode & 0o777).toBe(0o600);
      return { value, touched };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  it("card open, same token already there → file untouched (a newer /login keeps the lead)", async () => {
    expect(await run(false, TOKEN)).toEqual({ value: TOKEN, touched: false });
  });

  it("card open, the vault holds a DIFFERENT token → rewritten", async () => {
    expect(await run(false, "sk-ant-oat01-OLD")).toEqual({ value: TOKEN, touched: true });
  });

  it("card open, no file yet → written", async () => {
    expect(await run(false)).toEqual({ value: TOKEN, touched: true });
  });

  const LOGIN = JSON.stringify({ claudeAiOauth: { accessToken: "a", refreshToken: "r", expiresAt: 1 } });

  it("card open, a refreshable /login and NO token file (the revoked one was moved away) → not planted", async () => {
    expect(await run(false, undefined, LOGIN)).toEqual({ value: null, touched: false });
  });

  it("card open, a refreshable /login and a DIFFERENT token → untouched (the login keeps the lead)", async () => {
    expect(await run(false, "sk-ant-oat01-OLD", LOGIN)).toEqual({ value: "sk-ant-oat01-OLD", touched: false });
  });

  it("card open, a /login WITHOUT refresh token cannot win → the token is still seeded", async () => {
    const dead = JSON.stringify({ claudeAiOauth: { accessToken: "a" } });
    expect(await run(false, undefined, dead)).toEqual({ value: TOKEN, touched: true });
  });

  it("saving the token in the UI (force) with a /login present → written anyway (the person chose it)", async () => {
    expect(await run(true, undefined, LOGIN)).toEqual({ value: TOKEN, touched: true });
  });

  it("saving the token in the UI (force) → always rewritten, even with the same value", async () => {
    expect(await run(true, TOKEN)).toEqual({ value: TOKEN, touched: true });
  });
});

describe("GitHub token per card (pure)", () => {
  const GH = "ghp_ABCdef1234567890ABCdef1234567890";

  it("the path is per-card, under /root/.vibehub/gh, and a bad id THROWS before any file name", async () => {
    const { token } = await fresh();
    expect(token.ghTokenPath("be24168d-3c48-4d5b-b56c-6a933805165a")).toBe(
      "/root/.vibehub/gh/be24168d-3c48-4d5b-b56c-6a933805165a.token",
    );
    expect(() => token.ghTokenPath("../../etc/passwd")).toThrow(/invalid card id/);
    expect(() => token.ghTokenPath("id with space")).toThrow(/invalid card id/);
  });

  it("write is mode 600 via printf over stdin — token never in argv, mkdir first", async () => {
    const { token } = await fresh();
    const lines = token.writeGhTokenLines("id-1", GH).join("\n");
    expect(lines).toContain("umask 077");
    expect(lines).toContain(`printf '%s' '${GH}' > '/root/.vibehub/gh/id-1.token'`);
    expect(lines).toContain("chmod 600 '/root/.vibehub/gh/id-1.token'");
    expect(lines.indexOf("mkdir -p '/root/.vibehub/gh'")).toBeLessThan(lines.indexOf("printf"));
  });

  it("remove keeps the file in sync (idempotent rm -f)", async () => {
    const { token } = await fresh();
    expect(token.removeGhTokenLines("id-1").join("\n")).toBe("rm -f '/root/.vibehub/gh/id-1.token'");
  });

  it("a token with unexpected characters THROWS before reaching the shell", async () => {
    const { token } = await fresh();
    expect(token.assertGhToken(GH)).toBe(GH);
    expect(token.assertGhToken("github_pat_11ABCDEFG0abcdefghij_KLMNOPqrstuvwxyz1234567890")).toBeTruthy();
    expect(() => token.assertGhToken("ghp_x; rm -rf /")).toThrow(/invalid GitHub token/);
    expect(() => token.assertGhToken("short")).toThrow(/invalid GitHub token/);
  });
});

describe("set / resolve / remove", () => {
  it("stores in the vault and plants the file in the runner — never in argv, never in a log", async () => {
    const { token, registry, host } = await fresh();
    await registry.createAccount({ name: "Personal" });
    const { logger } = await import("../../utils/logger.js");
    const infoSpy = vi.spyOn(logger, "info");

    const out = await token.setAccountToken("personal", TOKEN, "tester");
    expect(out).toEqual({ runnerUpdated: true });
    expect(await token.resolveAccountToken("personal")).toBe(TOKEN);

    expect(runScript).toHaveBeenCalledTimes(1);
    const [script] = runScript.mock.calls[0]!;
    expect(String(script)).toContain("'/root/.claude-profiles/personal/.oauth-token'");
    // The script is the STDIN argument of runScript — the executor never puts it in argv, and the
    // executor itself is the only thing that spawns a process.
    expect(vi.mocked(host.hostExecutor)).toHaveBeenCalled();
    for (const call of infoSpy.mock.calls) expect(JSON.stringify(call)).not.toContain(TOKEN);
  });

  it("the default account writes into /root/.claude", async () => {
    const { token } = await fresh();
    await token.setAccountToken("default", TOKEN);
    expect(String(runScript.mock.calls[0]![0])).toContain("'/root/.claude/.oauth-token'");
    expect(await token.resolveAccountToken(undefined)).toBe(TOKEN);
  });

  it("a runner that is down does NOT lose the token: the vault keeps it, runnerUpdated=false", async () => {
    const { token, host } = await fresh();
    const { HostExecError } = host;
    runScript.mockRejectedValue(new HostExecError("Cannot connect to the Docker daemon"));
    const out = await token.setAccountToken("default", TOKEN);
    expect(out).toEqual({ runnerUpdated: false });
    expect(await token.resolveAccountToken("default")).toBe(TOKEN);
  });

  it("an unknown account THROWS and nothing is written", async () => {
    const { token } = await fresh();
    await expect(token.setAccountToken("ghost", TOKEN)).rejects.toThrow(/account 'ghost' not found/);
    expect(runScript).not.toHaveBeenCalled();
    expect(await token.resolveAccountToken("ghost")).toBeUndefined();
  });

  it("an invalid token is refused before the vault or the host is touched", async () => {
    const { token } = await fresh();
    await expect(token.setAccountToken("default", "nope")).rejects.toThrow(/invalid token/);
    expect(runScript).not.toHaveBeenCalled();
    expect(await token.resolveAccountToken("default")).toBeUndefined();
  });

  it("remove clears the vault and the runner file", async () => {
    const { token, registry } = await fresh();
    await registry.createAccount({ name: "Personal" });
    await token.setAccountToken("personal", TOKEN);
    runScript.mockClear();

    const out = await token.removeAccountToken("personal", "tester");
    expect(out).toEqual({ runnerUpdated: true });
    expect(await token.resolveAccountToken("personal")).toBeUndefined();
    expect(String(runScript.mock.calls[0]![0])).toContain("rm -f '/root/.claude-profiles/personal/.oauth-token'");
  });

  it("removing a token that was never set is a no-op, not an error", async () => {
    const { token } = await fresh();
    await expect(token.removeAccountToken("default")).resolves.toEqual({ runnerUpdated: true });
  });

  it("a corrupted stored value is treated as absent rather than shipped to a shell", async () => {
    const { token, vault } = await fresh();
    await vault.secretSet("ACCOUNT_TOKEN_DEFAULT", "not a token; rm -rf /");
    expect(await token.resolveAccountToken("default")).toBeUndefined();
  });

  it("accountsTokenStatus reports presence per account without reading any value", async () => {
    const { token, registry } = await fresh();
    await registry.createAccount({ name: "Personal" });
    await registry.createAccount({ name: "Work" });
    await token.setAccountToken("personal", TOKEN);
    await token.setAccountToken("default", TOKEN);

    const status = await token.accountsTokenStatus();
    expect(status.bySlug).toEqual({ personal: true, work: false });
    expect(status.defaultHasToken).toBe(true);
    expect(JSON.stringify(status)).not.toContain(TOKEN);
  });
});
