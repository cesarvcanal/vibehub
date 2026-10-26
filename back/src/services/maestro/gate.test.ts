import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
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
    // the checks run with the test-worker cap, set before the first one
    expect(s.indexOf("export VITEST_MAX_THREADS=2;")).toBeGreaterThan(-1);
    expect(s.indexOf("export VITEST_MAX_THREADS=2;")).toBeLessThan(s.indexOf("if npm test"));
  });

  it("the generated script is valid sh and actually runs the checks", async () => {
    // Asserting on substrings let `export …;; printf` through: every gate died on a sh syntax error
    // in ~100 ms, red with no output. So run it, with a `docker` that just executes in place.
    const { gate } = await load();
    const bin = await mkdtemp(join(tmpdir(), "vibehub-gate-bin-"));
    const work = await mkdtemp(join(tmpdir(), "vibehub-gate-work-"));
    try {
      await writeFile(join(bin, "docker"), '#!/bin/sh\nshift 2\nexec "$@"\n', { mode: 0o755 });
      const env = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
      const run = (checks: string[]) =>
        execFileSync("sh", ["-c", gate.buildGateRunScript("c", work, checks, { baseBranch: "main" })], { env, encoding: "utf8" });
      const green = run(['echo "base=$VIBEHUB_BASE_REF cap=$VITEST_MAX_THREADS"']);
      expect(green).toContain("base=origin/main cap=2");
      expect(gate.parseGateRun(green).passed).toBe(true);
      const red = run(["echo boom >&2; false", "echo never"]);
      expect(gate.parseGateRun(red)).toMatchObject({ passed: false });
      expect(red).toContain("boom");
      expect(red).not.toContain("never");
    } finally {
      await rm(bin, { recursive: true, force: true });
      await rm(work, { recursive: true, force: true });
    }
  });

  it("a run that never reached the checks says so instead of coming back empty", async () => {
    const { gate } = await load();
    const r = gate.parseGateRun("");
    expect(r.passed).toBe(false);
    expect(r.output).toContain("não chegou a rodar");
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

  it("runs the checks under an in-container deadline that kills the whole group", async () => {
    const { gate } = await load();
    const s = gate.buildGateRunScript("c", "/work/scratch/x", ["npm test"], { timeoutMs: 600_000 });
    expect(s).toMatch(/^docker exec 'c' timeout -s KILL 585 sh -c /);
    expect(s).toContain('if [ $? -eq 137 ]; then echo "__VIBEHUB_GATE__ timeout 585"; fi');
    expect(() => gate.buildGateRunScript("c", "/work/scratch/x", ["npm test"], { timeoutMs: 10_000 })).toThrow();
  });

  it("exposes the card's base as VIBEHUB_BASE_REF, validated, before the checks", async () => {
    const { gate } = await load();
    const s = gate.buildGateRunScript("c", "/work/scratch/x", ["npm test"], { baseBranch: "main" });
    expect(s).toContain("export VIBEHUB_BASE_REF='\\''origin/main'\\''");
    expect(s.indexOf("VIBEHUB_BASE_REF")).toBeLessThan(s.indexOf("if npm test"));
    expect(gate.buildGateRunScript("c", "/work/scratch/x", ["npm test"])).not.toContain("VIBEHUB_BASE_REF");
    expect(() => gate.buildGateRunScript("c", "/work/scratch/x", ["npm test"], { baseBranch: "main; rm -rf /" })).toThrow();
  });

  it("a timed-out run is red, flagged, and says why", async () => {
    const { gate } = await load();
    const r = gate.parseGateRun("RUN v1\n__VIBEHUB_GATE__ timeout 585\n");
    expect(r).toMatchObject({ passed: false, timedOut: true });
    expect(r.output).toContain("RUN v1");
    expect(r.output).toContain("prazo de 585s");
    expect(r.output).not.toContain("__VIBEHUB_GATE__");
    expect(gate.parseGateRun("x\n__VIBEHUB_GATE__ pass\n").timedOut).toBe(false);
  });
});

describe("runGate under load", () => {
  const probe = '__VIBEHUB_GATE_JSON__\n{"checks":["npm test"]}';
  const isRun = (s: string) => s.includes('echo "__VIBEHUB_GATE__ pass"');

  it("a second call for the same card while its gate runs joins it — one suite, one answer", async () => {
    const { gate, registry } = await load();
    const p = await registry.createProject({ name: "billing" });
    const c = await registry.createCard({ projectId: p.id, title: "x" });
    let finish!: () => void;
    let runs = 0;
    runScript.mockImplementation(async (script: string) => {
      if (!isRun(script)) return { stdout: probe, stderr: "" };
      runs++;
      await new Promise<void>((r) => { finish = r; });
      return { stdout: "ok\n__VIBEHUB_GATE__ pass\n", stderr: "" };
    });
    const a = gate.runGate(c.id);
    const b = gate.runGate(c.id);
    await vi.waitFor(() => expect(runs).toBe(1));
    finish();
    expect(await a).toMatchObject({ passed: true });
    expect(await b).toBe(await a);
    expect(runs).toBe(1);
  });

  it("caps runs across cards at GATE_MAX_CONCURRENT; the next starts when one ends, even if it failed", async () => {
    const { gate, registry } = await load();
    const p = await registry.createProject({ name: "billing" });
    const cards = [];
    for (let i = 0; i < gate.GATE_MAX_CONCURRENT + 1; i++) cards.push(await registry.createCard({ projectId: p.id, title: `c${i}` }));
    let active = 0;
    let peak = 0;
    const releases: Array<(fail: boolean) => void> = [];
    runScript.mockImplementation(async (script: string) => {
      if (!isRun(script)) return { stdout: probe, stderr: "" };
      active++;
      peak = Math.max(peak, active);
      const fail = await new Promise<boolean>((r) => releases.push(r));
      active--;
      if (fail) throw new Error("host command timed out");
      return { stdout: "__VIBEHUB_GATE__ pass\n", stderr: "" };
    });
    const results = cards.map((c) => gate.runGate(c.id).catch((e: Error) => e.message));
    await vi.waitFor(() => expect(releases).toHaveLength(gate.GATE_MAX_CONCURRENT));
    await new Promise((r) => setTimeout(r, 20));
    expect(releases).toHaveLength(gate.GATE_MAX_CONCURRENT); // the last one is queued
    releases[0](true); // a host failure still frees the slot
    await vi.waitFor(() => expect(releases).toHaveLength(gate.GATE_MAX_CONCURRENT + 1));
    releases.slice(1).forEach((r) => r(false));
    const out = await Promise.all(results);
    expect(out.filter((o) => o === "host command timed out")).toHaveLength(1);
    expect(out.filter((o) => typeof o === "object" && o.passed)).toHaveLength(gate.GATE_MAX_CONCURRENT);
    expect(peak).toBe(gate.GATE_MAX_CONCURRENT);
  });

  it("a timed-out run comes back red with timedOut", async () => {
    const { gate, registry } = await load();
    const p = await registry.createProject({ name: "billing" });
    const c = await registry.createCard({ projectId: p.id, title: "x" });
    runScript.mockImplementation(async (script: string) =>
      isRun(script) ? { stdout: "slow\n__VIBEHUB_GATE__ timeout 585\n", stderr: "" } : { stdout: probe, stderr: "" });
    expect(await gate.runGate(c.id)).toMatchObject({ ran: true, passed: false, timedOut: true });
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

  it("a run that died before the checks brings its stderr back", async () => {
    const { gate, registry } = await load();
    const p = await registry.createProject({ name: "billing" });
    const c = await registry.createCard({ projectId: p.id, title: "x" });
    runScript.mockImplementation(async (script: string) =>
      script.includes("__VIBEHUB_GATE_JSON__")
        ? { stdout: '__VIBEHUB_GATE_JSON__\n{"checks":["npm test"]}', stderr: "" }
        : { stdout: "", stderr: 'sh: 1: Syntax error: ";;" unexpected\n' });
    const r = await gate.runGate(c.id);
    expect(r).toMatchObject({ ran: true, passed: false });
    expect(r.output).toContain("Syntax error");
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
