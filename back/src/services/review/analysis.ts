import { visibleCards } from "../../auth/access.js";
import { creatorAccountSlug, getUserGit } from "../../auth/userGit.js";
import { findUser, listUsers, type PublicUser } from "../../auth/users.js";
import { recordCardActor } from "../board/actor.js";
import { purgeCard } from "../board/purge.js";
import {
  assertBranchName, createAnalysisCard, getProject, listCards, listGithubConnections,
  recordCardPr, sharesForTarget, updateCard, type Card, type GithubConnection, type Project,
} from "../board/registry.js";
import { recordMessage } from "../events/cardEvents.js";
import { listOpenPulls, readPull, splitRepo, type OpenPull } from "../github/client.js";
import { resolveIdentity } from "../github/identity.js";
import type { MessageOrigin } from "../chat/provenance.js";
import { sendToTerminal, SEND_READY_WAIT_MS } from "../maestro/maestro.js";
import { logger } from "../../utils/logger.js";
import { getSettings, type Settings } from "../settings/settings.js";
import { findActiveAnalysisCard } from "./analysisReport.js";
import { plantPrAnalysisWorkflow } from "./analysisWorkflow.js";
import { analysisPrompt } from "./prompts.js";
import { activeReviewForPr } from "./store.js";
import { announcePullsChanged, prClaimHolder } from "./prClaims.js";

/**
 * PR ANALYSIS FROM THE PANEL — the project's open PRs, read from GitHub on every call, and the card that
 * analyses one of them (`createAnalysisCard` + `analysisPrompt`). It replaces the loop "open a card, type
 * 'analisa a PR 636', open another card…" (César and Albert, 2026-11-16).
 *
 * Invariants:
 *  - GitHub is the source of the list: nothing about open PRs is stored, so a PR opened by hand shows up
 *    at once and a closed one disappears.
 *  - One ACTIVE analysis card per PR, found by the PR's URL on the card (`Card.prs`) — never by title. Two
 *    requests at the same time are serialized per PR, so they cannot both create one. A card moved to
 *    "done" no longer holds the PR, nor does an open one whose fleet did not run (`fleet_unavailable`):
 *    asking again opens a new analysis.
 *  - Only a PR from the project's own repository: the fixes are pushed to its branch, and a fork's
 *    branch is not ours to push to (the same rule as `attachPrs`).
 *  - GitHub is read with the identity of whoever asks (their connection, falling back to the project's).
 *    The card works on behalf of the REVIEWER chosen for it (their Claude account, their GitHub), never
 *    of whoever clicked, and whoever opened the PR is never its reviewer nor its co-author (the reviewer may be).
 */

const ANALYSIS_ORIGIN: MessageOrigin = { kind: "system", name: "análise de PR" };

export interface ProjectPull extends OpenPull {
  /** The active analysis card of this PR, when there is one. */
  analysisCardId?: string;
  /**
   * The PR's branch is a name vibehub refuses (`assertBranchName`: accents, `+`, `@`, over 80 chars): the
   * analysis card could not be cut from it. Present only when true.
   */
  unsupportedBranch?: true;
}

function isSupportedBranch(branch: string): boolean {
  try {
    return assertBranchName(branch) === branch;
  } catch {
    return false;
  }
}

/** What resolving anyone's GitHub identity on a project reads once, however many people are resolved. */
interface IdentityContext {
  project: Project;
  settings: Settings;
  connections: GithubConnection[];
}

async function identityContext(project: Project): Promise<IdentityContext> {
  const [settings, connections] = await Promise.all([getSettings(), listGithubConnections()]);
  return { project, settings, connections };
}

/** The GitHub connection a person's git and gh run as on this project: theirs, falling back to the project's. */
async function connectionOf(userId: string, ctx: IdentityContext): Promise<GithubConnection | undefined> {
  const connectionId = resolveIdentity({ actor: await getUserGit(userId), ...ctx }).connectionId;
  return ctx.connections.find((c) => c.id === connectionId);
}

/** The project's repository and the GitHub connection of whoever asks. */
async function projectRepoAccess(projectId: string, user: PublicUser): Promise<{ project: Project; connection: GithubConnection; owner: string; repo: string }> {
  const project = await getProject(projectId);
  if (!project) throw new Error("project not found");
  if (!project.repoFullName) throw new Error("sem_repositorio: o projeto não tem repositório no GitHub");
  const { owner, repo } = splitRepo(project.repoFullName);
  // `connectionOf` falls back to the install's first account: none resolved = no account at all.
  const connection = await connectionOf(user.id, await identityContext(project));
  if (!connection) throw new Error("GitHub is not connected — paste a token in Settings");
  return { project, connection, owner, repo };
}

/**
 * The asker's GitHub account does not see the project's repository. The route turns it into 403 with
 * `login` and `repo` in their own fields, for the panel to say it in the person's language.
 */
export class RepoAccessError extends Error {
  constructor(readonly login: string, readonly repo: string) {
    super(`sem_acesso_repo: a conta GitHub ${login} não tem acesso a ${repo}`);
  }
}

export interface AnalysisPerson {
  id: string;
  username: string;
  /** The GitHub login their commits and PR comments would go out as (their connection, else the project's). */
  githubLogin?: string;
}

/**
 * Who can take part in an analysis of this project: whoever WORKS on it — the owners and the members with
 * a `work` share on the project. The reviewer works the card on their behalf (it needs `work`), and the
 * co-author is credited on its commits. `githubLogin` is what lets the dialog tell the PR's author apart:
 * whoever opened a PR does not review it.
 */
export async function analysisPeople(projectId: string): Promise<AnalysisPerson[]> {
  const project = await getProject(projectId);
  if (!project) throw new Error("project not found");
  return await peopleOf(project);
}

async function peopleOf(project: Project): Promise<AnalysisPerson[]> {
  const [users, shares, ctx] = await Promise.all([listUsers(), sharesForTarget("project", project.id), identityContext(project)]);
  const working = new Set(shares.filter((s) => s.level === "work").map((s) => s.userId));
  return await Promise.all(
    users.filter((u) => u.role === "owner" || working.has(u.id)).map(async (u) => {
      const login = (await connectionOf(u.id, ctx))?.login;
      return { id: u.id, username: u.username, ...(login ? { githubLogin: login } : {}) };
    }),
  );
}

/**
 * Refuses with {@link RepoAccessError} when the asker's GitHub account does not see the repository: it
 * used to come out as "GitHub returned 404", a 502 the panel retried before showing, which read as GitHub
 * being down when the person simply has no access (production, 2026-11-16).
 */
export async function listProjectPulls(projectId: string, user: PublicUser): Promise<ProjectPull[]> {
  const { connection, owner, repo } = await projectRepoAccess(projectId, user);
  const [pulls, cards] = await Promise.all([listOpenPulls(connection.id, owner, repo), listCards(projectId)]);
  if (!pulls) throw new RepoAccessError(connection.login, `${owner}/${repo}`);
  // Only the cards this user reaches: a card-only share sees the project, never the others' cards.
  const reachable = await visibleCards(user, cards);
  return Promise.all(pulls.map(async (pull) => {
    const card = await findActiveAnalysisCard(reachable, pull.url);
    return {
      ...pull,
      ...(card ? { analysisCardId: card.id } : {}),
      ...(isSupportedBranch(pull.branch) ? {} : { unsupportedBranch: true as const }),
    };
  }));
}

/** Per PR URL, the start in progress: the second request of the same PR waits for the first. */
const starting = new Map<string, Promise<unknown>>();

function serialPerPr<T>(key: string, run: () => Promise<T>): Promise<T> {
  const previous = starting.get(key) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(run);
  starting.set(key, next);
  void next.finally(() => {
    if (starting.get(key) === next) starting.delete(key);
  }).catch(() => undefined);
  return next;
}

/**
 * Opens the analysis of PR `prNumber`, or returns the active one (`created: false`, with the roles
 * it was opened with: the ones asked now are not applied). Refusals with the code in the message, which
 * the route turns into 400: `sem_repositorio`, `pr_nao_aberta`, `pr_fork`, `branch_invalida`,
 * `revisao_ativa` (a two-AI review of the same PR is running: the analysis' push would move the head it
 * reviews), `pessoa_sem_acesso` (the reviewer or co-author does not work on the project),
 * `coautor_sem_identidade`, `revisor_igual_autor` and `coautor_igual_autor` — and into 409
 * `pr_em_montagem` (somebody else is setting this PR's analysis up in the PR dialog).
 *
 * It answers as soon as the card exists and holds the PR: bringing a new card up (clone, worktree,
 * Claude) and waiting for it to take the prompt can last minutes, and the panel's dialog sat locked all
 * that time, with every other PR's button disabled (production, 2026-11-16). `prompt` is that delivery,
 * running on: a card whose prompt could not be delivered goes to "done" with the reason as a notice —
 * left open, the next click would find it and answer "already open" for an analysis that never started;
 * erased, it would vanish after the "started" toast without anyone being told. It never rejects.
 */
export async function startAnalysis(input: {
  projectId: string;
  prNumber: number;
  requester: PublicUser;
  /** Who analyses: the card works on their behalf (their Claude account, their commits and PR comments). */
  reviewerUserId: string;
  /** Credited on every commit of the analysis (`Co-authored-by`). */
  coauthorUserId?: string;
}): Promise<{ card: Card; created: boolean; prompt: Promise<void> }> {
  const { project, connection, owner, repo } = await projectRepoAccess(input.projectId, input.requester);
  const settingUp = prClaimHolder(input.projectId, input.prNumber);
  if (settingUp && settingUp.userId !== input.requester.id) {
    throw new Error(`pr_em_montagem: ${settingUp.username} está montando a análise do PR #${input.prNumber}`);
  }
  const people = new Map((await peopleOf(project)).map((p) => [p.id, p]));
  const reviewer = people.get(input.reviewerUserId);
  // Read before any card exists: a reviewer deleted meanwhile is refused, never left holding a card.
  const reviewerUser = reviewer ? await findUser(reviewer.id) : undefined;
  if (!reviewer || !reviewerUser) throw new Error("pessoa_sem_acesso: o revisor escolhido não trabalha neste projeto");
  if (input.coauthorUserId !== undefined && !people.has(input.coauthorUserId)) {
    throw new Error("pessoa_sem_acesso: o coautor escolhido não trabalha neste projeto");
  }
  const coauthor = input.coauthorUserId === undefined ? undefined : people.get(input.coauthorUserId);
  const coauthorTrailer = coauthor ? await coauthorTrailerOf(coauthor.id) : undefined;
  const pull = await readPull(connection.id, owner, repo, input.prNumber);
  if (!pull?.open) throw new Error(`pr_nao_aberta: o PR #${input.prNumber} não está aberto neste repositório`);
  if (pull.fromFork) throw new Error(`pr_fork: o PR #${pull.number} vem de outro repositório, e a correção não tem onde ser empurrada`);
  if (!isSupportedBranch(pull.branch)) {
    throw new Error(`branch_invalida: a branch do PR #${pull.number} (${pull.branch}) tem um nome que o vibehub não aceita para um card`);
  }
  // Whoever opened the PR does not review it: compared by the GitHub login the reviewer's commits would carry.
  if (reviewer.githubLogin && reviewer.githubLogin.toLowerCase() === pull.author.toLowerCase()) {
    throw new Error(`revisor_igual_autor: ${reviewer.username} abriu o PR #${pull.number} e não pode revisá-lo`);
  }
  // Nor is it their co-author: the credit goes to whoever worked on it with them, the reviewer included.
  if (coauthor?.githubLogin && coauthor.githubLogin.toLowerCase() === pull.author.toLowerCase()) {
    throw new Error(`coautor_igual_autor: ${coauthor.username} abriu o PR #${pull.number} e não é coautor dele`);
  }
  if (await activeReviewForPr(pull.url)) throw new Error(`revisao_ativa: o PR #${pull.number} está em revisão; a análise mexeria no que está sendo revisado`);

  const by = `analysis:${input.requester.username}`;
  return await serialPerPr(pull.url, async () => {
    const existing = await findActiveAnalysisCard(await listCards(input.projectId), pull.url);
    if (existing) return { card: existing, created: false, prompt: Promise.resolve() };

    const card = await createAnalysisCard({
      projectId: input.projectId,
      accountSlug: await creatorAccountSlug(reviewer.id),
      prBranch: pull.branch,
      title: `Análise PR #${pull.number} · ${pull.title}`,
    });
    try {
      // Recorded before answering: it is what makes the next click find this card instead of opening another.
      await recordCardPr(card.id, { number: pull.number, url: pull.url, base: pull.base, branch: pull.branch });
    } catch (err) {
      await purgeCard(card.id, by);
      throw err;
    }
    announcePullsChanged(input.projectId);
    const prompt = plantPrAnalysisWorkflow()
      .then(() => deliverAnalysisPrompt(card, pull, reviewerUser, coauthorTrailer))
      .catch((err: unknown) => concludeUnstartedAnalysis(card, pull.number, (err as Error).message));
    return { card, created: true, prompt };
  });
}

/**
 * The prompt never reached the card: it goes to "done", which frees the PR for a new click, with the
 * reason as a notice on the card — what tells whoever asked (they already saw "started") to try again.
 */
async function concludeUnstartedAnalysis(card: Card, prNumber: number, reason: string): Promise<void> {
  logger.warn({ card: card.worktreeSlug, pr: prNumber, detail: reason }, "PR analysis prompt not delivered — the card is concluded");
  try {
    await updateCard(card.id, { column: "done" });
    await recordMessage({
      cardId: card.id, type: "error", severity: "warning",
      text: `A análise do PR #${prNumber} não começou: ${reason}. Peça de novo na lista de PRs do projeto.`,
      idempotencyKey: "analysis-not-started",
    });
  } catch (err) {
    // `prompt` is dropped by the route: a rejection here would be unhandled and the card would keep the PR.
    logger.error({ card: card.worktreeSlug, pr: prNumber, detail: (err as Error).message }, "could not conclude the PR analysis that did not start");
  }
}

/** Types the analysis prompt into the new card, on behalf of the reviewer. Same delivery as the review's relay. */
async function deliverAnalysisPrompt(card: Card, pull: OpenPull, reviewer: PublicUser, coauthorTrailer?: string): Promise<void> {
  const text = analysisPrompt({
    cardId: card.id, prNumber: pull.number, prUrl: pull.url, branch: pull.branch, base: pull.base,
    ...(coauthorTrailer ? { coauthorTrailer } : {}),
  });
  await sendToTerminal(card.id, text, {
    by: `analysis:${reviewer.username}`,
    origin: ANALYSIS_ORIGIN,
    // Wake the new card, wait for Claude, never type into a menu, and go through the native chat so the
    // conversation does not fork.
    wake: true,
    requireAgent: true,
    guardInteractiveMenu: true,
    readyWaitMs: SEND_READY_WAIT_MS,
    viaNativeChat: true,
    beforeDeliver: async () => recordCardActor(reviewer, card.id),
  });
}

/** `Co-authored-by: Nome <email>` from the co-author's git identity on vibehub. Without one, refused. */
async function coauthorTrailerOf(userId: string): Promise<string> {
  const git = await getUserGit(userId);
  if (!git?.gitName || !git.gitEmail) {
    throw new Error("coautor_sem_identidade: o coautor não tem nome e e-mail de git no vibehub; sem eles não há crédito no commit");
  }
  return `Co-authored-by: ${git.gitName} <${git.gitEmail}>`;
}
