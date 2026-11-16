import { visibleCards } from "../../auth/access.js";
import { creatorAccountSlug, getUserGit } from "../../auth/userGit.js";
import { findUser, listUsers, type PublicUser } from "../../auth/users.js";
import { recordCardActor } from "../board/actor.js";
import { purgeCard } from "../board/purge.js";
import {
  assertBranchName, createAnalysisCard, getGithubConnection, getProject, listCards, listGithubConnections, openAnalysisCard,
  recordCardPr, sharesForTarget, type Card, type Project,
} from "../board/registry.js";
import { listOpenPulls, readPull, splitRepo, type OpenPull } from "../github/client.js";
import { resolveIdentity } from "../github/identity.js";
import type { MessageOrigin } from "../chat/provenance.js";
import { sendToTerminal, SEND_READY_WAIT_MS } from "../maestro/maestro.js";
import { logger } from "../../utils/logger.js";
import { getSettings } from "../settings/settings.js";
import { analysisPrompt } from "./prompts.js";
import { activeReviewForPr } from "./store.js";

/**
 * PR ANALYSIS FROM THE PANEL — the project's open PRs, read from GitHub on every call, and the card that
 * analyses one of them (`createAnalysisCard` + `analysisPrompt`). It replaces the loop "open a card, type
 * 'analisa a PR 636', open another card…" (César and Albert, 2026-11-16).
 *
 * Invariants:
 *  - GitHub is the source of the list: nothing about open PRs is stored, so a PR opened by hand shows up
 *    at once and a closed one disappears.
 *  - One OPEN analysis card per PR, found by the PR's URL on the card (`Card.prs`) — never by title. Two
 *    requests at the same time are serialized per PR, so they cannot both create one. A card moved to
 *    "done" no longer holds the PR: asking again opens a new analysis.
 *  - Only a PR from the project's own repository: the fixes are pushed to its branch, and a fork's
 *    branch is not ours to push to (the same rule as `attachPrs`).
 *  - GitHub is read with the identity of whoever asks (their connection, falling back to the project's),
 *    and the card works on their behalf: its first message is theirs.
 */

const ANALYSIS_ORIGIN: MessageOrigin = { kind: "system", name: "análise de PR" };

export interface ProjectPull extends OpenPull {
  /** The open analysis card of this PR, when there is one. */
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

/** The GitHub connection a person's git and gh run as on this project: theirs, falling back to the project's. */
async function connectionOf(userId: string, project: Project): Promise<string | undefined> {
  const [actor, settings, connections] = await Promise.all([getUserGit(userId), getSettings(), listGithubConnections()]);
  return resolveIdentity({ actor, project, settings, connections }).connectionId;
}

/** The project's repository and the GitHub connection of whoever asks. */
async function projectRepoAccess(projectId: string, user: PublicUser): Promise<{ project: Project; connectionId?: string; owner: string; repo: string }> {
  const project = await getProject(projectId);
  if (!project) throw new Error("project not found");
  if (!project.repoFullName) throw new Error("sem_repositorio: o projeto não tem repositório no GitHub");
  const { owner, repo } = splitRepo(project.repoFullName);
  return { project, connectionId: await connectionOf(user.id, project), owner, repo };
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
  const [users, shares] = await Promise.all([listUsers(), sharesForTarget("project", projectId)]);
  const working = new Set(shares.filter((s) => s.level === "work").map((s) => s.userId));
  return await Promise.all(
    users.filter((u) => u.role === "owner" || working.has(u.id)).map(async (u) => {
      const connectionId = await connectionOf(u.id, project);
      const login = connectionId ? (await getGithubConnection(connectionId))?.login : undefined;
      return { id: u.id, username: u.username, ...(login ? { githubLogin: login } : {}) };
    }),
  );
}

export async function listProjectPulls(projectId: string, user: PublicUser): Promise<ProjectPull[]> {
  const { connectionId, owner, repo } = await projectRepoAccess(projectId, user);
  const [pulls, cards] = await Promise.all([listOpenPulls(connectionId, owner, repo), listCards(projectId)]);
  // Only the cards this user reaches: a card-only share sees the project, never the others' cards.
  const reachable = await visibleCards(user, cards);
  return pulls.map((pull) => {
    const card = openAnalysisCard(reachable, pull.url);
    return {
      ...pull,
      ...(card ? { analysisCardId: card.id } : {}),
      ...(isSupportedBranch(pull.branch) ? {} : { unsupportedBranch: true as const }),
    };
  });
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
 * Opens the analysis of PR `prNumber`, or returns the one already open (`created: false`). Refusals with
 * the code in the message, which the route turns into 400: `sem_repositorio`, `pr_nao_aberta`, `pr_fork`,
 * `branch_invalida`, `revisao_ativa` (a two-AI review of the same PR is running: the analysis' push would
 * move the head it reviews).
 *
 * It answers as soon as the card exists and holds the PR: bringing a new card up (clone, worktree,
 * Claude) and waiting for it to take the prompt can last minutes, and the panel's dialog sat locked all
 * that time, with every other PR's button disabled (production, 2026-11-16). `prompt` is that delivery,
 * running on: a card whose prompt could not be delivered is purged — left behind, the next click would
 * find it and answer "already open" for an analysis that never started. It never rejects.
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
  const { connectionId, owner, repo } = await projectRepoAccess(input.projectId, input.requester);
  const people = new Map((await analysisPeople(input.projectId)).map((p) => [p.id, p]));
  const reviewer = people.get(input.reviewerUserId);
  if (!reviewer) throw new Error("pessoa_sem_acesso: o revisor escolhido não trabalha neste projeto");
  if (input.coauthorUserId !== undefined && !people.has(input.coauthorUserId)) {
    throw new Error("pessoa_sem_acesso: o coautor escolhido não trabalha neste projeto");
  }
  if (input.coauthorUserId === reviewer.id) throw new Error("coautor_igual_revisor: o revisor já assina os commits");
  const coauthorTrailer = input.coauthorUserId ? await coauthorTrailerOf(input.coauthorUserId) : undefined;
  const pull = await readPull(connectionId, owner, repo, input.prNumber);
  if (!pull?.open) throw new Error(`pr_nao_aberta: o PR #${input.prNumber} não está aberto neste repositório`);
  if (pull.fromFork) throw new Error(`pr_fork: o PR #${pull.number} vem de outro repositório, e a correção não tem onde ser empurrada`);
  if (!isSupportedBranch(pull.branch)) {
    throw new Error(`branch_invalida: a branch do PR #${pull.number} (${pull.branch}) tem um nome que o vibehub não aceita para um card`);
  }
  // Whoever opened the PR does not review it: compared by the GitHub login the reviewer's commits would carry.
  if (reviewer.githubLogin && reviewer.githubLogin.toLowerCase() === pull.author.toLowerCase()) {
    throw new Error(`revisor_igual_autor: ${reviewer.username} abriu o PR #${pull.number} e não pode revisá-lo`);
  }
  if (await activeReviewForPr(pull.url)) throw new Error(`revisao_ativa: o PR #${pull.number} está em revisão; a análise mexeria no que está sendo revisado`);

  const by = `analysis:${input.requester.username}`;
  return await serialPerPr(pull.url, async () => {
    const existing = openAnalysisCard(await listCards(input.projectId), pull.url);
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
    const reviewerUser = await findUser(reviewer.id);
    if (!reviewerUser) throw new Error("pessoa_sem_acesso: o revisor escolhido não existe mais");
    const prompt = deliverAnalysisPrompt(card, pull, reviewerUser, coauthorTrailer).catch(async (err: unknown) => {
      logger.warn({ card: card.worktreeSlug, pr: pull.number, detail: (err as Error).message }, "PR analysis prompt not delivered — the card is purged");
      await purgeCard(card.id, by);
    });
    return { card, created: true, prompt };
  });
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
