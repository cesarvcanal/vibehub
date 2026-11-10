import { cardLevel } from "../../auth/access.js";
import { getUserGit } from "../../auth/userGit.js";
import { findUser, type PublicUser } from "../../auth/users.js";
import * as registry from "../board/registry.js";
import { resolveIdentity } from "../github/identity.js";
import { getSettings } from "../settings/settings.js";
import { deliver, type DeliverResult } from "../maestro/deliver.js";
import { logger } from "../../utils/logger.js";
import { canMergeReview, type Review, type ReviewPhase } from "./model.js";
import { claimMerge, markReviewMerged, mergeGateRunning, releaseMerge, reopenAfterHeadMoved } from "./orchestrator.js";
import { getReview } from "./store.js";

/**
 * O MERGE DE UM PR REVISADO — um caminho só, chamado de três lugares: o botão "Mergear" do painel
 * (`POST /api/reviews/:id/merge`), o `vibehub_deliver` autorizado quando quem deu a ordem ao card é
 * o responsável pelo merge da revisão, e o merge automático da revisão pronta sem nada em pé (o
 * servidor, depois do Approve do revisor; decisão do usuário em 05/11/2026). Os três fazem
 * exatamente o mesmo, com as mesmas recusas:
 *
 *  - só quem tem papel na revisão (`canMergeReview`: responsável, revisor, autor, coautor), só em
 *    `ready`, só com o commit revisado gravado;
 *  - quem mergeia precisa de `work` no card do autor (conferido de novo aqui: um share que caiu
 *    depois do início tira o merge também) e de uma conexão GitHub PRÓPRIA (`ownGithubConnection`);
 *  - um merge por vez por revisão (`claimMerge`): um segundo clique, ou o deliver junto do botão, não
 *    dispara um segundo — e a conferência do GitHub não fecha por fora um merge que está saindo;
 *  - o deliver roda em modo só-merge, preso ao commit que o revisor aprovou: um PR que andou volta
 *    `head_moved` e a revisão é reaberta (rodada seguinte, ou impasse na última); CI vermelho volta
 *    `gate`; mergeado, a revisão fecha como no botão (avisos, card do revisor para `done`).
 *
 * Devolve o desfecho com o status HTTP que a rota responde, para a rota e o deliver contarem a mesma
 * história. Nunca mergeia nada fora disso.
 */

export type ReviewMergeOutcome =
  | { kind: "merged"; review: Review; result: DeliverResult }
  | {
    kind: "refused";
    status: 400 | 403 | 404 | 409 | 500;
    error: string;
    reason?: string;
    phase?: ReviewPhase;
    review?: Review;
    result?: DeliverResult;
  };

/**
 * A conexão GitHub PRÓPRIA de quem tem um papel que sai na conta dele: o merger (o merge) e o revisor
 * (os `gh pr review` do card do revisor). A própria, se ainda existe; não há queda para a do projeto —
 * o merge tem de passar pela permissão do merger no GitHub (um 403 lá é a resposta certa), e um review
 * na conta do projeto (que muitas vezes é a que abriu o PR) é recusado pelo GitHub como "review do
 * próprio PR" e trava a revisão a cada rodada. A exceção é o owner sem conexão própria: ele opera
 * com a do projeto, na mesma precedência da identidade de um card (projeto, depois a primeira da
 * instalação). Null = recusar.
 */
export async function ownGithubConnection(user: PublicUser, card: registry.Card): Promise<string | null> {
  const [git, connections] = await Promise.all([getUserGit(user.id), registry.listGithubConnections()]);
  const own = git?.githubConnectionId;
  if (own && connections.some((c) => c.id === own)) return own;
  if (user.role !== "owner") return null;
  const project = await registry.getProject(card.projectId);
  if (!project) return null;
  return resolveIdentity({ actor: git, project, settings: await getSettings(), connections }).connectionId ?? null;
}

/**
 * Mergeia o PR da revisão `reviewId` em nome de `userId`, ou diz por que não. Ver o topo do arquivo.
 * `auto`: é o merge automático da revisão pronta sem nada em pé (orchestrator `autoMerge`), não um
 * clique — as mesmas travas, mas o log e a auditoria dizem que ninguém clicou.
 */
export async function mergeReviewedPr(
  reviewId: string, userId: string, opts: { auto?: boolean } = {},
): Promise<ReviewMergeOutcome> {
  const review = await getReview(reviewId);
  if (!review) return { kind: "refused", status: 404, error: "review not found" };
  const user = await findUser(userId);
  if (!user || !canMergeReview(review, user.id)) {
    return { kind: "refused", status: 403, error: "você não tem esse papel nesta revisão", reason: "not_merger" };
  }
  if (review.phase !== "ready") {
    return {
      kind: "refused", status: 409, reason: "not_ready", phase: review.phase,
      error: `a revisão está em ${review.phase}: o merge só sai em ready`,
    };
  }
  if (!review.reviewedSha) {
    return { kind: "refused", status: 409, reason: "not_ready", phase: review.phase, error: "a revisão não tem o commit revisado" };
  }
  if ((await cardLevel(user, review.cardId)) !== "work") {
    return { kind: "refused", status: 403, error: "quem mergeia precisa de acesso de trabalho ao card do autor" };
  }
  const card = await registry.getCard(review.cardId);
  if (!card) return { kind: "refused", status: 404, error: "card not found" };
  const connectionId = await ownGithubConnection(user, card);
  if (!connectionId) {
    return {
      kind: "refused", status: 400, reason: "merger_sem_github",
      error: "merger_sem_github: quem mergeia não tem uma conexão GitHub própria no vibehub",
    };
  }
  // O gate do merge já rodou (ou roda) no commit aprovado desde que a revisão ficou pronta: o clique
  // não espera minutos para descobrir o que já se sabe.
  const gate = review.mergeGate?.sha === review.reviewedSha ? review.mergeGate : undefined;
  if (gate?.state === "running" && mergeGateRunning(review.id)) {
    return {
      kind: "refused", status: 409, reason: "gate_running", phase: review.phase,
      error: "os testes do merge ainda estão rodando no commit aprovado: o merge libera quando terminarem",
    };
  }
  if (gate?.state === "failed") {
    return {
      kind: "refused", status: 409, reason: "gate", phase: review.phase,
      error: `os testes do merge falharam no commit aprovado; o autor recebeu a falha. Depois da correção, "Tentar de novo" roda os testes outra vez.\n\n${gate.output ?? ""}`.trimEnd(),
    };
  }
  if (!claimMerge(review.id)) return { kind: "refused", status: 409, reason: "merging", error: "merge já em andamento" };
  try {
    // Relida com a trava na mão: um pedido anterior pode ter acabado (merged) entre a leitura e aqui.
    const now = await getReview(review.id);
    if (now?.phase !== "ready" || now.reviewedSha !== review.reviewedSha) {
      return {
        kind: "refused", status: 409, reason: "not_ready", phase: now?.phase,
        error: `a revisão está em ${now?.phase ?? "?"}: o merge só sai em ready`,
      };
    }
    // A conexão vai explícita: o ator do card (o autor) não muda, e uma mensagem no card durante o
    // merge não troca a credencial debaixo dele.
    const by = opts.auto ? `${user.username} (merge automático)` : user.username;
    const result = await deliver(review.cardId, {
      authorized: true, mergeOnly: true, expectedHeadSha: review.reviewedSha, branch: review.base, connectionId, by,
      gatePassed: now.mergeGate?.sha === now.reviewedSha && now.mergeGate?.state === "passed",
    });
    logger.info(
      {
        audit: true, action: opts.auto ? "review.automerge" : "review.merge", review: review.id,
        merged: result.merged, reason: result.reason, by: user.username, auto: opts.auto === true,
      },
      result.merged ? "PR review merged by its merger" : "PR review merge did not happen",
    );
    if (result.merged) {
      return { kind: "merged", review: await markReviewMerged(review.id, user.username, { auto: opts.auto }), result };
    }
    if (result.reason === "head_moved") {
      const after = await reopenAfterHeadMoved(review.id, user.username);
      return { kind: "refused", status: 409, reason: "head_moved", error: result.output ?? "o PR andou depois do pronto", review: after, result };
    }
    return {
      kind: "refused", status: 409, reason: result.reason, error: result.output ?? `merge não feito: ${result.reason}`,
      review: (await getReview(review.id)) ?? review, result,
    };
  } catch (err) {
    logger.warn({ review: review.id, detail: (err as Error).message }, "PR review merge failed");
    return { kind: "refused", status: 500, error: (err as Error).message };
  } finally {
    releaseMerge(review.id);
  }
}
