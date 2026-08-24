import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const runScript = vi.fn(async () => ({ stdout: "", stderr: "" }));

let dir = "";

async function load() {
  vi.resetModules();
  const env = await import("../../config/env.js");
  env.config.dataDir = dir;
  env.config.runner.container = "vibehub-runner";
  vi.doMock("../../runtime/host.js", async () => {
    const actual = await vi.importActual<typeof import("../../runtime/host.js")>("../../runtime/host.js");
    return { ...actual, hostExecutor: () => ({ kind: "local", label: "test", runScript, writeFile: vi.fn(), ptyCommand: vi.fn() }) };
  });
  return {
    gate: await import("./gate.js"),
    registry: await import("../board/registry.js"),
  };
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "vibehub-gate-"));
  runScript.mockClear();
  runScript.mockResolvedValue({ stdout: "", stderr: "" });
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe("parseGateConfig", () => {
  it("reads a checks array, trimming and dropping blanks and non-strings", async () => {
    const { gate } = await load();
    expect(gate.parseGateConfig('{"checks":["  npm run lint ", "", 3, "npm test"]}')).toEqual(["npm run lint", "npm test"]);
  });
  it("returns null for absent, malformed, or empty configs", async () => {
    const { gate } = await load();
    expect(gate.parseGateConfig("")).toBeNull();
    expect(gate.parseGateConfig("not json")).toBeNull();
    expect(gate.parseGateConfig('{"checks":[]}')).toBeNull();
    expect(gate.parseGateConfig('{"checks":"npm test"}')).toBeNull();
    expect(gate.parseGateConfig("{}")).toBeNull();
  });
  it("caps the number of checks", async () => {
    const { gate } = await load();
    const many = Array.from({ length: 40 }, (_, i) => `cmd${i}`);
    expect(gate.parseGateConfig(JSON.stringify({ checks: many })).length).toBe(gate.MAX_GATE_CHECKS);
  });
});

describe("resolveGateChecks", () => {
  const probe = (over = {}) => ({
    gateJson: "", hasPackageJson: false, hasTestScript: false, hasTsconfig: false, hasLocalTsc: false, ...over,
  });

  it("gate.json wins over the defaults", async () => {
    const { gate } = await load();
    const r = gate.resolveGateChecks(probe({ gateJson: '{"checks":["make ci"]}', hasPackageJson: true, hasTestScript: true }));
    expect(r).toEqual({ ran: true, checks: ["make ci"] });
  });

  it("falls back to the defaults, each only when resolvable", async () => {
    const { gate } = await load();
    expect(gate.resolveGateChecks(probe({ hasTsconfig: true, hasLocalTsc: true }))).toEqual({ ran: true, checks: [gate.DEFAULT_TSC_CHECK] });
    expect(gate.resolveGateChecks(probe({ hasPackageJson: true, hasTestScript: true }))).toEqual({ ran: true, checks: [gate.DEFAULT_TEST_CHECK] });
    expect(gate.resolveGateChecks(probe({ hasTsconfig: true, hasLocalTsc: true, hasPackageJson: true, hasTestScript: true })).checks)
      .toEqual([gate.DEFAULT_TSC_CHECK, gate.DEFAULT_TEST_CHECK]);
  });

  it("a tsconfig with no local tsc, or a package with no test script, does not resolve a default", async () => {
    const { gate } = await load();
    expect(gate.resolveGateChecks(probe({ hasTsconfig: true, hasLocalTsc: false }))).toEqual({ ran: false, checks: [] });
    expect(gate.resolveGateChecks(probe({ hasPackageJson: true, hasTestScript: false }))).toEqual({ ran: false, checks: [] });
  });

  it("nothing resolvable = ran:false (pass-through)", async () => {
    const { gate } = await load();
    expect(gate.resolveGateChecks(probe())).toEqual({ ran: false, checks: [] });
  });
});

describe("probe script + parse", () => {
  it("is read-only, cds into the worktree passed as $1, and reads gate.json last", async () => {
    const { gate } = await load();
    const s = gate.buildGateProbeScript("vibehub-runner", "/work/scratch/x");
    expect(s).toContain("docker exec 'vibehub-runner'");
    expect(s).toContain("cat .vibehub/gate.json");
    expect(s).not.toMatch(/\brm\b|>>|\bmv\b/);
    expect(() => gate.buildGateProbeScript("c", "/work/../etc")).toThrow(/\.\./);
  });

  it("round-trips the flags and the gate.json body", async () => {
    const { gate } = await load();
    const stdout = ["pkg=1", "test=0", "tsconfig=1", "localtsc=1", "__VIBEHUB_GATE_JSON__", '{"checks":["make ci"]}'].join("\n");
    expect(gate.parseGateProbe(stdout)).toEqual({
      gateJson: '{"checks":["make ci"]}',
      hasPackageJson: true, hasTestScript: false, hasTsconfig: true, hasLocalTsc: true,
    });
  });

  it("a probe with no gate.json yields an empty body", async () => {
    const { gate } = await load();
    const stdout = ["pkg=1", "test=1", "tsconfig=0", "localtsc=0", "__VIBEHUB_GATE_JSON__"].join("\n") + "\n";
    const probe = gate.parseGateProbe(stdout);
    expect(probe.gateJson).toBe("");
    expect(probe.hasPackageJson).toBe(true);
  });
});

describe("run script + parse", () => {
  it("embeds the checks to be interpreted, folds stderr, stops at the first failure", async () => {
    const { gate } = await load();
    const s = gate.buildGateRunScript("c", "/work/scratch/x", ["npm test", "node_modules/.bin/tsc --noEmit"]);
    expect(s).toContain("exec 2>&1");
    expect(s).toContain("if npm test; then");
    expect(s).toContain("if node_modules/.bin/tsc --noEmit; then");
    expect(s).toContain('echo "__VIBEHUB_GATE__ fail"');
    expect(s).toContain('echo "__VIBEHUB_GATE__ pass"');
  });

  it("passed only when the pass marker is there and nothing failed", async () => {
    const { gate } = await load();
    expect(gate.parseGateRun("some output\n__VIBEHUB_GATE__ pass\n").passed).toBe(true);
    expect(gate.parseGateRun("boom\n__VIBEHUB_GATE__ fail\n").passed).toBe(false);
    expect(gate.parseGateRun("__VIBEHUB_GATE__ error\n").passed).toBe(false);
    expect(gate.parseGateRun("no marker at all").passed).toBe(false);
    // the marker lines are stripped from what we show
    expect(gate.parseGateRun("kept\n__VIBEHUB_GATE__ pass\n").output).toBe("kept");
  });
});

describe("redaction and tail", () => {
  it("redacts token-looking strings but leaves git SHAs alone", async () => {
    const { gate } = await load();
    const sha = "a".repeat(40);
    const out = gate.redactSecrets(`tok ghp_${"A".repeat(36)} and github_pat_${"B".repeat(30)} and ${sha}`);
    expect(out).toContain("[redacted]");
    expect(out).not.toContain("ghp_A");
    expect(out).not.toContain("github_pat_B");
    expect(out).toContain(sha); // a 40-hex SHA is not redacted
  });

  it("tails to the last bytes with an ellipsis", async () => {
    const { gate } = await load();
    const long = "x".repeat(5000);
    const tailed = gate.tailOutput(long, 100);
    expect(tailed.startsWith("…")).toBe(true);
    expect(Buffer.byteLength(tailed)).toBeLessThan(long.length);
    expect(gate.tailOutput("short", 100)).toBe("short");
  });
});

describe("runGate", () => {
  const wireHost = (probeOut: string, runOut: string) => {
    runScript.mockImplementation(async (script: string) => {
      if (script.includes("__VIBEHUB_GATE_JSON__")) return { stdout: probeOut, stderr: "" };
      return { stdout: runOut, stderr: "" };
    });
  };

  it("returns ran:false (pass-through) when nothing is resolvable — no second round trip", async () => {
    const { gate, registry } = await load();
    const p = await registry.createProject({ name: "billing" });
    const c = await registry.createCard({ projectId: p.id, title: "x" });
    wireHost(["pkg=0", "test=0", "tsconfig=0", "localtsc=0", "__VIBEHUB_GATE_JSON__"].join("\n"), "SHOULD_NOT_RUN");
    const r = await gate.runGate(c.id);
    expect(r).toEqual({ ran: false, passed: true, output: "" });
    expect(runScript).toHaveBeenCalledOnce(); // probe only
  });

  it("runs and passes when the checks are green", async () => {
    const { gate, registry } = await load();
    const p = await registry.createProject({ name: "billing" });
    const c = await registry.createCard({ projectId: p.id, title: "x" });
    wireHost('__VIBEHUB_GATE_JSON__\n{"checks":["npm test"]}', "ran tests\n__VIBEHUB_GATE__ pass\n");
    const r = await gate.runGate(c.id);
    expect(r).toMatchObject({ ran: true, passed: true });
    expect(r.output).toContain("ran tests");
  });

  it("runs and blocks (passed:false) when a check is red", async () => {
    const { gate, registry } = await load();
    const p = await registry.createProject({ name: "billing" });
    const c = await registry.createCard({ projectId: p.id, title: "x" });
    wireHost('__VIBEHUB_GATE_JSON__\n{"checks":["npm test"]}', "1 failing\n__VIBEHUB_GATE__ fail\n");
    const r = await gate.runGate(c.id);
    expect(r).toMatchObject({ ran: true, passed: false });
    expect(r.output).toContain("1 failing");
  });
});
