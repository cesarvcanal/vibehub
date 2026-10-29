import type { FastifyInstance, FastifyReply } from "fastify";
import { requireSession, requestUser } from "../auth/session.js";
import { cardLevel, requireCardAccess, requireCardWork } from "../auth/access.js";
import { creatorAccountSlug, getUserGit } from "../auth/userGit.js";
import { listUsers, type PublicUser } from "../auth/users.js";
import * as registry from "../services/board/registry.js";
import { resolveIdentity } from "../services/github/identity.js";
import { getSettings } from "../services/settings/settings.js";
import { deliver } from "../services/maestro/deliver.js";
import {
  cancelReview, decideQuestion, markReviewMerged, reopenAfterHeadMoved, retryReview, startReview,
} from "../services/review/orchestrator.js";
import { activeReviewFor, getReview, listReviewsForCards } from "../services/review/store.js";
import type { Review } from "../services/review/model.js";
import { logger } from "../utils/logger.js";

/**
 * REVISÃO DE PR — a superfície HTTP do orquestrador e o ÚNICO caminho de merge de um PR revisado.
 *
 *  - quem escolhe os papéis: `GET /api/cards/:id/people` (member também chama: `GET /api/users` é do owner);
 *  - quem inicia: quem tem `work` no card do autor;
 *  - quem decide uma dúvida/item travado: o revisor humano (ou um owner);
 *  - quem tenta de novo: revisor, responsável pelo merge ou owner; quem cancela: esses e o autor;
 *  - quem MERGEIA: só o `mergerUserId`, só em `ready`, só se o head do PR ainda é o commit revisado,
 *    e com a conexão GitHub DELE (nunca a do ator do card nem a do projeto, salvo owner sem conexão).
 *
 * As regras de estado (fases, rodadas, relays) moram no orquestrador; aqui ficam quem pode chamar o
 * quê e a tradução dos erros em HTTP. Nenhuma IA chega aqui: o merge é o clique de uma pessoa.
 */

type Decision = "block" | "drop" | "keep" | "accept_risk";
const DECISIONS: ReadonlySet<string> = new Set<Decision>(["block", "drop", "keep", "accept_risk"]);

/** Os códigos que `startReview` põe na mensagem: recusa do pedido, não falha do servidor. */
const START_REFUSALS = /^(revisor_igual_autor|sem_pr|pr_mergeado|revisao_ativa|revisor_sem_conta)\b/;

interface StartBody {
  prNumber?: unknown;
  reviewerUserId?: unknown;
  authorUserId?: unknown;
  coauthorUserId?: unknown;
  mergerUserId?: unknown;
}

interface Person { id: string; username: string; canReview: boolean }

/** Quem alcança o card: os owners (veem tudo) e quem tem share no card ou no projeto dele. */
async function reachingCard(card: registry.Card): Promise<PublicUser[]> {
  const [users, onCard, onProject] = await Promise.all([
    listUsers(),
    registry.sharesForTarget("card", card.id),
    registry.sharesForTarget("project", card.projectId),
  ]);
  const shared = new Set([...onCard, ...onProject].map((s) => s.userId));
  return users.filter((u) => u.role === "owner" || shared.has(u.id));
}

/** As pessoas do card para a janela de papéis. `canReview` = tem conta Claude própria (a sessão do revisor roda nela). */
async function cardPeople(card: registry.Card): Promise<Person[]> {
  return await Promise.all(
    (await reachingCard(card)).map(async (u) => ({ id: u.id, username: u.username, canReview: !!(await creatorAccountSlug(u.id)) })),
  );
}

/**
 * A conexão GitHub com que o merge sai: a PRÓPRIA do merger, se ainda existe. Não há queda para a do
 * projeto — o merge tem de passar pela permissão do merger no GitHub (um 403 lá é a resposta certa) e
 * ficar na conta dele. A exceção é o owner sem conexão própria: ele opera com a do projeto, na mesma
 * precedência da identidade de um card (projeto, depois a primeira da instalação). Null = recusar.
 */
async function mergerConnection(user: PublicUser, card: registry.Card): Promise<string | null> {
  const [git, connections] = await Promise.all([getUserGit(user.id), registry.listGithubConnections()]);
  const own = git?.githubConnectionId;
  if (own && connections.some((c) => c.id === own)) return own;
  if (user.role !== "owner") return null;
  const project = await registry.getProject(card.projectId);
  if (!project) return null;
  return resolveIdentity({ actor: git, project, settings: await getSettings(), connections }).connectionId ?? null;
}

/** A revisão mais recente da lista (empate: a inserida depois). */
function newest(list: Review[]): Review | undefined {
  return list.reduce<Review | undefined>((latest, r) => (!latest || r.createdAt >= latest.createdAt ? r : latest), undefined);
}

/** `not found` é 404, os códigos dados são 409, o resto é erro de quem pediu. */
async function fail(reply: FastifyReply, err: unknown, conflict: RegExp | null = null): Promise<FastifyReply> {
  const message = (err as Error).message ?? "invalid request";
  const code = /not found|achado desconhecido/i.test(message) ? 404 : conflict?.test(message) ? 409 : 400;
  return await reply.code(code).send({ error: message });
}

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

/** Revisões com merge em andamento: um segundo clique não dispara um segundo deliver. */
const merging = new Set<string>();

export async function reviewRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { id: string } }>("/api/cards/:id/people", { preHandler: requireCardAccess }, async (req, reply) => {
    const card = await registry.getCard(req.params.id);
    if (!card) return await reply.code(404).send({ error: "card not found" });
    return await reply.send({ people: await cardPeople(card) });
  });

  /** A revisão do card: a ativa, ou a última (de qualquer fase) — o painel mostra o histórico. */
  app.get<{ Params: { id: string } }>("/api/cards/:id/review", { preHandler: requireCardAccess }, async (req, reply) => {
    const review = (await activeReviewFor(req.params.id)) ?? newest(await listReviewsForCards([req.params.id]));
    return await reply.send({ review: review ?? null });
  });

  app.post<{ Params: { id: string }; Body: StartBody }>(
    "/api/cards/:id/review", { preHandler: requireCardWork },
    async (req, reply) => {
      const user = (await requestUser(req))!;
      const body = req.body ?? {};
      const prNumber = typeof body.prNumber === "number" ? body.prNumber : Number.NaN;
      if (!Number.isInteger(prNumber) || prNumber <= 0) return await reply.code(400).send({ error: "prNumber inválido" });
      const roles = {
        reviewerUserId: str(body.reviewerUserId),
        authorUserId: str(body.authorUserId),
        mergerUserId: str(body.mergerUserId),
      };
      const missing = Object.entries(roles).filter(([, v]) => !v).map(([k]) => k);
      if (missing.length) return await reply.code(400).send({ error: `papéis obrigatórios: ${missing.join(", ")}` });
      const coauthorUserId = str(body.coauthorUserId) || undefined;
      if (body.coauthorUserId !== undefined && body.coauthorUserId !== null && !coauthorUserId) {
        return await reply.code(400).send({ error: "coauthorUserId inválido" });
      }
      const card = await registry.getCard(req.params.id);
      if (!card) return await reply.code(404).send({ error: "card not found" });
      if (card.reviewOf) return await reply.code(400).send({ error: "o card de um revisor não é revisado" });
      // Cada papel é alguém que alcança o card; quem não está na lista de pessoas não teria por onde acompanhar.
      const reaching = new Map((await reachingCard(card)).map((u) => [u.id, u]));
      const outside = Object.entries({ ...roles, ...(coauthorUserId ? { coauthorUserId } : {}) })
        .filter(([, id]) => !reaching.has(id))
        .map(([k]) => k);
      if (outside.length) {
        return await reply.code(400).send({ error: `pessoa_sem_acesso: ${outside.join(", ")} não alcança este card` });
      }
      // O autor vira ator do card a cada relay (commit e push na conta dele) e o merger opera nele: os
      // dois precisam de `work` aqui, senão a revisão roda inteira e trava no papel de quem não pode.
      // O revisor age no card DELE, e o orquestrador garante o `work` lá.
      const withoutWork: string[] = [];
      for (const key of ["authorUserId", "mergerUserId"] as const) {
        if ((await cardLevel(reaching.get(roles[key]) ?? null, card.id)) !== "work") withoutWork.push(key);
      }
      if (withoutWork.length) {
        return await reply.code(400).send({ error: `papel_sem_work: ${withoutWork.join(", ")} só tem leitura neste card` });
      }
      try {
        const review = await startReview({
          cardId: card.id, prNumber, ...roles, ...(coauthorUserId ? { coauthorUserId } : {}), by: user.username,
        });
        return await reply.send({ review });
      } catch (err) {
        const message = (err as Error).message ?? "";
        if (START_REFUSALS.test(message)) return await reply.code(400).send({ error: message });
        return await fail(reply, err);
      }
    },
  );

  /* ------------------------------------------------------------- por revisão */

  /** A revisão e quem chama, ou a resposta de erro já enviada (404 sem revisão, 403 fora dos papéis). */
  async function reviewFor(
    id: string, user: PublicUser | null, allowed: (r: Review, u: PublicUser) => boolean, reply: FastifyReply,
  ): Promise<{ review: Review; user: PublicUser } | null> {
    const review = await getReview(id);
    if (!review) {
      await reply.code(404).send({ error: "review not found" });
      return null;
    }
    if (!user || !allowed(review, user)) {
      await reply.code(403).send({ error: "você não tem esse papel nesta revisão" });
      return null;
    }
    return { review, user };
  }
  const isOwner = (u: PublicUser) => u.role === "owner";

  app.post<{ Params: { id: string }; Body: { findingId?: unknown; decision?: unknown } }>(
    "/api/reviews/:id/decide", { preHandler: requireSession },
    async (req, reply) => {
      const found = await reviewFor(req.params.id, await requestUser(req), (r, u) => u.id === r.reviewerUserId || isOwner(u), reply);
      if (!found) return;
      const findingId = str(req.body?.findingId);
      const decision = str(req.body?.decision);
      if (!findingId) return await reply.code(400).send({ error: "findingId obrigatório" });
      if (!DECISIONS.has(decision)) return await reply.code(400).send({ error: "decision deve ser block, drop, keep ou accept_risk" });
      try {
        return await reply.send({ review: await decideQuestion(found.review.id, findingId, decision as Decision, found.user.username) });
      } catch (err) {
        return await fail(reply, err, /não há decisão pendente/);
      }
    },
  );

  app.post<{ Params: { id: string } }>("/api/reviews/:id/retry", { preHandler: requireSession }, async (req, reply) => {
    const found = await reviewFor(
      req.params.id, await requestUser(req),
      (r, u) => u.id === r.reviewerUserId || u.id === r.mergerUserId || isOwner(u), reply,
    );
    if (!found) return;
    try {
      return await reply.send({ review: await retryReview(found.review.id, found.user.username) });
    } catch (err) {
      return await fail(reply, err, /nada_a_tentar/);
    }
  });

  app.post<{ Params: { id: string } }>("/api/reviews/:id/cancel", { preHandler: requireSession }, async (req, reply) => {
    const found = await reviewFor(
      req.params.id, await requestUser(req),
      (r, u) => [r.reviewerUserId, r.authorUserId, r.mergerUserId].includes(u.id) || isOwner(u), reply,
    );
    if (!found) return;
    try {
      return await reply.send({ review: await cancelReview(found.review.id, found.user.username) });
    } catch (err) {
      return await fail(reply, err, /revisao_encerrada/);
    }
  });

  /**
   * O MERGE. Só o responsável pelo merge (nem o owner: o clique dele é a autorização que a revisão
   * pediu), só em `ready`, e preso ao commit que o revisor aprovou: o deliver roda em modo só-merge
   * (sem push) e recusa `head_moved` quando o PR andou — aí a revisão volta à rodada seguinte, ou a
   * impasse na última. O deliver recebe a conexão GitHub do merger (`mergerConnection`); sem uma,
   * 400 `merger_sem_github` e nada roda. Uma recusa do GitHub (403) volta como veio, sem outra credencial.
   */
  app.post<{ Params: { id: string } }>("/api/reviews/:id/merge", { preHandler: requireSession }, async (req, reply) => {
    const found = await reviewFor(req.params.id, await requestUser(req), (r, u) => u.id === r.mergerUserId, reply);
    if (!found) return;
    const { review, user } = found;
    if (review.phase !== "ready") {
      return await reply.code(409).send({
        error: `a revisão está em ${review.phase}: o merge só sai em ready`, reason: "not_ready", phase: review.phase,
      });
    }
    if (!review.reviewedSha) {
      return await reply.code(409).send({ error: "a revisão não tem o commit revisado", reason: "not_ready", phase: review.phase });
    }
    // Acesso conferido de novo no clique: um share que caiu depois do início tira o merge também.
    if ((await cardLevel(user, review.cardId)) !== "work") {
      return await reply.code(403).send({ error: "o responsável pelo merge precisa de acesso de trabalho ao card do autor" });
    }
    const card = await registry.getCard(review.cardId);
    if (!card) return await reply.code(404).send({ error: "card not found" });
    const connectionId = await mergerConnection(user, card);
    if (!connectionId) {
      return await reply.code(400).send({
        error: "merger_sem_github: o responsável pelo merge não tem uma conexão GitHub própria no vibehub",
        reason: "merger_sem_github",
      });
    }
    if (merging.has(review.id)) return await reply.code(409).send({ error: "merge já em andamento", reason: "merging" });
    merging.add(review.id);
    try {
      // Relida com a trava na mão: um clique anterior pode ter acabado (merged) entre a leitura e aqui.
      const now = await getReview(review.id);
      if (now?.phase !== "ready" || now.reviewedSha !== review.reviewedSha) {
        return await reply.code(409).send({
          error: `a revisão está em ${now?.phase ?? "?"}: o merge só sai em ready`, reason: "not_ready", phase: now?.phase,
        });
      }
      // A conexão vai explícita: o ator do card (o autor) não muda, e uma mensagem no card durante o
      // merge não troca a credencial debaixo dele.
      const result = await deliver(review.cardId, {
        authorized: true, mergeOnly: true, expectedHeadSha: review.reviewedSha, branch: review.base, connectionId, by: user.username,
      });
      logger.info(
        { audit: true, action: "review.merge", review: review.id, merged: result.merged, reason: result.reason, by: user.username },
        result.merged ? "PR review merged by its merger" : "PR review merge did not happen",
      );
      if (result.merged) return await reply.send({ review: await markReviewMerged(review.id, user.username), result });
      if (result.reason === "head_moved") {
        const after = await reopenAfterHeadMoved(review.id, user.username);
        return await reply.code(409).send({ error: result.output ?? "o PR andou depois do pronto", reason: "head_moved", review: after, result });
      }
      return await reply.code(409).send({
        error: result.output ?? `merge não feito: ${result.reason}`, reason: result.reason, review: (await getReview(review.id)) ?? review, result,
      });
    } catch (err) {
      logger.warn({ review: review.id, detail: (err as Error).message }, "PR review merge failed");
      return await reply.code(500).send({ error: (err as Error).message });
    } finally {
      merging.delete(review.id);
    }
  });
}
