import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Managed MCPs. INVARIANTS:
 *  - the resolved JSON (which carries tokens) travels INSIDE the script over STDIN, in a quoted
 *    heredoc — NEVER in argv, never in a log line;
 *  - remove-before-add per profile: the default profile WITHOUT CLAUDE_CONFIG_DIR, an account
 *    profile WITH it;
 *  - a secret is only accepted for a var/header the MCP DECLARES, and a missing one fails the apply
 *    loudly, naming it, before anything touches the runner;
 *  - the hot path is guarded by a signature marker, so reopening a card re-injects nothing.
 *
 * The board registry and the vault are REAL, against a temp data directory; only the host executor
 * is mocked. `shQuote`/`assertSafeRemotePath` stay real — quoting is the property under test.
 */

const SECRET = "tok_SUPER_SECRET_987654321";

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
  const vault = await import("../../secrets/vault.js");
  const mod = await import("./mcp.js");
  const { logger } = await import("../../utils/logger.js");
  return { reg, vault, mod, logger, container: env.config.runner.container };
}

beforeEach(async () => {
  vi.clearAllMocks();
  runScript.mockResolvedValue({ stdout: "", stderr: "" });
  dir = await mkdtemp(join(tmpdir(), "vibehub-mcp-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const STDIO = { id: "0123456789ab", name: "erp", kind: "stdio", command: "npx", args: ["-y", "erp-mcp"], envKeys: ["ERP_TOKEN"], createdAt: 1 } as const;

describe("mcpSecretKey", () => {
  it("builds MCP_<ID_UPPER>_<NAME>, turning a header dash into an underscore", async () => {
    const { mod } = await fresh();
    expect(mod.mcpSecretKey("0123456789ab", "ERP_TOKEN")).toBe("MCP_0123456789AB_ERP_TOKEN");
    expect(mod.mcpSecretKey("0123456789ab", "X-Api-Key")).toBe("MCP_0123456789AB_X_API_KEY");
    expect(mod.mcpSecretKey("0123456789ab", "authorization")).toBe("MCP_0123456789AB_AUTHORIZATION");
  });

  it("refuses an id or a name that could address someone else's secret", async () => {
    const { mod } = await fresh();
    // A traversal-shaped or wildcard-shaped id must never reach the secret store.
    for (const id of ["../x", "0123456789AB", "0123456789", "0123456789abc", "", "0123456789a*"]) {
      expect(() => mod.mcpSecretKey(id, "A")).toThrow(/invalid MCP id/);
    }
    for (const name of ["A B", "A;B", "$(id)", "1LEADING_DIGIT", "", "A\nB"]) {
      expect(() => mod.mcpSecretKey("0123456789ab", name)).toThrow(/invalid env\/header name/);
    }
  });

  it("refuses a key the vault would reject for length, naming the cause", async () => {
    const { mod } = await fresh();
    expect(() => mod.mcpSecretKey("0123456789ab", "H".repeat(60))).toThrow(/too long/);
  });

  it("produces a key the vault actually accepts", async () => {
    const { mod, vault } = await fresh();
    expect(() => vault.assertSecretKey(mod.mcpSecretKey("0123456789ab", "X-Api-Key"))).not.toThrow();
  });
});

describe("mcpServerJson", () => {
  it("stdio -> command/args/env; http/sse -> url/headers; no keys means no empty object", async () => {
    const { mod } = await fresh();
    expect(JSON.parse(mod.mcpServerJson(STDIO as never, { ERP_TOKEN: SECRET }))).toEqual({
      type: "stdio", command: "npx", args: ["-y", "erp-mcp"], env: { ERP_TOKEN: SECRET },
    });
    const http = { id: "0123456789ab", name: "tm", kind: "http", url: "https://example.test/mcp", headerKeys: ["Authorization"], createdAt: 1 };
    expect(JSON.parse(mod.mcpServerJson(http as never, { Authorization: `Bearer ${SECRET}` }))).toEqual({
      type: "http", url: "https://example.test/mcp", headers: { Authorization: `Bearer ${SECRET}` },
    });
    const sse = { id: "0123456789ab", name: "s", kind: "sse", url: "https://example.test/sse", createdAt: 1 };
    expect(JSON.parse(mod.mcpServerJson(sse as never, {}))).toEqual({ type: "sse", url: "https://example.test/sse" });
    const bare = { id: "0123456789ab", name: "p", kind: "stdio", command: "x", createdAt: 1 };
    expect(JSON.parse(mod.mcpServerJson(bare as never, {}))).toEqual({ type: "stdio", command: "x" });
  });

  it("keeps a hostile secret VALUE on one escaped line — the heredoc can never be closed early", async () => {
    const { mod } = await fresh();
    const nasty = `a"b\nVIBEHUB_MCP_JSON\n$(id) \`whoami\` '; rm -rf / #`;
    const json = mod.mcpServerJson(STDIO as never, { ERP_TOKEN: nasty });
    expect(json).not.toMatch(/[\r\n]/);
    expect(JSON.parse(json).env.ERP_TOKEN).toBe(nasty); // value survives intact
    // and it still injects cleanly
    const s = mod.mcpInjectLines([undefined], [{ name: "erp", json }]).join("\n");
    expect(s).toContain(json);
    expect(s.split("\n").filter((l) => l === "VIBEHUB_MCP_JSON").length).toBe(1);
  });

  it("a declared key with no resolved value becomes an empty string, not `undefined`", async () => {
    const { mod } = await fresh();
    expect(JSON.parse(mod.mcpServerJson(STDIO as never, {}))).toEqual({
      type: "stdio", command: "npx", args: ["-y", "erp-mcp"], env: { ERP_TOKEN: "" },
    });
  });
});

describe("mcpInjectLines", () => {
  const json = JSON.stringify({ type: "stdio", command: "npx", env: { T: SECRET } });

  it("removes before adding, per profile, with the JSON in a quoted heredoc", async () => {
    const { mod } = await fresh();
    const s = mod.mcpInjectLines([undefined, "/root/.claude-profiles/work"], [{ name: "erp", json }]).join("\n");
    // default profile: no CLAUDE_CONFIG_DIR
    expect(s).toContain("claude mcp remove -s user 'erp' >/dev/null 2>&1 || true");
    expect(s).toContain("claude mcp add-json -s user 'erp' \"$(cat <<'VIBEHUB_MCP_JSON'");
    expect(s).toContain(json);
    expect(s).toContain(")\" >/dev/null 2>&1 || true");
    // account profile: mkdir + the CLAUDE_CONFIG_DIR prefix
    expect(s).toContain("mkdir -p '/root/.claude-profiles/work'");
    expect(s).toContain("CLAUDE_CONFIG_DIR='/root/.claude-profiles/work' claude mcp remove -s user 'erp'");
    expect(s).toContain("CLAUDE_CONFIG_DIR='/root/.claude-profiles/work' claude mcp add-json -s user 'erp'");
    // remove really does come first
    expect(s.indexOf("mcp remove")).toBeLessThan(s.indexOf("mcp add-json"));
  });

  it("guards the hot path with a marker and drops the guard when forced", async () => {
    const { mod } = await fresh();
    const hot = mod.mcpInjectLines([undefined], [{ name: "erp", json }]).join("\n");
    expect(hot).toContain("if [ ! -f '/root/.claude/.mcps-");
    expect(hot.endsWith("fi")).toBe(true);
    expect(hot).toContain("rm -f '/root/.claude'/.mcps-* 2>/dev/null || true");

    const forced = mod.mcpInjectLines([undefined], [{ name: "erp", json }], true).join("\n");
    expect(forced).not.toContain("if [ ! -f");
    expect(forced).toContain(": > '/root/.claude/.mcps-");
  });

  it("is idempotent: the same SET produces the same marker, a changed set does not", async () => {
    const { mod } = await fresh();
    const sig = (s: string) => /\.mcps-([0-9a-f]+)/.exec(s)?.[1];
    const a = mod.mcpInjectLines([undefined], [{ name: "erp", json }]).join("\n");
    const b = mod.mcpInjectLines([undefined], [{ name: "erp", json }]).join("\n");
    expect(a).toBe(b);
    // order of the set must not matter — it is a SET, not a list
    const two = [{ name: "erp", json }, { name: "tm", json: "{}" }];
    expect(sig(mod.mcpInjectLines([undefined], two).join("\n")))
      .toBe(sig(mod.mcpInjectLines([undefined], [...two].reverse()).join("\n")));
    // a different set must invalidate the marker
    expect(sig(a)).not.toBe(sig(mod.mcpInjectLines([undefined], [{ name: "erp", json: "{}" }]).join("\n")));
    // a changed VALUE also invalidates it (rotating a token must reach the runner)
    const rotated = JSON.stringify({ type: "stdio", command: "npx", env: { T: "rotated" } });
    expect(sig(a)).not.toBe(sig(mod.mcpInjectLines([undefined], [{ name: "erp", json: rotated }]).join("\n")));
  });

  it("neutralises a hostile MCP name and refuses a hostile path or payload", async () => {
    const { mod } = await fresh();
    const s = mod.mcpInjectLines([undefined], [{ name: "x'; rm -rf / #", json }]).join("\n");
    expect(s).toContain(`claude mcp remove -s user 'x'\\''; rm -rf / #'`);
    expect(s).not.toMatch(/\n\s*rm -rf \//);

    expect(() => mod.mcpInjectLines(["/root/../etc"], [{ name: "x", json }])).toThrow(/\.\./);
    expect(() => mod.mcpInjectLines(["relative/path"], [{ name: "x", json }])).toThrow(/absolute/);
    expect(() => mod.mcpInjectLines([undefined], [{ name: "x", json: "{\n}" }])).toThrow(/invalid MCP JSON/);
    expect(() => mod.mcpInjectLines([undefined], [{ name: "x", json: "VIBEHUB_MCP_JSON" }])).toThrow(/invalid MCP JSON/);
  });

  it("does nothing at all when there is no MCP", async () => {
    const { mod } = await fresh();
    expect(mod.mcpInjectLines([undefined, "/root/.claude-profiles/work"], [])).toEqual([]);
  });
});

describe("buildMcpInjectScript", () => {
  it("wraps the body in `docker exec -i … bash -s` fed over stdin", async () => {
    const { mod } = await fresh();
    const s = mod.buildMcpInjectScript("vibehub-runner", [undefined], [{ name: "erp", json: "{}" }]);
    expect(s.startsWith("set -e\ndocker exec -i 'vibehub-runner' bash -s <<'VIBEHUB_MCP'\nset -e\n")).toBe(true);
    expect(s.endsWith("\nVIBEHUB_MCP")).toBe(true);
  });
});

describe("profiles", () => {
  it("lists the default profile plus one directory per account", async () => {
    const { mod, reg } = await fresh();
    expect(await mod.allProfiles()).toEqual([undefined]);
    await reg.createAccount({ name: "Work" });
    expect(await mod.allProfiles()).toEqual([undefined, "/root/.claude-profiles/work"]);
  });

  it("maps a slug to a profile, treating 'default' as the absence of one", async () => {
    const { mod } = await fresh();
    expect(mod.profileForSlug(undefined)).toBeUndefined();
    expect(mod.profileForSlug("default")).toBeUndefined();
    expect(mod.profileForSlug("work")).toBe("/root/.claude-profiles/work");
    expect(mod.profileDirFor(undefined)).toBe("/root/.claude");
    expect(mod.profileDirFor("default")).toBe("/root/.claude");
    expect(mod.profileDirFor("work")).toBe("/root/.claude-profiles/work");
    expect(mod.profileDirOf(undefined)).toBe("/root/.claude");
  });

  it("refuses a slug that would escape the profiles directory", async () => {
    const { mod } = await fresh();
    for (const bad of ["../etc", "a/b", "A", "x'; rm -rf / #", ""]) {
      expect(() => mod.accountConfigDir(bad)).toThrow(/invalid account slug/);
    }
  });
});

describe("secrets", () => {
  it("stores a declared value in the vault, rejects everything else, and never logs the value", async () => {
    const { mod, reg, vault, logger } = await fresh();
    const mcp = await reg.createMcp({ name: "erp", kind: "stdio", command: "npx", envKeys: ["ERP_TOKEN"] });
    const info = vi.spyOn(logger, "info");

    await mod.setMcpSecret(mcp, "ERP_TOKEN", SECRET, "alice");
    expect(await vault.secretGet(mod.mcpSecretKey(mcp.id, "ERP_TOKEN"))).toBe(SECRET);
    expect(await mod.mcpSecretsStatus(mcp)).toEqual({ ERP_TOKEN: true });

    // overwriting is a plain update, not a duplicate
    await mod.setMcpSecret(mcp, "ERP_TOKEN", `${SECRET}-2`);
    expect(await vault.secretGet(mod.mcpSecretKey(mcp.id, "ERP_TOKEN"))).toBe(`${SECRET}-2`);

    await expect(mod.setMcpSecret(mcp, "OTHER", "v")).rejects.toThrow(/not an env var or header declared/);
    await expect(mod.setMcpSecret(mcp, "ERP_TOKEN", "")).rejects.toThrow(/value is required/);
    for (const call of info.mock.calls) expect(JSON.stringify(call)).not.toContain(SECRET);
  });

  it("setMcpSecretById resolves through the board and 404s on an unknown id", async () => {
    const { mod, reg, vault } = await fresh();
    const mcp = await reg.createMcp({ name: "erp", kind: "stdio", command: "npx", envKeys: ["ERP_TOKEN"] });
    await mod.setMcpSecretById(mcp.id, "ERP_TOKEN", SECRET);
    expect(await vault.secretGet(mod.mcpSecretKey(mcp.id, "ERP_TOKEN"))).toBe(SECRET);
    await expect(mod.setMcpSecretById("000000000000", "ERP_TOKEN", "v")).rejects.toThrow(/MCP not found/);
  });

  it("reports which values are still missing", async () => {
    const { mod, reg } = await fresh();
    const mcp = await reg.createMcp({ name: "tm", kind: "http", url: "https://example.test/mcp", headerKeys: ["Authorization", "X-Api-Key"] });
    expect(await mod.mcpSecretsStatus(mcp)).toEqual({ Authorization: false, "X-Api-Key": false });
    await mod.setMcpSecret(mcp, "X-Api-Key", "k");
    expect(await mod.mcpSecretsStatus(mcp)).toEqual({ Authorization: false, "X-Api-Key": true });
  });

  it("deleteMcpSecrets forgets the values so they do not outlive the MCP", async () => {
    const { mod, reg, vault } = await fresh();
    const mcp = await reg.createMcp({ name: "erp", kind: "stdio", command: "npx", envKeys: ["ERP_TOKEN"] });
    await mod.setMcpSecret(mcp, "ERP_TOKEN", SECRET);
    expect(await mod.deleteMcpSecrets(mcp)).toBe(1);
    expect(await vault.secretGet(mod.mcpSecretKey(mcp.id, "ERP_TOKEN"))).toBeUndefined();
    expect(await mod.deleteMcpSecrets(mcp)).toBe(0); // idempotent
  });
});

describe("applyMcpsEverywhere", () => {
  async function seeded() {
    const ctx = await fresh();
    await ctx.reg.createAccount({ name: "Work" });
    const erp = await ctx.reg.createMcp({ name: "erp", kind: "stdio", command: "npx", envKeys: ["ERP_TOKEN"] });
    await ctx.reg.createMcp({ name: "tm", kind: "http", url: "https://example.test/mcp" });
    await ctx.mod.setMcpSecret(erp, "ERP_TOKEN", SECRET);
    return ctx;
  }

  it("injects every MCP into every profile of the ONE runner, in a single host call", async () => {
    const { mod, logger, container } = await seeded();
    const info = vi.spyOn(logger, "info");

    const out = await mod.applyMcpsEverywhere("alice");
    expect(out).toEqual({ runners: 1, mcps: 2 });
    expect(runScript).toHaveBeenCalledTimes(1);

    const [script, opts] = runScript.mock.calls[0]!;
    expect(script).toContain(`docker exec -i '${container}' bash -s`);
    expect(script).toContain(`"env":{"ERP_TOKEN":"${SECRET}"}`);
    expect(script).toContain("claude mcp add-json -s user 'erp'");
    expect(script).toContain("claude mcp add-json -s user 'tm'");
    expect(script).toContain("CLAUDE_CONFIG_DIR='/root/.claude-profiles/work' claude mcp add-json -s user 'erp'");
    expect(script).not.toContain("if [ ! -f"); // forced: the button always re-injects
    expect(opts).toMatchObject({ timeoutMs: 300_000 });
    // the token is in the script (stdin) and NOWHERE else
    for (const call of info.mock.calls) expect(JSON.stringify(call)).not.toContain(SECRET);
  });

  it("applying twice sends the identical script (nothing drifts between runs)", async () => {
    const { mod } = await seeded();
    await mod.applyMcpsEverywhere();
    await mod.applyMcpsEverywhere();
    expect(runScript.mock.calls[0]![0]).toBe(runScript.mock.calls[1]![0]);
  });

  it("a missing secret fails the whole apply, naming it, before the host is touched", async () => {
    const { mod, reg } = await fresh();
    await reg.createMcp({ name: "erp", kind: "stdio", command: "npx", envKeys: ["ERP_TOKEN"] });
    await expect(mod.applyMcpsEverywhere()).rejects.toThrow("MCP 'erp': value for 'ERP_TOKEN' is not configured");
    expect(runScript).not.toHaveBeenCalled();
  });

  it("with no MCP at all it still reaches the runner and reports zero", async () => {
    const { mod } = await fresh();
    expect(await mod.applyMcpsEverywhere()).toEqual({ runners: 1, mcps: 0 });
    expect(runScript).toHaveBeenCalledTimes(1);
  });

  it("propagates a host-executor failure instead of reporting success", async () => {
    const { mod } = await seeded();
    runScript.mockRejectedValue(new Error("host command timed out"));
    await expect(mod.applyMcpsEverywhere()).rejects.toThrow("host command timed out");
  });
});
