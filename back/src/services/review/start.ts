import { cardLevel } from "../../auth/access.js";
import { getUserGit } from "../../auth/userGit.js";
import { findUser, listUsers, type PublicUser } from "../../auth/users.js";
import * as registry from "../board/registry.js";
import { ownGithubConnection } from "./merge.js";
import type { Review, ReviewOrders } from "./model.js";
import { startReview } from "./orchestrator.js";

/**
 * WHO MAY ASK FOR A REVIEW, and with which roles — the same rule for the panel's "Pedir revisão"
 * (`POST /api/cards/:id/review`) and for the card's AI (`vibehub_review_start`), which asks on behalf of
 * the person who gave the order in the chat. The rule used to live in the route, and the AI had no way to
 * ask: the person would say "o albert revisa e é coautor, pode mergear" and still had to open the dialog
 * and pick everything again (production, 2026-11-06).
 *
 * Refusals with the code in the message (the route translates them into 400): `papeis_obrigatorios`,
 * `card_de_revisor`, `pessoa_sem_acesso`, `papel_sem_work`, `revisor_sem_github`, plus those of `startReview`.
 */

export interface ReviewRoles {
  reviewerUserId: string;
  authorUserId: string;
  coauthorUserId?: string;
  mergerUserId: string;
}

/** Who reaches the card: the owners (they see everything) and whoever has a share on the card or on its project. */
export async function reachingCard(card: registry.Card): Promise<PublicUser[]> {
  const [users, onCard, onProject] = await Promise.all([
    listUsers(),
    registry.sharesForTarget("card", card.id),
    registry.sharesForTarget("project", card.projectId),
  ]);
  const shared = new Set([...onCard, ...onProject].map((s) => s.userId));
  return users.filter((u) => u.role === "owner" || shared.has(u.id));
}

/**
 * Checks the roles and opens the review. `requester` is who asks (the panel's session, or the person who
 * gave the order to the card): it needs `work` on the card, as in the route.
 */
export async function startReviewChecked(input: {
  card: registry.Card;
  prNumber: number;
  roles: ReviewRoles;
  requester: PublicUser;
  /** What whoever merges already ordered for the end (see {@link AgentReviewRequest}). */
  orders?: ReviewOrders;
}): Promise<Review> {
  const { card, prNumber, roles, requester } = input;
  // Merging and completing at the end are orders of whoever merges: the merge goes out on their behalf, and
  // nobody gives that order for somebody else.
  if ((input.orders?.mergeAuthorized || input.orders?.concludeWhenMerged) && roles.mergerUserId !== requester.id) {
    throw new Error("merge_autorizado_de_outro: só quem mergeia pode mandar mergear (ou concluir o card) quando a revisão terminar");
  }
  const required = { reviewerUserId: roles.reviewerUserId, authorUserId: roles.authorUserId, mergerUserId: roles.mergerUserId };
  const missing = Object.entries(required).filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) throw new Error(`papeis_obrigatorios: ${missing.join(", ")}`);
  if (card.reviewOf) throw new Error("card_de_revisor: o card de um revisor não é revisado");
  if ((await cardLevel(requester, card.id)) !== "work") {
    throw new Error(`pessoa_sem_acesso: ${requester.username} não tem work neste card para pedir a revisão`);
  }
  // Each role is somebody who reaches the card; whoever is not on the people list would have no way to follow along.
  const reaching = new Map((await reachingCard(card)).map((u) => [u.id, u]));
  const outside = Object.entries({ ...required, ...(roles.coauthorUserId ? { coauthorUserId: roles.coauthorUserId } : {}) })
    .filter(([, id]) => !reaching.has(id))
    .map(([k]) => k);
  if (outside.length) throw new Error(`pessoa_sem_acesso: ${outside.join(", ")} não alcança este card`);
  // The author becomes the card's actor at each relay (commit and push on their account) and the merger
  // operates on it: both need `work` here, otherwise the review runs all the way and gets stuck on the role
  // of whoever cannot. The reviewer acts on THEIR card, and the orchestrator guarantees the `work` there.
  const withoutWork: string[] = [];
  for (const key of ["authorUserId", "mergerUserId"] as const) {
    if ((await cardLevel(reaching.get(roles[key]) ?? null, card.id)) !== "work") withoutWork.push(key);
  }
  if (withoutWork.length) throw new Error(`papel_sem_work: ${withoutWork.join(", ")} só tem leitura neste card`);
  // The PR reviews go out from the reviewer's card, under their identity: without their own connection,
  // they would go on the project's (the merger's rule applies here too; an owner with no connection uses
  // the project's). A reviewer equal to the author gets its own refusal, from `startReview`.
  const reviewer = reaching.get(roles.reviewerUserId);
  if (reviewer && reviewer.id !== roles.authorUserId && !(await ownGithubConnection(reviewer, card))) {
    throw new Error("revisor_sem_github: o revisor não tem uma conexão GitHub própria no vibehub (os reviews do PR sairiam na conta de outra pessoa)");
  }
  return await startReview({
    cardId: card.id, prNumber, ...required, ...(roles.coauthorUserId ? { coauthorUserId: roles.coauthorUserId } : {}),
    ...(input.orders ? { orders: input.orders } : {}),
    by: requester.username,
  });
}

/** What the card's AI passes: vibehub usernames, as the person said them in the chat. */
export interface AgentReviewRequest {
  /** The card's PR to review. Absent = the card's only open PR (more than one: it has to say which). */
  pr?: number;
  reviewer: string;
  /** Who fixes. Absent = the same one the dialog suggests (the attached PR's author, or whoever works the card). */
  author?: string;
  coauthor?: string;
  /** Quem mergeia. Ausente = quem deu a ordem. */
  merger?: string;
  /**
   * Whoever gave the order already said to merge when done ("terminando pode mergear"). Only valid when
   * they are the one who merges: nobody authorises somebody else's merge (`merge_autorizado_de_outro`).
   */
  mergeWhenReady?: boolean;
  /** And complete the card when merged. Same rule: the order belongs to whoever merges. */
  concludeWhenMerged?: boolean;
}

/**
 * THE REVIEW ASKED FOR BY THE card's AI, on behalf of whoever gave the order (the actor: who sent the latest
 * message). The defaults are the panel dialog's — whatever the person did not say stays as they would see
 * it pre-selected — and the checks are the same (`startReviewChecked`). The merge is still the usual one:
 * the automatic one when the review is ready with nothing standing, or the button of whoever merges.
 */
export async function startReviewByAgent(cardId: string, req: AgentReviewRequest): Promise<Review> {
  const card = await registry.getCard(cardId);
  if (!card) throw new Error("card not found");
  const requester = card.actorUserId ? await findUser(card.actorUserId) : null;
  if (!requester) throw new Error("sem_ordem: ninguém deu ordem a este card ainda; a revisão é pedida em nome de quem falou com ele");
  const reaching = await reachingCard(card);
  const byName = (role: string, name: string): string => {
    const wanted = name.trim().replace(/^@/, "").toLowerCase();
    const user = reaching.find((u) => u.username.toLowerCase() === wanted);
    if (!user) {
      const known = reaching.map((u) => u.username).join(", ");
      throw new Error(`pessoa_desconhecida: ${role} "${name}" não alcança este card (pessoas do card: ${known})`);
    }
    return user.id;
  };

  const open = (card.prs ?? []).filter((p) => p.mergedAt === undefined);
  const pr = req.pr !== undefined ? (card.prs ?? []).find((p) => p.number === req.pr) : open.length === 1 ? open[0] : undefined;
  if (!pr) {
    const list = open.map((p) => `#${p.number}`).join(", ") || "nenhum";
    throw new Error(req.pr !== undefined
      ? `sem_pr: o card não tem o PR #${req.pr} (PRs abertos: ${list})`
      : `sem_pr: diga qual PR revisar (PRs abertos do card: ${list})`);
  }

  const reviewerUserId = byName("revisor", req.reviewer);
  const authorUserId = req.author ? byName("autor", req.author) : await defaultAuthor(card, pr, reaching);
  if (!authorUserId) throw new Error("autor_indefinido: diga quem corrige (o autor do PR anexado não tem conta no vibehub)");
  return await startReviewChecked({
    card,
    prNumber: pr.number,
    requester,
    roles: {
      reviewerUserId,
      authorUserId,
      ...(req.coauthor ? { coauthorUserId: byName("coautor", req.coauthor) } : {}),
      mergerUserId: req.merger ? byName("merger", req.merger) : requester.id,
    },
    orders: { mergeAuthorized: req.mergeWhenReady === true, concludeWhenMerged: req.concludeWhenMerged === true },
  });
}

/** The author the dialog pre-selects: whoever opened the attached PR (through the GitHub connection), otherwise the card's actor. */
async function defaultAuthor(card: registry.Card, pr: registry.CardPr, reaching: PublicUser[]): Promise<string | undefined> {
  if (!pr.attached) return card.actorUserId;
  if (!pr.author) return undefined;
  for (const u of reaching) {
    const own = (await getUserGit(u.id))?.githubConnectionId;
    const login = own ? (await registry.getGithubConnection(own))?.login : undefined;
    if (login && login.toLowerCase() === pr.author.toLowerCase()) return u.id;
  }
  return undefined;
}
