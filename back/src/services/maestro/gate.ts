import { hostExecutor, shQuote, assertSafeRemotePath } from "../../runtime/host.js";
import { config } from "../../config/env.js";
import { getCard, getProject } from "../board/registry.js";
import { cardWorkPaths } from "../board/workspace.js";
import { logger } from "../../utils/logger.js";

/**
 * THE GATE — the checks a card's work has to pass before it is delivered.
 *
 * A maestro runs it before merging (`vibehub_deliver`), and it can be run on its own (`vibehub_gate`)
 * to answer "is this green?". It runs the project's OWN checks in the card's worktree, inside the
 * runner, through the host executor — nothing here reaches the host filesystem.
 *
 * WHAT it runs:
 *  - `.vibehub/gate.json` in the worktree, when present: `{ "checks": ["cmd", "cmd", …] }`. Those
 *    commands, in order — the repo decides what "green" means.
 *  - otherwise sensible defaults, each ONLY when it is actually resolvable in the worktree: a
 *    typecheck (`tsc --noEmit`) when there is a tsconfig AND a local tsc, and `npm test` when
 *    package.json declares a `test` script.
 *  - when NEITHER is resolvable, the gate does not run at all: `{ ran: false }`, a pass-through. A
 *    project with no checks configured must not have delivery blocked on a gate it never set up.
 *
 * The core is PURE (resolve checks, build scripts, parse output, redact) with a thin async wrapper
 * that does the two host round trips — exactly so the decision logic is unit-testable without a
 * runner. Output is capped and secret-redacted before it leaves this module: gate logs routinely
 * echo environment, and a token that slipped into a build log must not ride back out in an answer.
 */

export interface GateResult {
  /** false = no checks were resolvable (no gate.json, no default applies) — a pass-through. */
  ran: boolean;
  /** Meaningful only when `ran`: did every check pass? (true when `!ran`, so it never blocks.) */
  passed: boolean;
  /** Tail of the combined output, secret-redacted. Empty when `!ran`. */
  output: string;
}

/** The default typecheck: the worktree's OWN tsc, invoked by path so it needs no network. */
export const DEFAULT_TSC_CHECK = "node_modules/.bin/tsc --noEmit";
/** The default test command: the package's own `test` script. */
export const DEFAULT_TEST_CHECK = "npm test";
/** Cap on how many checks a gate.json may declare — a bound, not a policy. */
export const MAX_GATE_CHECKS = 20;
/** How much of the output to keep, in bytes: enough to see the failure, never a whole build log. */
export const GATE_OUTPUT_TAIL_BYTES = 4_000;

const PROBE_MARKER = "__VIBEHUB_GATE_JSON__";
const RESULT_MARKER = "__VIBEHUB_GATE__";

/** What the probe round trip discovers about a worktree. All facts, no decisions. */
export interface GateProbe {
  /** Contents of `.vibehub/gate.json`, or "" when it does not exist. */
  gateJson: string;
  hasPackageJson: boolean;
  hasTestScript: boolean;
  hasTsconfig: boolean;
  /** A local `node_modules/.bin/tsc` exists (so the default typecheck can run offline). */
  hasLocalTsc: boolean;
}

/**
 * Parses a `.vibehub/gate.json` body into its list of check commands, or null when there is nothing
 * usable (absent, malformed, or `checks` is not a non-empty array of non-empty strings). Non-string
 * and blank entries are dropped; the list is capped. PURE.
 */
export function parseGateConfig(text: string | null | undefined): string[] | null {
  const s = String(text ?? "").trim();
  if (!s) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(s);
  } catch {
    return null;
  }
  const raw = (parsed as { checks?: unknown })?.checks;
  if (!Array.isArray(raw)) return null;
  const checks = raw
    .filter((c): c is string => typeof c === "string")
    .map((c) => c.trim())
    .filter((c) => c.length > 0)
    .slice(0, MAX_GATE_CHECKS);
  return checks.length > 0 ? checks : null;
}

/**
 * Decides WHICH checks the gate runs from what the probe found. gate.json wins; otherwise the
 * defaults, each included only when it is resolvable; otherwise nothing runs (`ran: false`). PURE.
 */
export function resolveGateChecks(probe: GateProbe): { ran: boolean; checks: string[] } {
  const configured = parseGateConfig(probe.gateJson);
  if (configured) return { ran: true, checks: configured };
  const checks: string[] = [];
  if (probe.hasTsconfig && probe.hasLocalTsc) checks.push(DEFAULT_TSC_CHECK);
  if (probe.hasPackageJson && probe.hasTestScript) checks.push(DEFAULT_TEST_CHECK);
  return { ran: checks.length > 0, checks };
}

/**
 * Read-only probe script: prints the four facts as `k=0|1` lines, then a marker, then the raw body
 * of `.vibehub/gate.json` (which may be multi-line and is therefore put last, unbounded). The cwd is
 * validated and passed as `$1`. PURE.
 */
export function buildGateProbeScript(containerName: string, cwd: string): string {
  assertSafeRemotePath(cwd);
  const inner =
    `cd "$1" 2>/dev/null || { echo "pkg=0"; echo "test=0"; echo "tsconfig=0"; echo "localtsc=0"; echo "${PROBE_MARKER}"; exit 0; }; ` +
    `if [ -f package.json ]; then echo "pkg=1"; else echo "pkg=0"; fi; ` +
    `if [ -f package.json ] && grep -Eq '"test"[[:space:]]*:' package.json; then echo "test=1"; else echo "test=0"; fi; ` +
    `if [ -f tsconfig.json ]; then echo "tsconfig=1"; else echo "tsconfig=0"; fi; ` +
    `if [ -x node_modules/.bin/tsc ]; then echo "localtsc=1"; else echo "localtsc=0"; fi; ` +
    `echo "${PROBE_MARKER}"; ` +
    `if [ -f .vibehub/gate.json ]; then cat .vibehub/gate.json; fi`;
  return `docker exec ${shQuote(containerName)} sh -c ${shQuote(inner)} _ ${shQuote(cwd)}`;
}

/** Splits the probe output into its facts and the gate.json body. PURE. */
export function parseGateProbe(stdout: string): GateProbe {
  const idx = stdout.indexOf(PROBE_MARKER);
  const head = idx < 0 ? stdout : stdout.slice(0, idx);
  const gateJson = idx < 0 ? "" : stdout.slice(idx + PROBE_MARKER.length).replace(/^\r?\n/, "");
  const flag = (key: string): boolean => new RegExp(`(?:^|\\n)${key}=1(?:\\r?\\n|$)`).test(head);
  return {
    gateJson,
    hasPackageJson: flag("pkg"),
    hasTestScript: flag("test"),
    hasTsconfig: flag("tsconfig"),
    hasLocalTsc: flag("localtsc"),
  };
}

/**
 * Script that runs the checks in the worktree, in order, STOPPING at the first failure, with stderr
 * folded into stdout. It ends with a `__VIBEHUB_GATE__ pass|fail|error` line the parser reads. The
 * check commands come from the repo (gate.json) or the defaults; they ARE commands, so they are
 * embedded to be interpreted — but the whole inner script is one shell-quoted argument, so nothing
 * in a check can break out of the structure. The cwd is `$1`, validated. PURE.
 */
export function buildGateRunScript(containerName: string, cwd: string, checks: string[]): string {
  assertSafeRemotePath(cwd);
  const parts: string[] = [
    "exec 2>&1",
    `cd "$1" || { echo "${RESULT_MARKER} error"; exit 0; }`,
  ];
  for (const check of checks) {
    parts.push(`printf '\\n=== gate: %s ===\\n' ${shQuote(check)}`);
    parts.push(`if ${check}; then :; else echo "${RESULT_MARKER} fail"; exit 0; fi`);
  }
  parts.push(`echo "${RESULT_MARKER} pass"`);
  const inner = parts.join("; ");
  return `docker exec ${shQuote(containerName)} sh -c ${shQuote(inner)} _ ${shQuote(cwd)}`;
}

/** The verdict from the run output: `pass` only when the pass marker is present and none failed. PURE. */
export function parseGateRun(stdout: string): { passed: boolean; output: string } {
  const passIdx = stdout.lastIndexOf(`${RESULT_MARKER} pass`);
  const failIdx = stdout.lastIndexOf(`${RESULT_MARKER} fail`);
  const errIdx = stdout.lastIndexOf(`${RESULT_MARKER} error`);
  const passed = passIdx >= 0 && failIdx < 0 && errIdx < 0;
  // Strip the marker lines from what we show — they are protocol, not output.
  const output = stdout.replace(new RegExp(`${RESULT_MARKER} (pass|fail|error)\\r?\\n?`, "g"), "").trimEnd();
  return { passed, output };
}

/**
 * Removes token-looking strings from text before it leaves the module: GitHub tokens, Claude OAuth
 * tokens, bearer headers and `x-access-token:` basics. Deliberately conservative — it does NOT touch
 * 40-hex strings, which are almost always git SHAs a reader wants to see. PURE.
 */
export function redactSecrets(text: string): string {
  return String(text ?? "")
    .replace(/gh[pousr]_[A-Za-z0-9]{20,}/g, "[redacted]")
    .replace(/github_pat_[A-Za-z0-9_]{20,}/g, "[redacted]")
    .replace(/sk-ant-[A-Za-z0-9._-]{10,}/g, "[redacted]")
    .replace(/x-access-token:[A-Za-z0-9._-]{10,}/gi, "x-access-token:[redacted]")
    .replace(/\bBearer\s+[A-Za-z0-9._-]{20,}/gi, "Bearer [redacted]");
}

/** Keeps only the last `maxBytes` of text (byte-safe), with a leading ellipsis when it was cut. PURE. */
export function tailOutput(text: string, maxBytes: number = GATE_OUTPUT_TAIL_BYTES): string {
  const buf = Buffer.from(String(text ?? ""), "utf8");
  if (buf.length <= maxBytes) return String(text ?? "");
  return "…\n" + buf.subarray(buf.length - maxBytes).toString("utf8");
}

/** Redact then tail — the single transform applied to any output leaving the gate. PURE. */
export function cleanOutput(text: string): string {
  return tailOutput(redactSecrets(text));
}

/**
 * Runs the gate for a card: probe the worktree, decide the checks, run them. Two host round trips
 * (probe is cheap; the run is where the time goes). A worktree with nothing to check returns
 * `{ ran: false }` without a second round trip.
 */
export async function runGate(cardId: string): Promise<GateResult> {
  const card = await getCard(cardId);
  if (!card) throw new Error("card not found");
  const project = await getProject(card.projectId);
  if (!project) throw new Error("project for this card not found");
  const { cwd } = cardWorkPaths(project, card);
  const container = config.runner.container;

  const probeOut = await hostExecutor().runScript(buildGateProbeScript(container, cwd), { timeoutMs: 30_000 });
  const plan = resolveGateChecks(parseGateProbe(probeOut.stdout));
  if (!plan.ran) {
    logger.info({ audit: true, action: "maestro.gate", card: card.worktreeSlug, ran: false }, "gate had nothing to run");
    return { ran: false, passed: true, output: "" };
  }

  const runOut = await hostExecutor().runScript(buildGateRunScript(container, cwd, plan.checks), { timeoutMs: 600_000 });
  const { passed, output } = parseGateRun(runOut.stdout);
  logger.info(
    { audit: true, action: "maestro.gate", card: card.worktreeSlug, ran: true, passed, checks: plan.checks.length },
    "gate ran",
  );
  return { ran: true, passed, output: cleanOutput(output) };
}
