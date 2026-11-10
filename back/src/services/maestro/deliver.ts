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
import {
  validatePrDocs, canOpenPr, undocumentedOutput, freshComments, reviewPayload,
  type PrDocs, type CleanPrDocs, type CleanComment, type PostedComment,
} from "./prDocs.js";
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
 *   a. push the card branch (`--force-with-lease` — the card owns its branch; a branch the last merge
 *      deleted on GitHub goes up again, see forgetDeletedRemoteBranch).
 *   b. open a PR to the target branch, or reuse the open one. A NEW PR opens only DOCUMENTED (prDocs.ts):
 *      title, a body with every section of the team's standard, and comments on the diff — otherwise
 *      the branch is pushed and the delivery stops at `undocumented`. Then the comments go up as one
 *      COMMENT review on the pushed commit (those already on the PR are skipped).
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
  | "review_active"
  /** Push-only: the branch went to the PR; nothing else was asked. */
  | "pushed"
  /** No PR opened: its documentation is missing or invalid (prDocs.ts). The branch may have been pushed. */
  | "undocumented"
  /** The PR is open, but GitHub refused its comments (a line outside the diff, say). Nothing merged. */
  | "comments_failed";

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
  /**
   * After a merge, what became of the card's branch on GitHub: `deleted` (the work is in the base
   * now), `kept` (another open PR still comes from it, or it is the repo's default branch — deleting
   * it would close that PR), or `failed` (the merge stands; the branch is just still there).
   */
  headBranch?: "deleted" | "kept" | "failed";
  /**
   * The comments on the diff this delivery was given: how many went up, how many were already on the PR,
   * and how many the call itself repeated (same file and text twice — posted once).
   */
  comments?: { posted: number; skipped: number; repeated?: number };
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
  /**
   * PUSH-ONLY: push the branch and open (or reuse) the PR, then stop — no gate, no merge. How a card
   * whose PR is under review delivers a fix (`deliverCard`, services/review/deliverCard.ts).
   */
  pushOnly?: boolean;
  /** Merge-only: the full sha the review approved (`Review.reviewedSha`). Required with `mergeOnly`. */
  expectedHeadSha?: string;
  /**
   * The GitHub connection every git/gh step runs as, INSTEAD of the card actor's. The review's merge
   * button passes the merger's own: the merge goes out on their account and their permissions, and a
   * message to the card in the meantime cannot swap the identity under it.
   */
  connectionId?: string;
  /**
   * The PR's documentation, written by the AI that did the work: required to OPEN a new PR (title, body
   * and comments), optional on an existing one (rewrites its title/body, adds the comments). Ignored in
   * merge-only, which writes nothing.
   */
  docs?: PrDocs;
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
 * Bash line run right before the push: when `branch` no longer exists on the remote, drop the local
 * `origin/<branch>`. A merge deletes the card's branch on GitHub ({@link afterPrMerged}), but the
 * worktree keeps its remote-tracking ref at the old head; `--force-with-lease` leases against that
 * ref, finds nothing on the remote and refuses with "stale info" — so a card that goes on working
 * after its PR merged could never push again. `ls-remote --exit-code` answers 2 only for "no such
 * ref": a branch that still exists (even moved by someone else) keeps its ref and its lease, and a
 * network failure changes nothing (the push then fails as it would). PURE.
 */
export function forgetDeletedRemoteBranch(branch: string): string {
  // The FULL ref: a bare name is a pattern matched against the END of every ref, so another branch
  // like `feature/<branch>` would answer "exists" and keep the stale ref.
  const remote = shQuote(`refs/heads/${branch}`);
  const tracking = shQuote(`refs/remotes/origin/${branch}`);
  return `git ls-remote --exit-code origin ${remote} >/dev/null 2>&1; if [ $? -eq 2 ]; then git update-ref -d ${tracking}; fi`;
}

/**
 * Free text (a PR title, body or review payload) as a shell expression that rebuilds it in the runner:
 * the text travels base64-encoded, so quotes, `$(…)`, backticks or a line equal to the heredoc
 * delimiter are never shell source. PURE.
 */
function decoded(text: string): string {
  return `printf '%s' '${Buffer.from(text, "utf8").toString("base64")}' | base64 -d`;
}

/**
 * Script for steps (a)+(b): push the branch, then reuse an open PR or create one. Emits
 * `__VIBEHUB_DELIVER__ pr <url>` on success, or `__VIBEHUB_DELIVER__ error <stage>` with the
 * command output above it. Branch names are validated by the caller and shell-quoted here.
 *
 * The PR's text comes from `docs` (already validated, prDocs.ts) — never `--fill`, whose body is the
 * list of commits. No open PR and not enough to open a documented one: `error undocumented`, after the
 * push. An open PR is reused; given a title or body, it is rewritten with them (`gh pr edit`). PURE.
 */
export function buildPushAndPrScript(
  containerName: string, cardId: string, token: string, cwd: string, branch: string, target: string,
  docs: CleanPrDocs = { comments: [] },
): string {
  assertSafeRemotePath(cwd);
  const textFlags = [
    docs.title !== undefined ? `--title "$TITLE"` : "",
    docs.body !== undefined ? `--body-file "$BODY"` : "",
  ].filter(Boolean).join(" ");
  const open = canOpenPr(docs)
    ? [
      `  if ! CREATE=$(gh pr create --base ${shQuote(target)} --head ${shQuote(branch)} ${textFlags} 2>&1); then`,
      `    printf '%s\\n' "$CREATE"; echo "${MARKER} error create"; exit 0;`,
      `  fi`,
      `  URL=$(printf '%s\\n' "$CREATE" | grep -Eo 'https://github.com/[^[:space:]]+/pull/[0-9]+' | tail -1)`,
    ]
    : [`  echo "${MARKER} error undocumented"; exit 0`];
  const edit = textFlags
    ? [
      `else`,
      `  if ! EDIT=$(gh pr edit "$URL" ${textFlags} 2>&1); then`,
      // The PR is open: the marker names it, so the delivery still records it and answers with its url.
      `    printf '%s\\n' "$EDIT"; echo "${MARKER} error edit $URL"; exit 0;`,
      `  fi`,
    ]
    : [];
  const body = [
    ...ghTokenPreamble(token),
    `cd ${shQuote(cwd)} || { echo "${MARKER} error cwd"; exit 0; }`,
    forgetDeletedRemoteBranch(branch),
    `if ! git push --force-with-lease origin ${shQuote(branch)}; then echo "${MARKER} error push"; exit 0; fi`,
    ...(docs.title !== undefined ? [`TITLE=$(${decoded(docs.title)})`] : []),
    ...(docs.body !== undefined ? [`BODY=$(mktemp)`, `trap 'rm -f "$BODY"' EXIT`, `${decoded(docs.body)} > "$BODY"`] : []),
    `URL=$(gh pr list --head ${shQuote(branch)} --base ${shQuote(target)} --state open --json url --jq '.[0].url' 2>/dev/null)`,
    `if [ -z "$URL" ]; then`,
    ...open,
    ...edit,
    `fi`,
    `echo "${MARKER} pr $URL"`,
  ];
  return dockerBashScript(containerName, body);
}

/** How long the comments step waits for the PR to point at the pushed commit (rounds × seconds). */
const COMMENTS_HEAD_ROUNDS = 12;
const COMMENTS_HEAD_POLL_SECONDS = 5;

/**
 * Before commenting: wait (bounded) for the PR to point at the commit just pushed — the comment lines
 * belong to THAT diff, and a reused PR moves to it a few seconds after the push. "Just pushed" is the
 * tip of `branch` (what the push sent), not the worktree's HEAD, which may be on something else. Then list the review
 * comments already on the PR, so a repeated delivery does not post them again. Emits
 * `__VIBEHUB_DELIVER__ prcomments <head> <base64 of JSON lines {path, body}>` (`tojson`: one comment per
 * line whatever gh's own formatting, a body's newlines escaped), or `error stale` /
 * `error comments`. PURE.
 */
export function buildPrCommentsReadScript(
  containerName: string, cardId: string, token: string, cwd: string, prUrl: string, branch: string,
): string {
  assertSafeRemotePath(cwd);
  const pr = parsePrUrl(prUrl);
  if (!pr) throw new Error(`not a GitHub PR url: ${prUrl}`);
  const body = [
    ...ghTokenPreamble(token),
    `cd ${shQuote(cwd)} || { echo "${MARKER} error cwd"; exit 0; }`,
    `HEAD=$(git rev-parse ${shQuote(`refs/heads/${branch}`)})`,
    `i=0`,
    `while :; do`,
    `  i=$((i+1))`,
    `  PH=$(gh pr view ${shQuote(prUrl)} --json headRefOid --jq .headRefOid 2>/dev/null)`,
    `  [ "$PH" = "$HEAD" ] && break`,
    `  if [ "$i" -ge ${COMMENTS_HEAD_ROUNDS} ]; then echo "${MARKER} error stale"; exit 0; fi`,
    `  sleep ${COMMENTS_HEAD_POLL_SECONDS}`,
    `done`,
    `if ! J=$(gh api ${shQuote(`repos/${pr.repo}/pulls/${pr.number}/comments`)} --paginate --jq '.[] | {path, body} | tojson' 2>&1); then`,
    `  printf '%s\\n' "$J"; echo "${MARKER} error comments"; exit 0;`,
    `fi`,
    `echo "${MARKER} prcomments $HEAD $(printf '%s' "$J" | base64 -w0)"`,
  ];
  return dockerBashScript(containerName, body);
}

/** Parses the comments lookup: the pushed head and the comments already on the PR. PURE. */
export function parsePrComments(
  stdout: string,
): { ok: true; head: string; posted: PostedComment[] } | { ok: false; stage: string; output: string } {
  const m = new RegExp(`${MARKER} prcomments ([0-9a-fA-F]{40,64}) ?([A-Za-z0-9+/=]*)`).exec(stdout);
  if (m) {
    try {
      const posted = Buffer.from(m[2] ?? "", "base64").toString("utf8").split("\n").filter((l) => l.trim())
        .map((l) => JSON.parse(l) as { path?: unknown; body?: unknown })
        .map((c) => ({ path: String(c?.path ?? ""), body: String(c?.body ?? "") }));
      return { ok: true, head: m[1]!.toLowerCase(), posted };
    } catch {
      return { ok: false, stage: "comments", output: "a lista de comentários do PR veio ilegível" };
    }
  }
  const err = new RegExp(`${MARKER} error (\\S+)`).exec(stdout);
  const output = stdout.replace(new RegExp(`${MARKER} (prcomments|error).*`, "g"), "").trim();
  return { ok: false, stage: err?.[1] ?? "unknown", output };
}

/**
 * Posts ONE review with the comments (`POST /pulls/{n}/reviews`, event COMMENT). The payload travels
 * base64-encoded into a temp file read by `gh api --input`. GitHub takes all of the comments or none
 * (a line outside the diff refuses the whole review), so a failure leaves nothing half-posted. Emits
 * `__VIBEHUB_DELIVER__ review ok` or `error review` with GitHub's answer above it. PURE.
 */
export function buildPrReviewScript(
  containerName: string, cardId: string, token: string, cwd: string, prUrl: string, payload: unknown,
): string {
  assertSafeRemotePath(cwd);
  const pr = parsePrUrl(prUrl);
  if (!pr) throw new Error(`not a GitHub PR url: ${prUrl}`);
  const body = [
    ...ghTokenPreamble(token),
    `cd ${shQuote(cwd)} || { echo "${MARKER} error cwd"; exit 0; }`,
    `F=$(mktemp)`,
    `trap 'rm -f "$F"' EXIT`,
    `${decoded(JSON.stringify(payload))} > "$F"`,
    `if OUT=$(gh api --method POST ${shQuote(`repos/${pr.repo}/pulls/${pr.number}/reviews`)} --input "$F" 2>&1); then`,
    `  echo "${MARKER} review ok"`,
    `else`,
    `  printf '%s\\n' "$OUT"; echo "${MARKER} error review"`,
    `fi`,
  ];
  return dockerBashScript(containerName, body);
}

/**
 * The comments step of a delivery: read what is on the PR, post the rest as one review pinned to the
 * pushed commit. Any failure comes back with what to tell the agent — the PR is open either way.
 */
async function postPrComments(
  container: string, cardId: string, token: string, cwd: string, prUrl: string, branch: string, comments: CleanComment[],
): Promise<{ ok: true; posted: number; skipped: number } | { ok: false; output: string }> {
  if (!parsePrUrl(prUrl)) return { ok: false, output: `a URL do PR não é do GitHub (${prUrl}): os comentários não foram publicados` };
  const read = await hostExecutor().runScript(
    buildPrCommentsReadScript(container, cardId, token, cwd, prUrl, branch),
    { timeoutMs: (COMMENTS_HEAD_ROUNDS * COMMENTS_HEAD_POLL_SECONDS + 60) * 1000 },
  );
  const found = parsePrComments(read.stdout);
  if (!found.ok) {
    return {
      ok: false,
      output: found.stage === "stale"
        ? "o PR ainda não aponta para o commit enviado: os comentários não foram publicados (entregue de novo em instantes)"
        : `não deu para ler os comentários do PR: ${cleanOutput(found.output) || found.stage}`,
    };
  }
  const fresh = freshComments(found.posted, comments);
  const skipped = comments.length - fresh.length;
  if (fresh.length === 0) return { ok: true, posted: 0, skipped };
  const post = await hostExecutor().runScript(
    buildPrReviewScript(container, cardId, token, cwd, prUrl, reviewPayload(found.head, fresh)),
    { timeoutMs: 60_000 },
  );
  if (!new RegExp(`${MARKER} review ok`).test(post.stdout)) {
    const answer = cleanOutput(post.stdout.replace(new RegExp(`${MARKER} .*`, "g"), "").trim());
    // The hint about lines only when GitHub refused a POSITION (422); a 403 or a token without the
    // scope is not fixed by moving lines.
    // Whole words only: "different", "deadline" or "pipeline" in a 403 are not a refused position.
    const position = /\b(422|line|position|diff)\b/i.test(answer)
      ? " Cada line tem que estar no diff do PR (side RIGHT = linha da versão nova; LEFT = linha removida)."
      : "";
    return { ok: false, output: `o GitHub recusou os comentários (nenhum foi publicado): ${answer || "sem resposta"}.${position}` };
  }
  return { ok: true, posted: fresh.length, skipped };
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

/**
 * Parses the push+PR output into a resolved PR url or a staged error. A failed `edit` happened on a PR
 * that IS open: its url rides on the marker and comes back as `prUrl`. PURE.
 */
export function parsePushAndPr(
  stdout: string,
): { ok: true; prUrl: string } | { ok: false; stage: string; output: string; prUrl?: string } {
  const pr = new RegExp(`${MARKER} pr (\\S+)`).exec(stdout);
  if (pr && pr[1]) return { ok: true, prUrl: pr[1] };
  const err = new RegExp(`${MARKER} error (\\S+)(?: (https://\\S+))?`).exec(stdout);
  const stage = err?.[1] ?? "unknown";
  const output = stdout.replace(new RegExp(`${MARKER} (pr|error).*`, "g"), "").trimEnd();
  return { ok: false, stage, output, ...(err?.[2] ? { prUrl: err[2] } : {}) };
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
  return stage === "push" ? "push_failed" : stage === "undocumented" ? "undocumented" : "pr_failed";
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

/** `owner/repo` and the number out of a GitHub pull request's URL; null when it is not one. PURE. */
export function parsePrUrl(prUrl: string): { repo: string; number: number } | null {
  const m = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)(?:[/?#]|$)/.exec(prUrl);
  return m ? { repo: m[1]!, number: Number(m[2]) } : null;
}

/**
 * Runs one `gh` script for a card, in its worktree, with a token — the connection given, or the
 * card's own (the actor's). Null when the card or its project is gone, or the run itself failed
 * (logged with `what`): the callers here are all best-effort, and none of them may throw.
 */
async function runCardGhScript(
  cardId: string, what: string,
  build: (ctx: { container: string; cardId: string; token: string; cwd: string }) => string,
  connectionId?: string,
): Promise<{ stdout: string; slug: string } | null> {
  try {
    const card = await getCard(cardId);
    const project = card ? await getProject(card.projectId) : undefined;
    if (!card || !project) return null;
    const { cwd } = cardWorkPaths(project, card);
    const token = connectionId ? await tokenFor(connectionId) : await cardConnectionToken(card, project);
    const out = await hostExecutor().runScript(build({ container: config.runner.container, cardId: card.id, token, cwd }), { timeoutMs: 60_000 });
    return { stdout: out.stdout, slug: card.worktreeSlug };
  } catch (err) {
    logger.warn({ card: cardId, detail: (err as Error).message }, `could not ${what}`);
    return null;
  }
}

/**
 * Reads a PR's STATE and head, by its URL: `__VIBEHUB_DELIVER__ prstate <OPEN|MERGED|CLOSED> <sha>`,
 * or `__VIBEHUB_DELIVER__ error view`. What the PR review checks to notice what happened on GitHub
 * outside the panel (a merge by hand, a closed PR, a push after ready). PURE.
 */
export function buildPrStateScript(containerName: string, cardId: string, token: string, cwd: string, prUrl: string): string {
  assertSafeRemotePath(cwd);
  const body = [
    ...ghTokenPreamble(token),
    `cd ${shQuote(cwd)} || { echo "${MARKER} error cwd"; exit 0; }`,
    `if ! J=$(gh pr view ${shQuote(prUrl)} --json state,headRefOid --jq '.state + " " + .headRefOid' 2>&1); then`,
    `  printf '%s\\n' "$J"; echo "${MARKER} error view"; exit 0;`,
    `fi`,
    `echo "${MARKER} prstate $J"`,
  ];
  return dockerBashScript(containerName, body);
}

export type PrState = "OPEN" | "MERGED" | "CLOSED";

/** Parses the PR state lookup. PURE. */
export function parsePrState(
  stdout: string,
): { ok: true; state: PrState; headSha: string } | { ok: false; stage: string; output: string } {
  const m = new RegExp(`${MARKER} prstate (OPEN|MERGED|CLOSED) ([0-9a-fA-F]{40,64})\\b`).exec(stdout);
  if (m) return { ok: true, state: m[1] as PrState, headSha: m[2]!.toLowerCase() };
  const err = new RegExp(`${MARKER} error (\\S+)`).exec(stdout);
  const output = stdout.replace(new RegExp(`${MARKER} (prstate|error).*`, "g"), "").trimEnd();
  return { ok: false, stage: err?.[1] ?? "unknown", output };
}

/**
 * A PR as GitHub has it now — state and head — read with the card's own connection (the actor's).
 * Null when the lookup failed (logged): the caller leaves things as they are.
 */
export async function readPrState(cardId: string, prUrl: string): Promise<{ state: PrState; headSha: string } | null> {
  const out = await runCardGhScript(cardId, "read the PR state", (c) => buildPrStateScript(c.container, c.cardId, c.token, c.cwd, prUrl));
  if (!out) return null;
  const found = parsePrState(out.stdout);
  if (found.ok) return { state: found.state, headSha: found.headSha };
  logger.warn({ card: out.slug, stage: found.stage, detail: cleanOutput(found.output) }, "could not read the PR state");
  return null;
}

/** One review on a PR, as the auto-merge needs it: who, what verdict, on which commit. */
export interface PrReview {
  author: string;
  state: string;
  commit: string;
}

/**
 * Reads a PR's reviews, oldest first: `__VIBEHUB_DELIVER__ prreviews <base64 of [{a,s,c}]>`, or
 * `__VIBEHUB_DELIVER__ error view`. `reviews` (not `latestReviews`) because only it carries the commit
 * each verdict was given on. PURE.
 */
export function buildPrReviewsScript(containerName: string, cardId: string, token: string, cwd: string, prUrl: string): string {
  assertSafeRemotePath(cwd);
  const body = [
    ...ghTokenPreamble(token),
    `cd ${shQuote(cwd)} || { echo "${MARKER} error cwd"; exit 0; }`,
    `if ! J=$(gh pr view ${shQuote(prUrl)} --json reviews --jq '[.reviews[] | {a: .author.login, s: .state, c: .commit.oid}]' 2>&1); then`,
    `  printf '%s\\n' "$J"; echo "${MARKER} error view"; exit 0;`,
    `fi`,
    `echo "${MARKER} prreviews $(printf '%s' "$J" | base64 -w0)"`,
  ];
  return dockerBashScript(containerName, body);
}

/** Parses the reviews lookup. Anything that is not the list it promised is an error. PURE. */
export function parsePrReviews(stdout: string): { ok: true; reviews: PrReview[] } | { ok: false; stage: string } {
  const m = new RegExp(`${MARKER} prreviews ([A-Za-z0-9+/=]*)`).exec(stdout);
  if (m) {
    try {
      const raw: unknown = JSON.parse(Buffer.from(m[1]!, "base64").toString("utf8"));
      if (Array.isArray(raw)) {
        const reviews = raw.map((r: { a?: unknown; s?: unknown; c?: unknown }) => ({
          author: String(r?.a ?? ""), state: String(r?.s ?? ""), commit: String(r?.c ?? "").toLowerCase(),
        }));
        return { ok: true, reviews };
      }
    } catch {
      // falls through to the error answer
    }
    return { ok: false, stage: "parse" };
  }
  const err = new RegExp(`${MARKER} error (\\S+)`).exec(stdout);
  return { ok: false, stage: err?.[1] ?? "unknown" };
}

/**
 * Whether the PR is APPROVED on commit `sha`: some APPROVED review was given on exactly that commit,
 * and nobody's standing verdict is CHANGES_REQUESTED (each author's LAST approve / request-changes /
 * dismiss is what stands; comments do not change it). An Approve on an older commit does not count:
 * it approved other code. PURE, TOTAL.
 */
export function prApprovedAt(reviews: PrReview[], sha: string): boolean {
  const target = String(sha ?? "").toLowerCase();
  if (!target) return false;
  const standing = new Map<string, string>();
  for (const r of reviews) {
    if (r.state === "APPROVED" || r.state === "CHANGES_REQUESTED" || r.state === "DISMISSED") standing.set(r.author, r.state);
  }
  if ([...standing.values()].includes("CHANGES_REQUESTED")) return false;
  return reviews.some((r) => r.state === "APPROVED" && r.commit === target && standing.get(r.author) === "APPROVED");
}

/**
 * Whether GitHub has the PR approved on `sha` ({@link prApprovedAt}), read with the card's own
 * connection. Null when the lookup failed (logged): the auto-merge treats that as "no".
 */
export async function readPrApproval(cardId: string, prUrl: string, sha: string): Promise<boolean | null> {
  const out = await runCardGhScript(cardId, "read the PR reviews", (c) => buildPrReviewsScript(c.container, c.cardId, c.token, c.cwd, prUrl));
  if (!out) return null;
  const found = parsePrReviews(out.stdout);
  if (found.ok) return prApprovedAt(found.reviews, sha);
  logger.warn({ card: out.slug, stage: found.stage }, "could not read the PR reviews");
  return null;
}

/** A PR as `vibehub_attach_prs` needs it: what the card stores, plus whether it can be attached at all. */
export interface PrInfo {
  number: number;
  url: string;
  branch: string;
  base: string;
  author?: string;
  title: string;
  state: PrState;
  /** The head lives in ANOTHER repository (a fork): a correction card would have nowhere to push. */
  fork: boolean;
}

/**
 * Reads one PR — by number (in the card's repository) or by URL — for attaching it to a card:
 * `__VIBEHUB_DELIVER__ prinfo <base64 of gh's JSON>`, or `__VIBEHUB_DELIVER__ error view`. The
 * reference is checked BEFORE it reaches the shell: a positive number or a GitHub PR URL. PURE.
 */
export function buildPrInfoScript(containerName: string, cardId: string, token: string, cwd: string, ref: number | string): string {
  assertSafeRemotePath(cwd);
  const value = prRef(ref);
  const body = [
    ...ghTokenPreamble(token),
    `cd ${shQuote(cwd)} || { echo "${MARKER} error cwd"; exit 0; }`,
    `if ! J=$(gh pr view ${shQuote(value)} --json number,url,headRefName,baseRefName,author,state,title,isCrossRepository 2>&1); then`,
    `  printf '%s\\n' "$J"; echo "${MARKER} error view"; exit 0;`,
    `fi`,
    `echo "${MARKER} prinfo $(printf '%s' "$J" | base64 -w0)"`,
  ];
  return dockerBashScript(containerName, body);
}

/** A PR reference that may reach the shell: a positive number, or a GitHub PR URL. Throws otherwise. PURE. */
function prRef(ref: number | string): string {
  if (typeof ref === "number") {
    if (Number.isInteger(ref) && ref > 0) return String(ref);
  } else if (parsePrUrl(String(ref ?? "").trim())) {
    return String(ref).trim();
  }
  throw new Error(`not a PR number or GitHub PR url: ${String(ref)}`);
}

/** Parses the PR lookup of {@link buildPrInfoScript}. PURE. */
export function parsePrInfo(stdout: string): { ok: true; pr: PrInfo } | { ok: false; stage: string; output: string } {
  const output = stdout.replace(new RegExp(`${MARKER} (prinfo|error).*`, "g"), "").trimEnd();
  const m = new RegExp(`${MARKER} prinfo (\\S+)`).exec(stdout);
  if (!m) return { ok: false, stage: new RegExp(`${MARKER} error (\\S+)`).exec(stdout)?.[1] ?? "unknown", output };
  try {
    const j = JSON.parse(Buffer.from(m[1]!, "base64").toString("utf8")) as Record<string, unknown>;
    const state = j.state;
    if (
      !Number.isInteger(j.number) || typeof j.url !== "string" || typeof j.headRefName !== "string" ||
      typeof j.baseRefName !== "string" || (state !== "OPEN" && state !== "MERGED" && state !== "CLOSED")
    ) {
      return { ok: false, stage: "parse", output };
    }
    const login = (j.author as { login?: unknown } | null)?.login;
    return {
      ok: true,
      pr: {
        number: j.number as number, url: j.url, branch: j.headRefName, base: j.baseRefName,
        author: typeof login === "string" && login ? login : undefined,
        title: typeof j.title === "string" ? j.title : "", state, fork: j.isCrossRepository === true,
      },
    };
  } catch {
    return { ok: false, stage: "parse", output };
  }
}

/**
 * One PR read with the card's own connection (the actor's), for attaching it. Null when the lookup
 * failed (logged, with what `gh` said in `detail`): the caller reports it as not found.
 */
export async function readPrInfo(cardId: string, ref: number | string): Promise<{ pr: PrInfo } | { error: string }> {
  try {
    prRef(ref);
  } catch {
    return { error: `referência inválida: ${String(ref)}` };
  }
  const out = await runCardGhScript(cardId, "read the PR to attach", (c) => buildPrInfoScript(c.container, c.cardId, c.token, c.cwd, ref));
  if (!out) return { error: "não consegui consultar o GitHub" };
  const found = parsePrInfo(out.stdout);
  if (found.ok) return { pr: found.pr };
  logger.warn({ card: out.slug, stage: found.stage, detail: cleanOutput(found.output) }, "could not read the PR to attach");
  return { error: found.stage === "view" ? `não encontrado (${oneLineOf(cleanOutput(found.output))})` : "resposta do GitHub ilegível" };
}

const oneLineOf = (s: string): string => s.replace(/\s+/g, " ").trim().slice(0, 200);

/**
 * Deletes a MERGED PR's head branch on GitHub — the work is in the base now, and a branch left behind
 * is clutter nobody cleans. Two guards, in the script, against the moment it runs: the repo's default
 * branch is never deleted, and neither is a branch another OPEN PR still comes from (a card with a PR
 * to `dev` and another to `prod`: deleting it would close the second one). Emits
 * `__VIBEHUB_DELIVER__ branch deleted|kept`, or `__VIBEHUB_DELIVER__ error <stage>`. A branch that
 * is already gone (GitHub's own auto-delete) counts as deleted. PURE.
 */
export function buildDeleteBranchScript(
  containerName: string, cardId: string, token: string, cwd: string, prUrl: string, branch: string,
): string {
  assertSafeRemotePath(cwd);
  const repo = parsePrUrl(prUrl)?.repo;
  if (!repo) throw new Error(`not a GitHub PR url: ${prUrl}`);
  const ref = shQuote(`repos/${repo}/git/refs/heads/${assertBranchName(branch)}`);
  const body = [
    ...ghTokenPreamble(token),
    `cd ${shQuote(cwd)} || { echo "${MARKER} error cwd"; exit 0; }`,
    `DEF=$(gh repo view ${shQuote(repo)} --json defaultBranchRef --jq .defaultBranchRef.name 2>/dev/null)`,
    // Without the default branch in hand the guard cannot be checked: nothing is deleted.
    `if [ -z "$DEF" ]; then echo "${MARKER} error repo"; exit 0; fi`,
    `if [ "$DEF" = ${shQuote(branch)} ]; then echo "${MARKER} branch kept"; exit 0; fi`,
    `if ! OPEN=$(gh pr list --repo ${shQuote(repo)} --head ${shQuote(branch)} --state open --json number --jq length 2>&1); then`,
    `  printf '%s\\n' "$OPEN"; echo "${MARKER} error list"; exit 0;`,
    `fi`,
    `if [ "$OPEN" != "0" ]; then echo "${MARKER} branch kept"; exit 0; fi`,
    `if OUT=$(gh api -X DELETE ${ref} 2>&1); then echo "${MARKER} branch deleted"; exit 0; fi`,
    `case "$OUT" in *"Reference does not exist"*) echo "${MARKER} branch deleted"; exit 0;; esac`,
    `printf '%s\\n' "$OUT"; echo "${MARKER} error delete"`,
  ];
  return dockerBashScript(containerName, body);
}

/** Parses the branch deletion. PURE. */
export function parseDeleteBranch(stdout: string): "deleted" | "kept" | "failed" {
  const m = new RegExp(`${MARKER} branch (deleted|kept)\\b`).exec(stdout);
  return m ? (m[1] as "deleted" | "kept") : "failed";
}

/**
 * Deletes a merged PR's head branch (see {@link buildDeleteBranchScript}), with the given connection
 * or the card's. Never throws: a branch that could not be deleted costs a log line, not the merge.
 */
export async function deleteMergedBranch(
  cardId: string, prUrl: string, branch: string, connectionId?: string,
): Promise<"deleted" | "kept" | "failed"> {
  const out = await runCardGhScript(
    cardId, "delete the merged branch", (c) => buildDeleteBranchScript(c.container, c.cardId, c.token, c.cwd, prUrl, branch), connectionId,
  );
  if (!out) return "failed";
  const result = parseDeleteBranch(out.stdout);
  logger.info({ audit: true, action: "maestro.delete_branch", card: out.slug, branch, result }, "merged PR's branch");
  if (result === "failed") logger.warn({ card: out.slug, branch, detail: cleanOutput(out.stdout) }, "could not delete the merged branch");
  return result;
}

/** A GitHub login: letters, digits and single hyphens, up to 39 characters. */
const GITHUB_LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;

/** Who the PR names on GitHub: the assignee (who delivers it) and the reviewer asked to review it. */
export interface PrPeople {
  assignee?: string;
  reviewer?: string;
}

/** How each name asked for went on GitHub. */
export type PrPeopleResult = Partial<Record<keyof PrPeople, "ok" | "failed">>;

/**
 * Marks the PR's ASSIGNEE and asks for its REVIEWER on GitHub — one `gh pr edit` each, so the one
 * GitHub refuses (a reviewer who is the PR's own author, a login without access) does not take the
 * other with it. Emits `__VIBEHUB_DELIVER__ people <assignee|reviewer> <ok|error>`. PURE.
 */
export function buildPrPeopleScript(
  containerName: string, cardId: string, token: string, cwd: string, prUrl: string, people: PrPeople,
): string {
  assertSafeRemotePath(cwd);
  const steps: string[] = [];
  for (const [role, flag] of [["assignee", "--add-assignee"], ["reviewer", "--add-reviewer"]] as const) {
    const login = people[role];
    if (!login) continue;
    if (!GITHUB_LOGIN_RE.test(login)) throw new Error(`invalid GitHub login for the ${role}: '${login}'`);
    steps.push(
      `if OUT=$(gh pr edit ${shQuote(prUrl)} ${flag} ${shQuote(login)} 2>&1); then echo "${MARKER} people ${role} ok";` +
        ` else printf '%s\\n' "$OUT"; echo "${MARKER} people ${role} error"; fi`,
    );
  }
  const body = [...ghTokenPreamble(token), `cd ${shQuote(cwd)} || { echo "${MARKER} error cwd"; exit 0; }`, ...steps];
  return dockerBashScript(containerName, body);
}

/** Parses the people marking: what was asked and how it went. PURE. */
export function parsePrPeople(stdout: string): PrPeopleResult {
  const out: PrPeopleResult = {};
  for (const m of stdout.matchAll(new RegExp(`${MARKER} people (assignee|reviewer) (ok|error)`, "g"))) {
    out[m[1] as "assignee" | "reviewer"] = m[2] === "ok" ? "ok" : "failed";
  }
  return out;
}

/**
 * Names the PR's assignee and reviewer on GitHub, with the card's connection (see
 * {@link buildPrPeopleScript}). Never throws: a PR that could not be marked costs a log line.
 */
export async function setPrPeople(cardId: string, prUrl: string, people: PrPeople): Promise<PrPeopleResult> {
  if (!people.assignee && !people.reviewer) return {};
  const out = await runCardGhScript(
    cardId, "name the PR's people on GitHub", (c) => buildPrPeopleScript(c.container, c.cardId, c.token, c.cwd, prUrl, people),
  );
  if (!out) return {};
  const result = parsePrPeople(out.stdout);
  if (Object.values(result).includes("failed")) {
    logger.warn({ card: out.slug, result, detail: cleanOutput(out.stdout) }, "could not name all the PR's people on GitHub");
  }
  return result;
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
  return parsePrUrl(prUrl)?.number ?? null;
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
 * What follows ANY merge of a card's PR — the deliver's own, or one the PR review found on GitHub
 * (made by hand, outside the panel):
 *  - the card's PR is marked merged, so the chat stops offering a review of it and the review refuses
 *    to start one;
 *  - the PR's branch leaves GitHub ({@link deleteMergedBranch}: the work is in the base now) — but
 *    ONLY the branch vibehub itself made for the card (`card/<slug>`). A branch a person named (a
 *    card patched to work on `dev`, say) is somebody's long-lived branch, never deleted from here.
 * Best-effort like {@link rememberPr}: the merge is DONE, and a note about it that could not be
 * written must not turn it into a failure. Returns what became of the branch.
 */
export async function afterPrMerged(
  cardId: string, prUrl: string, base: string, branch: string, connectionId?: string,
): Promise<"deleted" | "kept" | "failed"> {
  const number = prNumberFromUrl(prUrl);
  if (number !== null) {
    try {
      await markCardPrMerged(cardId, base, number, Date.now());
    } catch (err) {
      logger.warn({ card: cardId, detail: (err as Error).message }, "could not mark the PR as merged on the card");
    }
  }
  const card = await getCard(cardId);
  if (!card || branch !== `card/${card.worktreeSlug}`) return "kept";
  return await deleteMergedBranch(cardId, prUrl, branch, connectionId);
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
  // The PR's documentation is checked before anything runs: a body without its sections must not cost
  // a push. Merge-only writes nothing on the PR, so it has nothing to check.
  const checked = mergeOnly ? null : validatePrDocs(opts.docs);
  if (checked && !checked.ok) {
    logger.info(
      { audit: true, action: "maestro.deliver", card: card.worktreeSlug, merged: false, reason: "undocumented", by: opts.by },
      "deliver refused: the PR documentation is invalid",
    );
    return {
      merged: false, reason: "undocumented", branch: target, cardBranch: source, ...lock,
      output: `Documentação do PR recusada; nada foi enviado:\n- ${checked.problems.join("\n- ")}`,
    };
  }
  const docs: CleanPrDocs = checked?.ok ? checked.docs : { comments: [] };
  const { cwd } = cardWorkPaths(project, card);
  const container = config.runner.container;

  const token = opts.connectionId ? await tokenFor(opts.connectionId) : await cardConnectionToken(card, project);

  let prUrl: string;
  /** Spread into every result after the comments step: what this delivery posted on the diff. */
  let commented: Pick<DeliverResult, "comments"> = {};
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
      buildPushAndPrScript(container, card.id, token, cwd, source, target, docs),
      { timeoutMs: 120_000 },
    );
    const pr = parsePushAndPr(prOut.stdout);
    if (!pr.ok) {
      logger.info(
        { audit: true, action: "maestro.deliver", card: card.worktreeSlug, stage: pr.stage, merged: false, by: opts.by },
        "deliver stopped before a PR",
      );
      const output = pr.stage === "undocumented" ? undocumentedOutput(docs) : cleanOutput(pr.output);
      // A failed rewrite of an OPEN PR: the PR exists, so the card still learns of it and the answer names it.
      if (pr.prUrl) await rememberPr(card, pr.prUrl, target, source);
      const open = pr.prUrl ? { prUrl: pr.prUrl } : {};
      return { ...open, merged: false, reason: reasonForStage(pr.stage), branch: target, cardBranch: source, ...lock, output };
    }
    prUrl = pr.prUrl;
    await rememberPr(card, prUrl, target, source);
    // The comments on the diff go up BEFORE the gate: a PR that gets merged already explains itself,
    // and one GitHub refused them on stops here — merging it undocumented is what the rule forbids.
    if (docs.comments.length) {
      const posted = await postPrComments(container, card.id, token, cwd, prUrl, source, docs.comments);
      logger.info(
        { audit: true, action: "maestro.deliver", card: card.worktreeSlug, comments: posted.ok ? posted.posted : "failed", by: opts.by },
        posted.ok ? "deliver posted the PR comments" : "deliver could not post the PR comments",
      );
      if (!posted.ok) {
        return { prUrl, merged: false, reason: "comments_failed", branch: target, cardBranch: source, ...lock, output: posted.output };
      }
      const repeated = docs.repeated ? { repeated: docs.repeated } : {};
      commented = { comments: { posted: posted.posted, skipped: posted.skipped, ...repeated } };
    }
    // Push-only: the branch is on the PR, and that is all that was asked (no gate, no merge).
    if (opts.pushOnly) return { prUrl, merged: false, reason: "pushed", branch: target, cardBranch: source, ...lock, ...commented };
  }

  // (c) the gate — the PR's CI when it has one, the local gate otherwise. A gate that errors
  // (runner blip) blocks the merge — deploying past an unknown state is worse than trying again.
  // Merge-only reads the CI of the REVIEWED commit (nothing was pushed, the worktree's HEAD is not it).
  let gate: GateResult;
  try {
    gate = (await ciGate(container, card.id, token, cwd, prUrl, mergeOnly ? expectedHead : undefined)) ?? (await runGate(card.id));
  } catch (err) {
    logger.warn({ card: card.worktreeSlug, detail: (err as Error).message }, "gate could not run — treating as red");
    return { prUrl, merged: false, reason: "gate", branch: target, cardBranch: source, ...lock, ...commented, output: (err as Error).message };
  }
  if (gate.ran && !gate.passed) {
    logger.info(
      { audit: true, action: "maestro.deliver", card: card.worktreeSlug, merged: false, gate: "red", by: opts.by },
      "deliver stopped at the gate",
    );
    return { prUrl, merged: false, reason: "gate", branch: target, cardBranch: source, ...lock, ...commented, output: gate.output };
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
    return { prUrl, merged: false, reason: "locked", branch: target, cardBranch: source, locked: true, ...commented };
  }
  if (opts.authorized !== true) {
    logger.info(
      { audit: true, action: "maestro.deliver", card: card.worktreeSlug, merged: false, reason: "unauthorized", by: opts.by },
      "deliver prepared a PR but was not authorized to merge",
    );
    return { prUrl, merged: false, reason: "unauthorized", branch: target, cardBranch: source, ...commented };
  }
  // The CI wait can take minutes: a review asked for in the meantime still takes the merge away.
  if (!mergeOnly && (await activeReviewFor(card.id))) {
    logger.info(
      { audit: true, action: "maestro.deliver", card: card.worktreeSlug, merged: false, reason: "review_active", by: opts.by },
      "deliver refused to merge: a PR review started while the gate ran",
    );
    return {
      prUrl, merged: false, reason: "review_active", branch: target, cardBranch: source, ...lock, ...commented,
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
  if (!merged) {
    return { prUrl, merged, reason: "merge_failed", branch: target, cardBranch: source, ...lock, ...commented, output: cleanOutput(output) };
  }
  const headBranch = await afterPrMerged(card.id, prUrl, target, source, opts.connectionId);
  return { prUrl, merged, reason: "merged", branch: target, cardBranch: source, ...lock, ...commented, headBranch };
}
