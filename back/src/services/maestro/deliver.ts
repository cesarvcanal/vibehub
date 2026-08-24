import { hostExecutor, shQuote, assertSafeRemotePath } from "../../runtime/host.js";
import { config } from "../../config/env.js";
import { getCard, getProject, assertBranchName } from "../board/registry.js";
import { cardWorkPaths, cardBranch } from "../board/workspace.js";
import { tokenFor } from "../github/client.js";
import { ghTokenPath, writeGhTokenLines } from "../accounts/token.js";
import { runGate, cleanOutput, type GateResult } from "./gate.js";
import { logger } from "../../utils/logger.js";

/**
 * DELIVER — "sobe pra X": take a card's branch and ship it, as the PROJECT's GitHub connection.
 *
 * The whole flow runs SERVER-SIDE and every git/gh command runs in the runner authenticated as the
 * project's connection — the token is fetched with `tokenFor(project.githubConnectionId)` and passed
 * to the runner over STDIN inside the script (the same per-card `GH_TOKEN` file the card session
 * already uses), NEVER in argv and never in a log line. The runner's git credential helper is
 * `gh auth git-credential`, so a set `GH_TOKEN` steers both `git push` and `gh`.
 *
 * Steps:
 *   a. push the card branch (`--force-with-lease` — the card owns its branch).
 *   b. open a PR to the target branch, or reuse the open one.
 *   c. run the GATE (see gate.ts). If it ran and did not pass, STOP — do not merge.
 *   d. MERGE only when the caller passed `authorized: true` AND the gate is green. A merge commit,
 *      NEVER a squash.
 *
 * `authorized` is the whole safety story: merging is deploying. The maestro persona passes it only
 * when the user named where to ship ("sobe pra dev"), and it is NEVER defaulted to true.
 */

export type DeliverReason =
  | "merged"
  | "gate"
  | "unauthorized"
  | "push_failed"
  | "pr_failed"
  | "merge_failed";

export interface DeliverResult {
  /** URL of the PR — present once (b) resolved one, whether or not it was later merged. */
  prUrl?: string;
  merged: boolean;
  /** Why it ended where it did — "merged" on success, otherwise what stopped it. */
  reason: DeliverReason;
  /** The target branch the PR is against / was merged into. */
  branch: string;
  /** The card's source branch that was pushed. */
  cardBranch: string;
  /** Gate/git output when there is something to show (redacted, tail). */
  output?: string;
}

export interface DeliverOpts {
  /** Target branch to open the PR against and merge into. Absent = the project's base branch. */
  branch?: string;
  /** MUST be exactly true to merge. Anything else stops before the merge. */
  authorized?: boolean;
  by?: string;
}

const MARKER = "__VIBEHUB_DELIVER__";

/** Lines that plant the connection token and export `GH_TOKEN` from it (token over stdin only). PURE. */
function ghTokenPreamble(cardId: string, token: string): string[] {
  return [
    "set -e",
    ...writeGhTokenLines(cardId, token),
    `export GH_TOKEN="$(cat ${shQuote(ghTokenPath(cardId))})"`,
    // From here we handle failures ourselves and fold stderr in, so the output is capturable.
    "set +e",
    "exec 2>&1",
  ];
}

/** Wraps a body of runner-side bash into the `docker exec -i … bash -s` heredoc. PURE. */
function dockerBashScript(containerName: string, body: string[]): string {
  const DELIM = "VIBEHUB_DELIVER";
  return ["set -e", `docker exec -i ${shQuote(containerName)} bash -s <<'${DELIM}'`, ...body, DELIM].join("\n");
}

/**
 * Script for steps (a)+(b): push the branch, then reuse an open PR or create one. Emits
 * `__VIBEHUB_DELIVER__ pr <url>` on success, or `__VIBEHUB_DELIVER__ error <stage>` with the
 * command output above it. Branch names are validated by the caller and shell-quoted here. PURE.
 */
export function buildPushAndPrScript(
  containerName: string, cardId: string, token: string, cwd: string, branch: string, target: string,
): string {
  assertSafeRemotePath(cwd);
  const body = [
    ...ghTokenPreamble(cardId, token),
    `cd ${shQuote(cwd)} || { echo "${MARKER} error cwd"; exit 0; }`,
    `if ! git push --force-with-lease origin ${shQuote(branch)}; then echo "${MARKER} error push"; exit 0; fi`,
    `URL=$(gh pr list --head ${shQuote(branch)} --base ${shQuote(target)} --state open --json url --jq '.[0].url' 2>/dev/null)`,
    `if [ -z "$URL" ]; then`,
    `  if ! CREATE=$(gh pr create --base ${shQuote(target)} --head ${shQuote(branch)} --fill 2>&1); then`,
    `    printf '%s\\n' "$CREATE"; echo "${MARKER} error create"; exit 0;`,
    `  fi`,
    `  URL=$(printf '%s\\n' "$CREATE" | grep -Eo 'https://github.com/[^[:space:]]+/pull/[0-9]+' | tail -1)`,
    `fi`,
    `echo "${MARKER} pr $URL"`,
  ];
  return dockerBashScript(containerName, body);
}

/**
 * Script for step (d): merge the PR with a MERGE COMMIT (never squash). Emits
 * `__VIBEHUB_DELIVER__ merged` or `__VIBEHUB_DELIVER__ error merge`. PURE.
 */
export function buildMergeScript(
  containerName: string, cardId: string, token: string, cwd: string, prUrl: string,
): string {
  assertSafeRemotePath(cwd);
  const body = [
    ...ghTokenPreamble(cardId, token),
    `cd ${shQuote(cwd)} || { echo "${MARKER} error cwd"; exit 0; }`,
    `if gh pr merge ${shQuote(prUrl)} --merge; then echo "${MARKER} merged"; else echo "${MARKER} error merge"; fi`,
  ];
  return dockerBashScript(containerName, body);
}

/** Parses the push+PR output into a resolved PR url or a staged error. PURE. */
export function parsePushAndPr(stdout: string): { ok: true; prUrl: string } | { ok: false; stage: string; output: string } {
  const pr = new RegExp(`${MARKER} pr (\\S+)`).exec(stdout);
  if (pr && pr[1]) return { ok: true, prUrl: pr[1] };
  const err = new RegExp(`${MARKER} error (\\S+)`).exec(stdout);
  const stage = err?.[1] ?? "unknown";
  const output = stdout.replace(new RegExp(`${MARKER} (pr|error).*`, "g"), "").trimEnd();
  return { ok: false, stage, output };
}

/** Parses the merge output. PURE. */
export function parseMerge(stdout: string): { merged: boolean; output: string } {
  const merged = new RegExp(`${MARKER} merged`).test(stdout);
  const output = stdout.replace(new RegExp(`${MARKER} (merged|error).*`, "g"), "").trimEnd();
  return { merged, output };
}

/** Which git stage failed maps to the reason a maestro reads. PURE. */
function reasonForStage(stage: string): DeliverReason {
  return stage === "create" ? "pr_failed" : stage === "push" ? "push_failed" : "pr_failed";
}

/**
 * Delivers a card: push → PR → gate → (authorized) merge. The gate always runs before the merge, so
 * an unauthorized call still comes back with the truth ("green, ready — say the word"). Merging
 * happens only when `authorized === true` and the gate is green.
 */
export async function deliver(cardId: string, opts: DeliverOpts = {}): Promise<DeliverResult> {
  const card = await getCard(cardId);
  if (!card) throw new Error("card not found");
  const project = await getProject(card.projectId);
  if (!project) throw new Error("project for this card not found");

  const source = cardBranch(card);
  const target = assertBranchName(opts.branch ?? project.baseBranch);
  const { cwd } = cardWorkPaths(project, card);
  const container = config.runner.container;

  // The connection token — deliver acts as the project's GitHub identity, or not at all.
  const token = await tokenFor(project.githubConnectionId);

  // (a)+(b) push and resolve the PR.
  const prOut = await hostExecutor().runScript(
    buildPushAndPrScript(container, card.id, token, cwd, source, target),
    { timeoutMs: 120_000 },
  );
  const pr = parsePushAndPr(prOut.stdout);
  if (!pr.ok) {
    logger.info(
      { audit: true, action: "maestro.deliver", card: card.worktreeSlug, stage: pr.stage, merged: false, by: opts.by },
      "deliver stopped before a PR",
    );
    return { merged: false, reason: reasonForStage(pr.stage), branch: target, cardBranch: source, output: cleanOutput(pr.output) };
  }
  const prUrl = pr.prUrl;

  // (c) the gate. A gate that errors (runner blip) blocks the merge — deploying past an unknown
  // state is worse than making the maestro try again.
  let gate: GateResult;
  try {
    gate = await runGate(card.id);
  } catch (err) {
    logger.warn({ card: card.worktreeSlug, detail: (err as Error).message }, "gate could not run — treating as red");
    return { prUrl, merged: false, reason: "gate", branch: target, cardBranch: source, output: (err as Error).message };
  }
  if (gate.ran && !gate.passed) {
    logger.info(
      { audit: true, action: "maestro.deliver", card: card.worktreeSlug, merged: false, gate: "red", by: opts.by },
      "deliver stopped at the gate",
    );
    return { prUrl, merged: false, reason: "gate", branch: target, cardBranch: source, output: gate.output };
  }

  // (d) merge — ONLY when explicitly authorized. Never a default.
  if (opts.authorized !== true) {
    logger.info(
      { audit: true, action: "maestro.deliver", card: card.worktreeSlug, merged: false, reason: "unauthorized", by: opts.by },
      "deliver prepared a PR but was not authorized to merge",
    );
    return { prUrl, merged: false, reason: "unauthorized", branch: target, cardBranch: source };
  }

  const mergeOut = await hostExecutor().runScript(
    buildMergeScript(container, card.id, token, cwd, prUrl),
    { timeoutMs: 120_000 },
  );
  const { merged, output } = parseMerge(mergeOut.stdout);
  logger.info(
    { audit: true, action: "maestro.deliver", card: card.worktreeSlug, merged, target, by: opts.by },
    merged ? "deliver merged the PR" : "deliver could not merge the PR",
  );
  return {
    prUrl,
    merged,
    reason: merged ? "merged" : "merge_failed",
    branch: target,
    cardBranch: source,
    output: merged ? undefined : cleanOutput(output),
  };
}
