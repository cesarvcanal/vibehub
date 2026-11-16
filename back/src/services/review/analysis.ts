import { creatorAccountSlug, getUserGit } from "../../auth/userGit.js";
import type { PublicUser } from "../../auth/users.js";
import { recordCardActor } from "../board/actor.js";
import {
  createAnalysisCard, getProject, listCards, listGithubConnections, recordCardPr, type Card,
} from "../board/registry.js";
import { listOpenPulls, splitRepo, type OpenPull } from "../github/client.js";
import { resolveIdentity } from "../github/identity.js";
import type { MessageOrigin } from "../chat/provenance.js";
import { sendToTerminal, SEND_READY_WAIT_MS } from "../maestro/maestro.js";
import { getSettings } from "../settings/settings.js";
import { analysisPrompt } from "./prompts.js";

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
}

/** The open analysis card of a PR: an analysis card (`pushBranch`) not done that recorded this PR's URL. */
function openAnalysisOf(cards: Card[], prUrl: string): Card | undefined {
  return cards.find((c) => c.pushBranch !== undefined && c.column !== "done" && (c.prs ?? []).some((p) => p.url === prUrl));
}

async function readProjectPulls(projectId: string, user: PublicUser): Promise<{ pulls: OpenPull[]; cards: Card[] }> {
  const project = await getProject(projectId);
  if (!project) throw new Error("project not found");
  if (!project.repoFullName) throw new Error("sem_repositorio: o projeto não tem repositório no GitHub");
  const { owner, repo } = splitRepo(project.repoFullName);
  const [actor, settings, connections] = await Promise.all([getUserGit(user.id), getSettings(), listGithubConnections()]);
  const { connectionId } = resolveIdentity({ actor, project, settings, connections });
  const [pulls, cards] = await Promise.all([listOpenPulls(connectionId, owner, repo), listCards(projectId)]);
  return { pulls, cards };
}

export async function listProjectPulls(projectId: string, user: PublicUser): Promise<ProjectPull[]> {
  const { pulls, cards } = await readProjectPulls(projectId, user);
  return pulls.map((pull) => {
    const card = openAnalysisOf(cards, pull.url);
    return card ? { ...pull, analysisCardId: card.id } : pull;
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
 * the code in the message, which the route turns into 400: `sem_repositorio`, `pr_nao_aberta`, `pr_fork`.
 */
export async function startAnalysis(input: {
  projectId: string;
  prNumber: number;
  requester: PublicUser;
}): Promise<{ card: Card; created: boolean }> {
  const { pulls } = await readProjectPulls(input.projectId, input.requester);
  const pull = pulls.find((p) => p.number === input.prNumber);
  if (!pull) throw new Error(`pr_nao_aberta: o PR #${input.prNumber} não está aberto neste repositório`);
  if (pull.fromFork) throw new Error(`pr_fork: o PR #${pull.number} vem de outro repositório, e a correção não tem onde ser empurrada`);

  return await serialPerPr(pull.url, async () => {
    const existing = openAnalysisOf(await listCards(input.projectId), pull.url);
    if (existing) return { card: existing, created: false };

    const card = await createAnalysisCard({
      projectId: input.projectId,
      accountSlug: await creatorAccountSlug(input.requester.id),
      prBranch: pull.branch,
      title: `Análise PR #${pull.number} · ${pull.title}`,
    });
    await recordCardPr(card.id, { number: pull.number, url: pull.url, base: pull.base, branch: pull.branch, title: pull.title, author: pull.author });
    await sendToTerminal(card.id, analysisPrompt({ cardId: card.id, prNumber: pull.number, prUrl: pull.url, branch: pull.branch, base: pull.base }), {
      by: `analysis:${input.requester.username}`,
      origin: ANALYSIS_ORIGIN,
      // Same delivery as the review's relay: wake the new card, wait for Claude, never type into a menu,
      // and go through the native chat so the conversation does not fork.
      wake: true,
      requireAgent: true,
      guardInteractiveMenu: true,
      readyWaitMs: SEND_READY_WAIT_MS,
      viaNativeChat: true,
      beforeDeliver: async () => recordCardActor(input.requester, card.id),
    });
    return { card, created: true };
  });
}
