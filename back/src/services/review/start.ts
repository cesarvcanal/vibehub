import { cardLevel } from "../../auth/access.js";
import { getUserGit } from "../../auth/userGit.js";
import { findUser, listUsers, type PublicUser } from "../../auth/users.js";
import * as registry from "../board/registry.js";
import { ownGithubConnection } from "./merge.js";
import type { Review } from "./model.js";
import { startReview } from "./orchestrator.js";

/**
 * QUEM PODE PEDIR UMA REVISÃO, e com quais papéis — a mesma regra para o "Pedir revisão" do painel
 * (`POST /api/cards/:id/review`) e para a IA do card (`vibehub_review_start`), que pede pela pessoa que
 * deu a ordem no chat. Antes a regra morava na rota, e a IA não tinha por onde pedir: a pessoa dizia
 * "o albert revisa e é coautor, pode mergear" e ainda tinha que abrir o diálogo e escolher tudo de novo
 * (produção, 2026-11-06).
 *
 * Recusas com o código na mensagem (a rota traduz em 400): `papeis_obrigatorios`, `card_de_revisor`,
 * `pessoa_sem_acesso`, `papel_sem_work`, `revisor_sem_github`, mais as do `startReview`.
 */

export interface ReviewRoles {
  reviewerUserId: string;
  authorUserId: string;
  coauthorUserId?: string;
  mergerUserId: string;
}

/** Quem alcança o card: os owners (veem tudo) e quem tem share no card ou no projeto dele. */
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
 * Confere os papéis e abre a revisão. `requester` é quem pede (a sessão do painel, ou a pessoa que deu
 * a ordem ao card): precisa de `work` no card, como na rota.
 */
export async function startReviewChecked(input: {
  card: registry.Card;
  prNumber: number;
  roles: ReviewRoles;
  requester: PublicUser;
  /** O que quem mergeia já mandou fazer no fim (ver {@link AgentReviewRequest}). */
  orders?: { mergeAuthorized?: boolean; concludeWhenMerged?: boolean };
}): Promise<Review> {
  const { card, prNumber, roles, requester } = input;
  // Mergear e concluir no fim são ordens de quem mergeia: o merge sai em nome dele, e ninguém dá essa
  // ordem por outra pessoa.
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
  // Cada papel é alguém que alcança o card; quem não está na lista de pessoas não teria por onde acompanhar.
  const reaching = new Map((await reachingCard(card)).map((u) => [u.id, u]));
  const outside = Object.entries({ ...required, ...(roles.coauthorUserId ? { coauthorUserId: roles.coauthorUserId } : {}) })
    .filter(([, id]) => !reaching.has(id))
    .map(([k]) => k);
  if (outside.length) throw new Error(`pessoa_sem_acesso: ${outside.join(", ")} não alcança este card`);
  // O autor vira ator do card a cada relay (commit e push na conta dele) e o merger opera nele: os
  // dois precisam de `work` aqui, senão a revisão roda inteira e trava no papel de quem não pode.
  // O revisor age no card DELE, e o orquestrador garante o `work` lá.
  const withoutWork: string[] = [];
  for (const key of ["authorUserId", "mergerUserId"] as const) {
    if ((await cardLevel(reaching.get(roles[key]) ?? null, card.id)) !== "work") withoutWork.push(key);
  }
  if (withoutWork.length) throw new Error(`papel_sem_work: ${withoutWork.join(", ")} só tem leitura neste card`);
  // Os reviews do PR saem do card do revisor, na identidade dele: sem conexão própria, iriam na do
  // projeto (a regra do merger vale aqui também; owner sem conexão usa a do projeto). Revisor igual
  // ao autor fica com a recusa própria, do `startReview`.
  const reviewer = reaching.get(roles.reviewerUserId);
  if (reviewer && reviewer.id !== roles.authorUserId && !(await ownGithubConnection(reviewer, card))) {
    throw new Error("revisor_sem_github: o revisor não tem uma conexão GitHub própria no vibehub (os reviews do PR sairiam na conta de outra pessoa)");
  }
  return await startReview({
    cardId: card.id, prNumber, ...required, ...(roles.coauthorUserId ? { coauthorUserId: roles.coauthorUserId } : {}),
    ...(input.orders?.mergeAuthorized ? { mergeAuthorized: true } : {}),
    ...(input.orders?.concludeWhenMerged ? { concludeWhenMerged: true } : {}),
    by: requester.username,
  });
}

/** O que a IA do card passa: nomes de usuário do vibehub, como a pessoa falou no chat. */
export interface AgentReviewRequest {
  /** O PR do card a revisar. Ausente = o único PR aberto do card (mais de um: tem que dizer qual). */
  pr?: number;
  reviewer: string;
  /** Quem corrige. Ausente = o mesmo que o diálogo sugere (autor do PR anexado, ou quem trabalha o card). */
  author?: string;
  coauthor?: string;
  /** Quem mergeia. Ausente = quem deu a ordem. */
  merger?: string;
  /**
   * Quem deu a ordem já mandou mergear quando terminar ("terminando pode mergear"). Só vale quando ele
   * é quem mergeia: ninguém autoriza o merge de outra pessoa (`merge_autorizado_de_outro`).
   */
  mergeWhenReady?: boolean;
  /** E concluir o card quando mergear. Mesma regra: a ordem é de quem mergeia. */
  concludeWhenMerged?: boolean;
}

/**
 * A REVISÃO PEDIDA PELA IA do card, em nome de quem deu a ordem (o ator: quem mandou a última mensagem).
 * Os padrões são os do diálogo do painel — o que a pessoa não falou fica como ela veria pré-escolhido —
 * e as conferências, as mesmas (`startReviewChecked`). O merge continua sendo o de sempre: o automático
 * quando a revisão fica pronta sem nada em pé, ou o botão de quem mergeia.
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

/** O autor que o diálogo pré-escolhe: quem abriu o PR anexado (pela conexão GitHub), senão o ator do card. */
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
