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
      headSha: null, cleanTree: false,
    });
  });

  it("reads the worktree's HEAD and whether the tree is clean (untracked files count as dirty)", async () => {
    const { gate } = await load();
    const s = gate.buildGateProbeScript("vibehub-runner", "/work/scratch/x");
    expect(s).toContain("git rev-parse HEAD");
    expect(s).toContain("git status --porcelain --untracked-files=all");
    const sha = "a".repeat(40);
    const head = ["pkg=1", "test=1", "tsconfig=0", "localtsc=0"];
    const clean = gate.parseGateProbe([...head, `head=${sha}`, "clean=1", "__VIBEHUB_GATE_JSON__"].join("\n"));
    expect(clean).toMatchObject({ headSha: sha, cleanTree: true });
    const dirty = gate.parseGateProbe([...head, `head=${sha}`, "clean=0", "__VIBEHUB_GATE_JSON__"].join("\n"));
    expect(dirty).toMatchObject({ headSha: sha, cleanTree: false });
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

describe("runGate reuses a GREEN verdict for the same commit on a clean tree", () => {
  // The delivery flow asks the gate the same question two or three times in a row (deliver without
  // authorization, then with it) — minutes of typecheck + tests each, on an unchanged commit.
  const SHA_A = "a".repeat(40);
  const SHA_B = "b".repeat(40);
  const probeOut = (sha: string, clean: boolean, checks = '{"checks":["npm test"]}') =>
    [`head=${sha}`, `clean=${clean ? 1 : 0}`, "__VIBEHUB_GATE_JSON__", checks].join("\n");
  let probes: string[] = [];
  let runs: string[] = [];
  const isRun = (s: string) => s.includes('echo "__VIBEHUB_GATE__ pass"');
  const wireHost = (verdicts: string[] = ["pass"]) => {
    runScript.mockImplementation(async (script: string) => {
      if (script.includes("__VIBEHUB_GATE_JSON__") && !isRun(script)) {
        return { stdout: probes.shift() ?? "", stderr: "" };
      }
      runs.push(script);
      const verdict = verdicts[Math.min(runs.length - 1, verdicts.length - 1)];
      return { stdout: `tests ran\n__VIBEHUB_GATE__ ${verdict}\n`, stderr: "" };
    });
  };
  async function cardFor() {
    const { gate, registry } = await load();
    const p = await registry.createProject({ name: "billing" });
    const c = await registry.createCard({ projectId: p.id, title: "x" });
    probes = [];
    runs = [];
    return { gate, card: c };
  }
  afterEach(() => { vi.useRealTimers(); });

  it("same HEAD, clean tree, green moments ago: the second call does not run the checks again", async () => {
    const { gate, card } = await cardFor();
    probes = [probeOut(SHA_A, true), probeOut(SHA_A, true)];
    wireHost();
    const first = await gate.runGate(card.id);
    const second = await gate.runGate(card.id);
    expect(runs).toHaveLength(1);
    expect(first).toMatchObject({ ran: true, passed: true });
    expect(second).toMatchObject({ ran: true, passed: true, reused: true });
    expect(second.output).toContain("tests ran");
  });

  it("a new commit runs the checks again", async () => {
    const { gate, card } = await cardFor();
    probes = [probeOut(SHA_A, true), probeOut(SHA_B, true)];
    wireHost();
    await gate.runGate(card.id);
    await gate.runGate(card.id);
    expect(runs).toHaveLength(2);
  });

  it("a dirty tree (edits or untracked files) never reuses, before or after", async () => {
    const { gate, card } = await cardFor();
    probes = [probeOut(SHA_A, true), probeOut(SHA_A, false), probeOut(SHA_A, false)];
    wireHost();
    await gate.runGate(card.id);
    await gate.runGate(card.id);
    await gate.runGate(card.id);
    expect(runs).toHaveLength(3);
  });

  it("a RED verdict is never reused — the next call runs again, and its green is what counts", async () => {
    const { gate, card } = await cardFor();
    probes = [probeOut(SHA_A, true), probeOut(SHA_A, true)];
    wireHost(["fail", "pass"]);
    expect(await gate.runGate(card.id)).toMatchObject({ passed: false });
    expect(await gate.runGate(card.id)).toMatchObject({ passed: true });
    expect(runs).toHaveLength(2);
  });

  it("any red run drops the card's older green — going back to that commit runs again", async () => {
    const { gate, card } = await cardFor();
    probes = [probeOut(SHA_A, true), probeOut(SHA_B, true), probeOut(SHA_A, true)];
    wireHost(["pass", "fail", "pass"]);
    await gate.runGate(card.id);
    await gate.runGate(card.id); // another commit, red
    await gate.runGate(card.id); // back on A: the old green is gone
    expect(runs).toHaveLength(3);
  });

  it("a different resolved check list on the same commit runs again", async () => {
    const { gate, card } = await cardFor();
    probes = [probeOut(SHA_A, true), probeOut(SHA_A, true, '{"checks":["npm test","npm run lint"]}')];
    wireHost();
    await gate.runGate(card.id);
    await gate.runGate(card.id);
    expect(runs).toHaveLength(2);
  });

  it("an old green expires: past the reuse window the checks run again", async () => {
    const { gate, card } = await cardFor();
    probes = [probeOut(SHA_A, true), probeOut(SHA_A, true)];
    wireHost();
    vi.useFakeTimers({ toFake: ["Date"] });
    await gate.runGate(card.id);
    vi.setSystemTime(Date.now() + gate.GATE_REUSE_MS + 1);
    await gate.runGate(card.id);
    expect(runs).toHaveLength(2);
  });

  it("a worktree that is not a git repo (no HEAD) never reuses", async () => {
    const { gate, card } = await cardFor();
    probes = ['__VIBEHUB_GATE_JSON__\n{"checks":["npm test"]}', '__VIBEHUB_GATE_JSON__\n{"checks":["npm test"]}'];
    wireHost();
    await gate.runGate(card.id);
    await gate.runGate(card.id);
    expect(runs).toHaveLength(2);
  });
});
