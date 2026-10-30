import { hostExecutor, shQuote, assertSafeRemotePath } from "../../runtime/host.js";
import { config } from "../../config/env.js";
import {
  getCard, getProject, assertBranchName, listGithubConnections, recordCardPr, markCardPrMerged, type Card, type Project,
} from "../board/registry.js";
import { cardWorkPaths, cardBranch } from "../board/workspace.js";
import { tokenFor } from "../github/client.js";
import { resolveIdentity } from "../github/identity.js";
import { getUserGit } from "../../auth/userGit.js";
import { getSettings } from "../settings/settings.js";
import { assertGhToken } from "../accounts/token.js";
import { runGate, cleanOutput, type GateResult } from "./gate.js";
import { activeReviewFor } from "../review/store.js";
import { logger } from "../../utils/logger.js";

/**
 * DELIVER — "sobe pra X": take a card's branch and ship it, as the card's ACTOR.
 *
 * The whole flow runs SERVER-SIDE and every git/gh command runs in the runner authenticated as the
 * person who sent the card its latest order (falling back to the project's connection) — the token is
 * fetched with `tokenFor(identity.connectionId)` and exported as the script's own `GH_TOKEN` over
 * STDIN, NEVER in argv and never in a log line. `gh` reads it; the push goes through the worktree's
 * credential helper, which reads the card's token file — the same identity, already in place.
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
 *
 * Around the flow for the PR review: once the PR exists it is recorded on the card, one per base
 * (`Card.prs`), and a REVIEWER card (`Card.reviewOf`) is refused up front — it reviews a branch it
 * must never push to. While the card has a review in progress, an `authorized` merge is refused
 * (`review_active`, checked up front and again right before the merge): the only merge of a reviewed
 * PR is the merger's button, which calls this in MERGE-ONLY mode (`mergeOnly`): no push, the PR read
 * as it is, the merge pinned to the commit the reviewer approved (`expectedHeadSha`) — a PR whose head
 * moved comes back as `head_moved` — and run with the MERGER's own connection (`connectionId`), never
 * the card actor's. Merge-only is also a LOCKED card's way out ("the merge belongs to whoever
 * reviews it"), as long as the PR is the one to the card's own base.
 */

export type DeliverReason =
  | "merged"
  | "gate"
  | "locked"
  | "unauthorized"
  | "push_failed"
  | "pr_failed"
  | "merge_failed"
  /** Merge-only: the PR's head is not the commit the review approved (a push after `ready`). */
  | "head_moved"
  /** An authorized merge outside merge-only while the card has a PR review in progress. */
  | "review_active";

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
  /**
   * MERGE-ONLY (the PR review's merge button): no push and no PR creation — the open PR from the
   * card's branch to the target is read as it is, and merged only while its head is `expectedHeadSha`.
   * A push from here would carry commits nobody reviewed into the merge.
   */
  mergeOnly?: boolean;
  /** Merge-only: the full sha the review approved (`Review.reviewedSha`). Required with `mergeOnly`. */
  expectedHeadSha?: string;
  /**
   * The GitHub connection every git/gh step runs as, INSTEAD of the card actor's. The review's merge
   * button passes the merger's own: the merge goes out on their account and their permissions, and a
   * message to the card in the meantime cannot swap the identity under it.
   */
  connectionId?: string;
}

const MARKER = "__VIBEHUB_DELIVER__";
const CI_MARKER = "__VIBEHUB_CI__";

/** A full commit sha (SHA-1, or SHA-256 in a repo that uses it): an abbreviated one could match two commits. */
const FULL_SHA_RE = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i;

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
export function ghTokenPreamble(token: string): string[] {
  return [
    "set -e",
    // This script's OWN credential, never the card's token file: rewriting that file here raced the
    // card's author switch (the next author's pushes would go out with this delivery's token).
    `export GH_TOKEN=${shQuote(assertGhToken(token))}`,
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
    ...ghTokenPreamble(token),
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
 * Merge-only step (a)+(b): NO push — find the open PR from `branch` to `target` and print its head.
 * Filtered by head AND base (a card may have a PR to `dev` and another to `prod` from the same
 * branch; `gh pr view <branch>` would pick either). Emits `__VIBEHUB_DELIVER__ head <url> <sha>`, or
 * `__VIBEHUB_DELIVER__ error <stage>` (`nopr` = no open PR there). PURE.
 */
export function buildResolvePrScript(
  containerName: string, cardId: string, token: string, cwd: string, branch: string, target: string,
): string {
  assertSafeRemotePath(cwd);
  const body = [
    ...ghTokenPreamble(token),
    `cd ${shQuote(cwd)} || { echo "${MARKER} error cwd"; exit 0; }`,
    `if ! J=$(gh pr list --head ${shQuote(branch)} --base ${shQuote(target)} --state open --json url,headRefOid ` +
      `--jq '.[0] // empty | .url + " " + .headRefOid' 2>&1); then`,
    `  printf '%s\\n' "$J"; echo "${MARKER} error view"; exit 0;`,
    `fi`,
    `if [ -z "$J" ]; then echo "${MARKER} error nopr"; exit 0; fi`,
    `echo "${MARKER} head $J"`,
  ];
  return dockerBashScript(containerName, body);
}

/**
 * Script for step (d): merge the PR with a MERGE COMMIT (never squash). With `matchHead`, GitHub
 * itself refuses the merge if the PR's head is no longer that commit — the check and the merge are
 * one call, so a push landing between the gate and the merge cannot slip in. Emits
 * `__VIBEHUB_DELIVER__ merged` or `__VIBEHUB_DELIVER__ error merge`. PURE.
 */
export function buildMergeScript(
  containerName: string, cardId: string, token: string, cwd: string, prUrl: string, matchHead?: string,
): string {
  assertSafeRemotePath(cwd);
  const pin = matchHead ? ` --match-head-commit ${shQuote(matchHead)}` : "";
  const body = [
    ...ghTokenPreamble(token),
    `cd ${shQuote(cwd)} || { echo "${MARKER} error cwd"; exit 0; }`,
    `if gh pr merge ${shQuote(prUrl)} --merge${pin}; then echo "${MARKER} merged"; else echo "${MARKER} error merge"; fi`,
  ];
  return dockerBashScript(containerName, body);
}

/**
 * Script for step (c) when the PR has CI: wait for the PR to point at the pushed commit, read `gh pr
 * checks` until nothing is pending (or the wait runs out), then print the last JSON read and a marker. While checks have not been registered yet,
 * a repo with workflows keeps asking for `CI_APPEAR_SECONDS`; one without stops at once.
 * `headSha` replaces the worktree's HEAD as "the pushed commit" in merge-only mode, where nothing was
 * pushed and the commit that counts is the reviewed one. PURE.
 */
export function buildCiChecksScript(
  containerName: string, cardId: string, token: string, cwd: string, prUrl: string, headSha?: string,
): string {
  assertSafeRemotePath(cwd);
  const rounds = Math.ceil(CI_WAIT_SECONDS / CI_POLL_SECONDS);
  const appearRounds = Math.ceil(CI_APPEAR_SECONDS / CI_POLL_SECONDS);
  const body = [
    ...ghTokenPreamble(token),
    `cd ${shQuote(cwd)} || { echo "${CI_MARKER} error"; exit 0; }`,
    `WF=0; for f in .github/workflows/*.yml .github/workflows/*.yaml; do [ -e "$f" ] && WF=1; done`,
    headSha ? `HEAD=${shQuote(headSha)}` : `HEAD=$(git rev-parse HEAD)`,
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

/** Parses the merge-only PR lookup into the PR url and its head, or a staged error. PURE. */
export function parseResolvePr(
  stdout: string,
): { ok: true; prUrl: string; headSha: string } | { ok: false; stage: string; output: string } {
  const head = new RegExp(`${MARKER} head (\\S+) ([0-9a-fA-F]{40,64})\\b`).exec(stdout);
  if (head && head[1] && head[2]) return { ok: true, prUrl: head[1], headSha: head[2].toLowerCase() };
  const err = new RegExp(`${MARKER} error (\\S+)`).exec(stdout);
  const output = stdout.replace(new RegExp(`${MARKER} (head|error).*`, "g"), "").trimEnd();
  return { ok: false, stage: err?.[1] ?? "unknown", output };
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
 * The head of the card's OPEN PR from `branch` to `base`, as GitHub has it now: what the PR review
 * compares with the commit it approved when the author's turn ends. Read with the card's own
 * connection (the actor's), through the same lookup the merge-only deliver does — nothing is pushed.
 * Null when there is no open PR there or the lookup failed (logged): the caller leaves things as they
 * are, and the merge button still checks the head before merging.
 */
export async function readPrHead(
  cardId: string, branch: string, base: string,
): Promise<{ prUrl: string; headSha: string } | null> {
  try {
    const card = await getCard(cardId);
    const project = card ? await getProject(card.projectId) : undefined;
    if (!card || !project) return null;
    const { cwd } = cardWorkPaths(project, card);
    const token = await cardConnectionToken(card, project);
    const out = await hostExecutor().runScript(
      buildResolvePrScript(config.runner.container, card.id, token, cwd, assertBranchName(branch), assertBranchName(base)),
      { timeoutMs: 60_000 },
    );
    const found = parseResolvePr(out.stdout);
    if (found.ok) return { prUrl: found.prUrl, headSha: found.headSha };
    if (found.stage !== "nopr") {
      logger.warn({ card: card.worktreeSlug, stage: found.stage, detail: cleanOutput(found.output) }, "could not read the PR head");
    }
    return null;
  } catch (err) {
    logger.warn({ card: cardId, detail: (err as Error).message }, "could not read the PR head");
    return null;
  }
}

/**
 * The PR's CI as the gate: its verdict, or null when the PR has no CI checks (the local gate
 * decides). Checks still running past the wait are red — never merged on a guess.
 */
async function ciGate(
  container: string, cardId: string, token: string, cwd: string, prUrl: string, headSha?: string,
): Promise<GateResult | null> {
  const out = await hostExecutor().runScript(
    buildCiChecksScript(container, cardId, token, cwd, prUrl, headSha),
    { timeoutMs: (CI_WAIT_SECONDS + 2 * CI_POLL_SECONDS) * 1000 + 60_000 },
  );
  const ci = parseCiChecks(out.stdout);
  if (ci.verdict === "none") return null;
  return { ran: true, passed: ci.verdict === "pass", output: ci.output };
}

/** The PR number out of its URL (`.../pull/123`); null when the URL is not a pull request's. PURE. */
function prNumberFromUrl(prUrl: string): number | null {
  const m = /\/pull\/(\d+)(?:[/?#]|$)/.exec(prUrl);
  return m ? Number(m[1]) : null;
}

/**
 * Writes the PR on the card (one per base) so the review can start from it. Best-effort: the PR is
 * already open, and a delivery must not come back as a failure because a note about it could not be
 * written — the next delivery of the same base writes it again.
 */
async function rememberPr(card: Card, prUrl: string, base: string, branch: string): Promise<void> {
  const number = prNumberFromUrl(prUrl);
  if (number === null) {
    logger.warn({ card: card.worktreeSlug }, "the PR url has no number — not recorded on the card");
    return;
  }
  try {
    await recordCardPr(card.id, { number, url: prUrl, base, branch });
  } catch (err) {
    logger.warn({ card: card.worktreeSlug, detail: (err as Error).message }, "could not record the PR on the card");
  }
}

/**
 * Marks the card's PR as merged, so the chat stops offering a review of it and the review refuses
 * to start one. Best-effort like {@link rememberPr}: the merge is DONE, and a note about it that
 * could not be written must not turn it into a failure.
 */
async function rememberMerged(card: Card, prUrl: string, base: string): Promise<void> {
  const number = prNumberFromUrl(prUrl);
  if (number === null) return;
  try {
    await markCardPrMerged(card.id, base, number, Date.now());
  } catch (err) {
    logger.warn({ card: card.worktreeSlug, detail: (err as Error).message }, "could not mark the PR as merged on the card");
  }
}

/**
 * Delivers a card: push → PR → gate → (authorized) merge. The gate always runs before the merge, so
 * an unauthorized call still comes back with the truth ("green, ready — say the word"). Merging
 * happens only when `authorized === true` and the gate is green. In merge-only mode the push and the
 * PR creation are replaced by reading the open PR and comparing its head with `expectedHeadSha`.
 */
export async function deliver(cardId: string, opts: DeliverOpts = {}): Promise<DeliverResult> {
  const mergeOnly = opts.mergeOnly === true;
  const expectedHead = mergeOnly ? String(opts.expectedHeadSha ?? "").trim().toLowerCase() : "";
  // Merge-only exists to merge exactly the reviewed commit: without its full sha there is nothing to
  // pin the merge to, and a short one could name two commits.
  if (mergeOnly && !FULL_SHA_RE.test(expectedHead)) {
    throw new Error("mergeOnly requires expectedHeadSha: the full sha of the reviewed commit");
  }
  const card = await getCard(cardId);
  if (!card) throw new Error("card not found");
  // A REVIEWER card (`Card.reviewOf`) never delivers: it was cut from the PR's own branch to read and
  // test it, and a push from here would land on the very branch under review. Refused before the
  // project is looked up, the token fetched or any script run — nothing of this card leaves the runner.
  if (card.reviewOf) {
    logger.info(
      { audit: true, action: "maestro.deliver", card: card.worktreeSlug, merged: false, reason: "locked", reviewOf: card.reviewOf, by: opts.by },
      "deliver refused: this card reviews a PR and never pushes",
    );
    return { merged: false, reason: "locked", branch: card.base, cardBranch: cardBranch(card), locked: true };
  }
  const project = await getProject(card.projectId);
  if (!project) throw new Error("project for this card not found");

  const source = cardBranch(card);
  // A LOCKED card has exactly one exit: a pull request back to the branch it was cut from. The
  // target it was ASKED for is ignored rather than refused — the point of the lock is that the
  // delivery still works, it just cannot land anywhere else. See `Card.locked` in registry.ts.
  const locked = card.locked === true;
  /** Spread into every result so the caller can SAY why the target was not the one it asked for. */
  const lock = (locked ? { locked: true } : {}) as { locked?: true };
  const requested = opts.branch ?? project.baseBranch;
  const target = assertBranchName(locked ? (card.base || project.baseBranch) : requested);
  // A LOCKED card's PR is merged by whoever reviews it: the review's merge button (merge-only) is that
  // exit — but only for the PR back to the card's own base. Any other base is still the lock's "no",
  // said before a single script runs (there is no PR of this card to read there).
  if (locked && mergeOnly && requested !== target) {
    logger.info(
      { audit: true, action: "maestro.deliver", card: card.worktreeSlug, merged: false, reason: "locked", requested, by: opts.by },
      "merge-only refused on a locked card: the PR is not to the card's own base",
    );
    return { merged: false, reason: "locked", branch: target, cardBranch: source, locked: true };
  }
  // A PR under review merges only through the merger's button (merge-only). Any other authorized
  // merge — an agent passing on a "sobe pra dev", the author's own card — is refused before a single
  // script runs. Without `authorized` the delivery goes on: the author pushing fixes IS the review.
  if (opts.authorized === true && !mergeOnly && (await activeReviewFor(card.id))) {
    logger.info(
      { audit: true, action: "maestro.deliver", card: card.worktreeSlug, merged: false, reason: "review_active", by: opts.by },
      "deliver refused to merge: the card has a PR review in progress",
    );
    return {
      merged: false, reason: "review_active", branch: target, cardBranch: source, ...lock,
      output: "este card tem uma revisão de PR em andamento: o merge é o botão do responsável no painel da revisão",
    };
  }
  const { cwd } = cardWorkPaths(project, card);
  const container = config.runner.container;

  const token = opts.connectionId ? await tokenFor(opts.connectionId) : await cardConnectionToken(card, project);

  let prUrl: string;
  if (mergeOnly) {
    // (a)+(b) merge-only: nothing is pushed — the PR is read as GitHub has it.
    const out = await hostExecutor().runScript(
      buildResolvePrScript(container, card.id, token, cwd, source, target),
      { timeoutMs: 120_000 },
    );
    const found = parseResolvePr(out.stdout);
    if (!found.ok) {
      logger.info(
        { audit: true, action: "maestro.deliver", card: card.worktreeSlug, stage: found.stage, merged: false, mergeOnly, by: opts.by },
        "merge-only deliver found no PR to merge",
      );
      return { merged: false, reason: "pr_failed", branch: target, cardBranch: source, ...lock, output: cleanOutput(found.output) || undefined };
    }
    prUrl = found.prUrl;
    if (found.headSha !== expectedHead) {
      logger.info(
        { audit: true, action: "maestro.deliver", card: card.worktreeSlug, merged: false, reason: "head_moved",
          head: found.headSha, reviewed: expectedHead, by: opts.by },
        "merge-only deliver refused: the PR moved past the reviewed commit",
      );
      return {
        prUrl, merged: false, reason: "head_moved", branch: target, cardBranch: source, ...lock,
        output: `o PR está em ${found.headSha.slice(0, 7)}, a revisão aprovou ${expectedHead.slice(0, 7)}`,
      };
    }
  } else {
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
    prUrl = pr.prUrl;
    await rememberPr(card, prUrl, target, source);
  }

  // (c) the gate — the PR's CI when it has one, the local gate otherwise. A gate that errors
  // (runner blip) blocks the merge — deploying past an unknown state is worse than trying again.
  // Merge-only reads the CI of the REVIEWED commit (nothing was pushed, the worktree's HEAD is not it).
  let gate: GateResult;
  try {
    gate = (await ciGate(container, card.id, token, cwd, prUrl, mergeOnly ? expectedHead : undefined)) ?? (await runGate(card.id));
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
  // nothing — on this card the word is not the card's to give. The one exception is the reviewer's
  // own merge: merge-only, already held to the card's base above.
  if (locked && !mergeOnly) {
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
  // The CI wait can take minutes: a review asked for in the meantime still takes the merge away.
  if (!mergeOnly && (await activeReviewFor(card.id))) {
    logger.info(
      { audit: true, action: "maestro.deliver", card: card.worktreeSlug, merged: false, reason: "review_active", by: opts.by },
      "deliver refused to merge: a PR review started while the gate ran",
    );
    return {
      prUrl, merged: false, reason: "review_active", branch: target, cardBranch: source, ...lock,
      output: "uma revisão de PR começou enquanto o gate rodava: o merge é o botão do responsável no painel da revisão",
    };
  }

  const mergeOut = await hostExecutor().runScript(
    buildMergeScript(container, card.id, token, cwd, prUrl, mergeOnly ? expectedHead : undefined),
    { timeoutMs: 120_000 },
  );
  const { merged, output } = parseMerge(mergeOut.stdout);
  logger.info(
    { audit: true, action: "maestro.deliver", card: card.worktreeSlug, merged, target, mergeOnly, by: opts.by },
    merged ? "deliver merged the PR" : "deliver could not merge the PR",
  );
  if (merged) await rememberMerged(card, prUrl, target);
  return {
    prUrl,
    merged,
    reason: merged ? "merged" : "merge_failed",
    branch: target,
    cardBranch: source,
    ...lock,
    output: merged ? undefined : cleanOutput(output),
  };
}
