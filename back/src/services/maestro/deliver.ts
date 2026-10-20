import { hostExecutor, shQuote, assertSafeRemotePath } from "../../runtime/host.js";
import { config } from "../../config/env.js";
import {
  getCard, getProject, assertBranchName, listGithubConnections, type Card, type Project,
} from "../board/registry.js";
import { cardWorkPaths, cardBranch } from "../board/workspace.js";
import { tokenFor } from "../github/client.js";
import { resolveIdentity } from "../github/identity.js";
import { getUserGit } from "../../auth/userGit.js";
import { getSettings } from "../settings/settings.js";
import { ghTokenPath, writeGhTokenLines } from "../accounts/token.js";
import { runGate, cleanOutput, type GateResult } from "./gate.js";
import { logger } from "../../utils/logger.js";

/**
 * DELIVER — "sobe pra X": take a card's branch and ship it, as the card's ACTOR.
 *
 * The whole flow runs SERVER-SIDE and every git/gh command runs in the runner authenticated as the
 * person who worked the card last (falling back to the project's connection, which is what every
 * card did before actors existed) — the token is fetched with `tokenFor(identity.connectionId)` and passed
 * to the runner over STDIN inside the script (the same per-card token file the card's own git and gh
 * read), NEVER in argv and never in a log line. The runner's git credential helper is
 * `gh auth git-credential`, so a set `GH_TOKEN` steers both `git push` and `gh`.
 *
 * Steps:
 *   a. push the card branch (`--force-with-lease` — the card owns its branch).
 *   b. open a PR to the target branch, or reuse the open one.
 *   c. the GATE. When the pull request has GitHub CI checks, THEY are the gate: wait for them (bounded)
 *      and read their verdict — the CI already runs the full suite on a clean machine, and running it
 *      again inside the shared runner duplicated the work and timed out on a loaded box. Without CI
 *      checks, the local gate runs as before (see gate.ts). Red either way: STOP — do not merge.
 *   d. MERGE only when the caller passed `authorized: true` AND the gate is green. A merge commit,
 *      NEVER a squash.
 *
 * `authorized` is the whole safety story: merging is deploying. The maestro persona passes it only
 * when the user named where to ship ("sobe pra dev"), and it is NEVER defaulted to true.
 *
 * A LOCKED CARD (`Card.locked`) overrides all of it: the target is forced to the card's own base,
 * whatever was asked for, and step (d) never runs — the delivery ENDS at the open pull request,
 * with the gate already run, for a reviewer to merge. That is the hotfix shape turned into the only
 * shape that card has.
 */

export type DeliverReason =
  | "merged"
  | "gate"
  | "locked"
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
  /** true = this card is LOCKED to its base: the target was forced and the merge was never on offer. */
  locked?: true;
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
const CI_MARKER = "__VIBEHUB_CI__";

/** How often the CI checks are re-read while some are still running. */
export const CI_POLL_SECONDS = 20;
/** How long the deliver waits for running CI checks before giving up (red, "still running"). */
export const CI_WAIT_SECONDS = 15 * 60;
/**
 * Right after the push GitHub may not have registered the checks yet ("no checks reported"). A repo
 * that HAS workflows gets this long for them to show up before the deliver falls back to the local gate.
 */
export const CI_APPEAR_SECONDS = 2 * 60;

/** Lines that plant the connection token and export `GH_TOKEN` from it (token over stdin only). PURE. */
export function ghTokenPreamble(cardId: string, token: string): string[] {
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

/**
 * Script for step (c) when the PR has CI: wait for the PR to point at the pushed commit, read `gh pr
 * checks` until nothing is pending (or the wait runs out), then print the last JSON read and a marker. While checks have not been registered yet,
 * a repo with workflows keeps asking for `CI_APPEAR_SECONDS`; one without stops at once. PURE.
 */
export function buildCiChecksScript(
  containerName: string, cardId: string, token: string, cwd: string, prUrl: string,
): string {
  assertSafeRemotePath(cwd);
  const rounds = Math.ceil(CI_WAIT_SECONDS / CI_POLL_SECONDS);
  const appearRounds = Math.ceil(CI_APPEAR_SECONDS / CI_POLL_SECONDS);
  const body = [
    ...ghTokenPreamble(cardId, token),
    `cd ${shQuote(cwd)} || { echo "${CI_MARKER} error"; exit 0; }`,
    `WF=0; for f in .github/workflows/*.yml .github/workflows/*.yaml; do [ -e "$f" ] && WF=1; done`,
    `HEAD=$(git rev-parse HEAD)`,
    `i=0`,
    `while :; do`,
    `  i=$((i+1))`,
    // A reused PR moves to the pushed commit a few seconds AFTER the push: until it does, its checks
    // are the OLD head's — a stale green. Read nothing until the PR points at what was pushed.
    `  PH=$(gh pr view ${shQuote(prUrl)} --json headRefOid --jq .headRefOid 2>/dev/null)`,
    `  if [ "$PH" != "$HEAD" ]; then`,
    `    if [ "$i" -lt ${appearRounds} ]; then sleep ${CI_POLL_SECONDS}; continue; fi`,
    `    echo "${CI_MARKER} stale"; exit 0`,
    `  fi`,
    `  J=$(gh pr checks ${shQuote(prUrl)} --json name,bucket 2>&1)`,
    `  case "$J" in`,
    `    *'"bucket":"pending"'*) [ "$i" -lt ${rounds} ] || break ;;`,
    `    *"no checks reported"*) [ "$WF" = 1 ] && [ "$i" -lt ${appearRounds} ] || break ;;`,
    `    *) break ;;`,
    `  esac`,
    `  sleep ${CI_POLL_SECONDS}`,
    `done`,
    `printf '%s\n' "$J"`,
    `echo "${CI_MARKER} done"`,
  ];
  return dockerBashScript(containerName, body);
}

/**
 * The CI verdict from what `gh pr checks --json name,bucket` printed:
 *  - `none`: no checks on the PR (or the answer was unreadable) — the local gate decides;
 *  - `pass`: every check passed or was skipped;
 *  - `fail`: some check failed or was cancelled (named in `output`);
 *  - `pending`: checks still running when the wait ran out, or the PR never moved to the pushed
 *    commit (`stale`) — red either way. PURE.
 */
export function parseCiChecks(stdout: string): { verdict: "none" | "pass" | "fail" | "pending"; output: string } {
  if (stdout.includes(`${CI_MARKER} stale`)) {
    return { verdict: "pending", output: "o PR ainda não aponta para o commit enviado — o CI dele não foi lido" };
  }
  const body = stdout.replace(new RegExp(`${CI_MARKER} \\S+.*`, "g"), "").trim();
  const start = body.indexOf("[");
  let checks: { name?: string; bucket?: string }[] | null = null;
  if (start >= 0) {
    try {
      const parsed: unknown = JSON.parse(body.slice(start));
      if (Array.isArray(parsed)) checks = parsed as { name?: string; bucket?: string }[];
    } catch { /* not the JSON we asked for */ }
  }
  if (!checks || checks.length === 0) return { verdict: "none", output: "" };
  const named = (buckets: string[]) => checks!.filter((c) => buckets.includes(String(c.bucket))).map((c) => c.name || "?");
  const failed = named(["fail", "cancel"]);
  if (failed.length) return { verdict: "fail", output: `CI do PR vermelho: ${failed.join(", ")}` };
  const pending = named(["pending"]);
  if (pending.length) return { verdict: "pending", output: `CI do PR ainda rodando: ${pending.join(", ")}` };
  return { verdict: "pass", output: `CI do PR verde: ${checks.map((c) => c.name || "?").join(", ")}` };
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
 * The connection token of the identity IN FORCE on this card: the ACTOR's (whoever worked it last),
 * falling back to the project's and the install's — the SAME resolution the card's open uses, so a
 * PR opens (or is read) under the account whose name is already on the commits. A card with no actor
 * behaves exactly as before: the project's connection.
 */
export async function cardConnectionToken(card: Card, project: Project): Promise<string> {
  const actor = card.actorUserId ? await getUserGit(card.actorUserId) : null;
  const identity = resolveIdentity({
    actor, project, settings: await getSettings(), connections: await listGithubConnections(),
  });
  return await tokenFor(identity.connectionId);
}

/**
 * The PR's CI as the gate: its verdict, or null when the PR has no CI checks (the local gate
 * decides). Checks still running past the wait are red — never merged on a guess.
 */
async function ciGate(container: string, cardId: string, token: string, cwd: string, prUrl: string): Promise<GateResult | null> {
  const out = await hostExecutor().runScript(
    buildCiChecksScript(container, cardId, token, cwd, prUrl),
    { timeoutMs: (CI_WAIT_SECONDS + 2 * CI_POLL_SECONDS) * 1000 + 60_000 },
  );
  const ci = parseCiChecks(out.stdout);
  if (ci.verdict === "none") return null;
  return { ran: true, passed: ci.verdict === "pass", output: ci.output };
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
  // A LOCKED card has exactly one exit: a pull request back to the branch it was cut from. The
  // target it was ASKED for is ignored rather than refused — the point of the lock is that the
  // delivery still works, it just cannot land anywhere else. See `Card.locked` in registry.ts.
  const locked = card.locked === true;
  /** Spread into every result so the caller can SAY why the target was not the one it asked for. */
  const lock = (locked ? { locked: true } : {}) as { locked?: true };
  const target = assertBranchName(locked ? (card.base || project.baseBranch) : (opts.branch ?? project.baseBranch));
  const { cwd } = cardWorkPaths(project, card);
  const container = config.runner.container;

  const token = await cardConnectionToken(card, project);

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
    return { merged: false, reason: reasonForStage(pr.stage), branch: target, cardBranch: source, ...lock, output: cleanOutput(pr.output) };
  }
  const prUrl = pr.prUrl;

  // (c) the gate — the PR's CI when it has one, the local gate otherwise. A gate that errors
  // (runner blip) blocks the merge — deploying past an unknown state is worse than trying again.
  let gate: GateResult;
  try {
    gate = (await ciGate(container, card.id, token, cwd, prUrl)) ?? (await runGate(card.id));
  } catch (err) {
    logger.warn({ card: card.worktreeSlug, detail: (err as Error).message }, "gate could not run — treating as red");
    return { prUrl, merged: false, reason: "gate", branch: target, cardBranch: source, ...lock, output: (err as Error).message };
  }
  if (gate.ran && !gate.passed) {
    logger.info(
      { audit: true, action: "maestro.deliver", card: card.worktreeSlug, merged: false, gate: "red", by: opts.by },
      "deliver stopped at the gate",
    );
    return { prUrl, merged: false, reason: "gate", branch: target, cardBranch: source, ...lock, output: gate.output };
  }

  // (d) merge. A LOCKED card never gets here on purpose: its delivery IS the open pull request, and
  // the merge belongs to whoever reviews it. Said before the `authorized` check so that an
  // `authorized: true` (an agent that read the user's "sobe pra dev" and passed it along) changes
  // nothing — on this card the word is not the card's to give.
  if (locked) {
    logger.info(
      { audit: true, action: "maestro.deliver", card: card.worktreeSlug, merged: false, reason: "locked", by: opts.by },
      "deliver opened a PR on a locked card — merging is the reviewer's",
    );
    return { prUrl, merged: false, reason: "locked", branch: target, cardBranch: source, locked: true };
  }
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
