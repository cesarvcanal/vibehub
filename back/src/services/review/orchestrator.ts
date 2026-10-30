import { randomUUID } from "node:crypto";
import {
  getCard, createReviewerCard, removeCard, updateCard, cardMoveEffect, isHumanActive, shareWith, getGithubConnection,
} from "../board/registry.js";
import { resumeCard } from "../board/workspace.js";
import { recordCardActor } from "../board/actor.js";
import { findUser } from "../../auth/users.js";
import { cardLevel } from "../../auth/access.js";
import { creatorAccountSlug, getUserGit } from "../../auth/userGit.js";
import { sendToTerminal, SEND_READY_WAIT_MS } from "../maestro/maestro.js";
import { afterPrMerged, readPrState, setPrPeople } from "../maestro/deliver.js";
import type { MessageOrigin } from "../chat/provenance.js";
import { eventsAfter, onCardEvent, recordMessage, type CardEvent, type Severity } from "../events/cardEvents.js";
import { logger } from "../../utils/logger.js";
import {
  MAX_ROUNDS, applyAuthorResponses, applyReviewerVerdicts, blockingOpen, normalizeSubmittedFindings, pendingQuestions,
  phaseAfterReviewerRound,
  type AuthorAnswerStatus, type Finding, type FindingStatus, type Review, type ReviewEvent, type ReviewEventItem, type ReviewPhase,
  type SubmittedFinding,
} from "./model.js";
import {
  activeReviewFor, getReview, insertReview, listReviewsForCards, mutateReview, reviewByReviewerCard,
} from "./store.js";
import {
  actionableForAuthor, approvePendingText, authorFixPrompt, headMovedPrefix, impasseText, nudgePrefix, oneLine,
  phaseNoticeText, questionNoticeText, reviewerApprovePrompt, reviewerDeltaPrompt, reviewerRoundPrompt,
} from "./prompts.js";

/**
 * ORQUESTRADOR DA REVISÃO DE PR — o servidor é o carteiro entre a IA do revisor (num card escondido,
 * na conta Claude do revisor) e a IA do autor (no card do autor). Nenhuma pessoa leva recado.
 *
 *   startReview ──► card do revisor: rodada 1 (/code-review)
 *   vibehub_review_submit ──► fixing: lista fechada ao autor | ready: Approve no GitHub | impasse
 *   vibehub_review_respond ──► rodada N+1: o revisor confere só o diff
 *   turn_finished sem a ferramenta ──► um lembrete; no segundo, impasse "IA não respondeu"
 *   humano ──► decideQuestion | retryReview (impasse por falha, Approve pendente) | cancelReview
 *   botão de merge (rota) ──► markReviewMerged | head do PR andou: reopenAfterHeadMoved
 *   o PR no GitHub (fim de turno do autor; painel aberto, com freio) ──► syncReviewWithGithub:
 *     mergeado fora do painel → merged | fechado sem merge → cancelled | push depois do pronto → reopen
 *
 * As regras do jogo (prova, lista fechada, teto de rodadas) moram no modelo puro; aqui ficam a
 * persistência, quem pode chamar o quê e os relays. Três garantias atravessam o arquivo:
 *
 *  - IDEMPOTÊNCIA: a mesma rodada submetida/respondida duas vezes (retry da IA) não dispara um
 *    segundo relay. A checagem é refeita DENTRO da mutação, então dois submits simultâneos também
 *    viram um só.
 *  - AUTORIA: antes de cada texto, o ator do card destino vira a pessoa daquele lado (autor no card
 *    do autor, revisor no do revisor), no `beforeDeliver` do envio: um envio recusado não mexe na
 *    autoria, e o commit/push/review que o texto provocar sai na conta certa.
 *  - NUNCA PARADO EM SILÊNCIO: um envio que falha (card concluído, Claude que não sobe) vira
 *    `impasse` com o erro como motivo, aviso nos cards do autor e do revisor e warn no log; e todo
 *    impasse que não é de rodadas tem saída (`retryReview`), além do `cancelReview`.
 *
 * E uma ausência deliberada: nada aqui mergeia. O merge é a rota humana (`routes/reviews.ts`), que só
 * conta para cá o que aconteceu.
 */

/** Quem assina as falas que o orquestrador digita nos cards. */
const REVIEW_ORIGIN: MessageOrigin = { kind: "system", name: "revisão de PR" };

/** O que o fim de turno espera antes de julgar: a chamada da ferramenta no mesmo turno ganha. */
export const TURN_GRACE_MS = 1_500;

/** Vereditos que a IA do revisor pode dar. `accepted_risk` é só de humano (decideQuestion). */
const REVIEWER_VERDICTS: ReadonlySet<FindingStatus> = new Set(["fixed", "open", "dropped"]);

/** Sha completo (SHA-1, ou SHA-256 num repo que use): o merge compara com o head do PR, abreviado não serve. */
export const HEAD_SHA_RE = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i;

const NO_ANSWER = "IA não respondeu";
/** Motivo do impasse quando o PR andou depois do `ready` e não sobra rodada para conferir o que entrou. */
export const HEAD_MOVED = "push depois do pronto";
const CLOSED: ReadonlySet<ReviewPhase> = new Set(["merged", "cancelled"]);

type Side = "reviewer" | "author";
type Decision = "block" | "drop" | "keep" | "accept_risk";

/* ------------------------------------------------------------------ helpers */

/** Teto de cada resposta citada numa fala: o bastante pra ler o argumento, sem virar página. */
const REPLY_MAX = 600;

/**
 * Uma fala no log da revisão. `items` são os achados de que ela trata, com a resposta de cada um
 * naquele momento (é o que a conversa das IAs mostra rodada a rodada); `by`, quem fez, numa fala humana.
 */
function note(r: Review, who: ReviewEvent["who"], text: string, extra: { items?: ReviewEventItem[]; by?: string } = {}): void {
  const event: ReviewEvent = { at: Date.now(), round: r.round, who, text: oneLine(text, 400) };
  const items = (extra.items ?? []).map((it) => {
    const item: ReviewEventItem = { id: it.id, status: it.status };
    if (it.reply !== undefined && it.reply.trim() !== "") item.reply = oneLine(it.reply, REPLY_MAX);
    if (it.commit !== undefined && it.commit.trim() !== "") item.commit = oneLine(it.commit, 64);
    if (it.isNew) item.isNew = true;
    return item;
  });
  if (items.length) event.items = items;
  if (extra.by) event.by = extra.by;
  r.log.push(event);
}

function assertHeadSha(sha: string): string {
  const v = String(sha ?? "").trim();
  if (!HEAD_SHA_RE.test(v)) {
    throw new Error("headSha inválido: mande o sha completo de `git rev-parse HEAD` (40 caracteres hex)");
  }
  return v.toLowerCase();
}

/** O que bloqueia agora: bloqueante em pé ou dúvida que o humano decidiu bloquear. */
const blockingNow = (r: Review): Finding[] => r.findings.filter(actionableForAuthor);

/** Esperando a ferramenta deste lado, nesta rodada. É o que o fim de turno sem chamada cobra. */
function awaitingTool(r: Review, side: Side): boolean {
  return side === "reviewer"
    ? r.phase === "reviewing" && r.lastSubmitRound !== r.round
    : r.phase === "fixing" && r.lastRespondRound !== r.round;
}

/**
 * A linha que dá ao CO-AUTOR o crédito no Git (`Co-authored-by: Nome <email>`), com a identidade git
 * que ele tem no vibehub. Sem co-autor, co-autor igual ao autor ou sem nome/e-mail: nenhuma.
 */
async function coauthorTrailer(r: Review): Promise<string | undefined> {
  if (!r.coauthorUserId || r.coauthorUserId === r.authorUserId) return undefined;
  const git = await getUserGit(r.coauthorUserId);
  return git?.gitName && git.gitEmail ? `Co-authored-by: ${git.gitName} <${git.gitEmail}>` : undefined;
}

/**
 * O texto que a vez deste lado pede: rodada 1 inteira, delta da 2 em diante, ou a lista do autor (com
 * a linha de crédito do co-autor, quando há uma).
 */
async function promptFor(r: Review, side: Side): Promise<string> {
  if (side === "author") return authorFixPrompt(r, { coauthorTrailer: await coauthorTrailer(r) });
  return r.round <= 1 ? reviewerRoundPrompt(r) : reviewerDeltaPrompt(r);
}

/** O login GitHub da conexão PRÓPRIA de uma pessoa no vibehub; sem uma, undefined. */
async function githubLogin(userId: string): Promise<string | undefined> {
  const own = (await getUserGit(userId))?.githubConnectionId;
  return own ? (await getGithubConnection(own))?.login : undefined;
}

/**
 * Os papéis da revisão que o GitHub também tem, gravados no PR: o RESPONSÁVEL (quem corrige, commita
 * e dá push) vira o assignee — o dono da entrega —, e o REVISOR vira o reviewer pedido. Co-autor e
 * quem faz o merge não têm campo no PR (o co-autor ganha o crédito nos commits, pela linha
 * Co-authored-by). A conversa conta o que saiu. Nunca lança: um PR sem os nomes não para a revisão.
 */
async function namePeopleOnGithub(r: Review): Promise<void> {
  try {
    const [assignee, reviewer] = await Promise.all([githubLogin(r.authorUserId), githubLogin(r.reviewerUserId)]);
    const asked = { ...(assignee ? { assignee } : {}), ...(reviewer ? { reviewer } : {}) };
    const done = await setPrPeople(r.cardId, r.prUrl, asked);
    const parts: string[] = [];
    if (assignee) parts.push(done.assignee === "ok" ? `assignee ${assignee} (o responsável)` : `assignee ${assignee} recusado pelo GitHub`);
    if (reviewer) parts.push(done.reviewer === "ok" ? `reviewer ${reviewer} pedido` : `reviewer ${reviewer} recusado pelo GitHub`);
    const missing = !assignee ? " O assignee não foi marcado: o responsável não tem conexão GitHub própria no vibehub." : "";
    await mutateReview(r.id, (x) => {
      note(x, "system", `No GitHub: ${parts.length ? parts.join(" e ") : "ninguém marcado"}.${missing}`);
    });
  } catch (err) {
    logger.warn({ review: r.id, detail: (err as Error).message }, "could not name the review's people on GitHub");
  }
}

/* ------------------------------------------------------------------ avisos */

/**
 * Um aviso nos DOIS cards da revisão (autor e revisor), cada um com a sua chave: um replay não
 * duplica. Nunca lança: um aviso que não grava custa o aviso, não a revisão.
 */
async function notifyBoth(r: Review, key: string, text: string, severity: Severity): Promise<void> {
  for (const [cardId, who] of [[r.cardId, "author"], [r.reviewerCardId, "reviewer"]] as const) {
    try {
      await recordMessage({ cardId, type: "info", severity, text, idempotencyKey: `${key}:${who}` });
    } catch (err) {
      logger.warn({ review: r.id, card: cardId, detail: (err as Error).message }, "could not record the review notice");
    }
  }
}

/**
 * Mudança de fase pra `ready`, `impasse` ou `merged` vira um aviso nos cards do autor e do revisor (a
 * bandeja de avisos que já existe), com a chave `review:<id>:<fase>:<rodada>:<lado>`.
 */
export async function announcePhase(r: Review): Promise<void> {
  if (r.phase !== "ready" && r.phase !== "impasse" && r.phase !== "merged") return;
  await notifyBoth(r, `review:${r.id}:${r.phase}:${r.round}`, phaseNoticeText(r), r.phase === "impasse" ? "warning" : "info");
}

/**
 * A rodada do revisor deixou dúvida sem decisão: ela segura o `ready` até o revisor HUMANO decidir no
 * painel, e nada mais o chamaria. O aviso vai só ao card do revisor (o ator dele é o revisor), uma vez
 * por rodada (`review:<id>:question:<rodada>:reviewer`). Nunca lança.
 */
async function announceQuestions(r: Review): Promise<void> {
  if (pendingQuestions(r.findings).length === 0) return;
  try {
    await recordMessage({
      cardId: r.reviewerCardId, type: "info", severity: "info", text: questionNoticeText(r),
      idempotencyKey: `review:${r.id}:question:${r.round}:reviewer`,
    });
  } catch (err) {
    logger.warn({ review: r.id, card: r.reviewerCardId, detail: (err as Error).message }, "could not record the review question notice");
  }
}

/* ------------------------------------------------------------------ relays */

/**
 * O card do autor estava PAUSADO: sai de Paused pra `waiting` (a mesma escrita do arrastar no board,
 * PATCH /api/cards/:id) e, se a sessão tinha morrido, é retomado. É o único caminho do vibehub que
 * tira um card de Paused sem uma pessoa — decisão do usuário (29/10: "Pedir revisão" autoriza gastar
 * a conta do autor neste ciclo) — e por isso fica no log de auditoria como `review.wake`.
 * Card dormindo (hibernado, nunca aberto) não passa por aqui: o `wake` do envio já acorda.
 */
async function unpauseAuthor(r: Review): Promise<void> {
  const live = await getCard(r.cardId);
  if (!live) throw new Error("o card do autor não existe mais");
  // `done` é a conclusão de alguém: não sai dali por aqui (o envio recusa e a revisão vai a impasse).
  if (live.column === "done" || (live.column !== "paused" && !live.pausedAt)) return;
  const before = { ...live };
  const effect = cardMoveEffect(before, { column: "waiting" });
  if (before.column !== "waiting") await updateCard(r.cardId, { column: "waiting" });
  logger.info(
    { audit: true, action: "review.wake", card: before.worktreeSlug, review: r.id, from: before.column, effect },
    "author card taken out of Paused by the PR review",
  );
  if (effect === "resume" || before.pausedAt) await resumeCard(r.cardId, `review:${r.id}`);
}

/**
 * Entrega `text` ao card de um dos lados. O ator vira a pessoa daquele lado no `beforeDeliver`.
 *  - `unpause`: só o PRIMEIRO relay da rodada ao autor tira o card dele de Paused. Lembrete e
 *    "tentar de novo" não: uma pausa no meio da correção é decisão da pessoa, e o envio recusado
 *    vira impasse com o motivo (que o "tentar de novo" resolve depois que ela despausar).
 *  - `approve`: é o pedido de Approve. Falha mantém `ready` com `approvePending` e um aviso (o merge
 *    humano não fica preso por causa do GitHub); sucesso limpa a marca.
 * Qualquer outra falha vira `impasse` com o erro, mas só se a revisão ainda está na fase e na rodada
 * para as quais o texto saiu (uma resposta que pousou no meio ganha). Nunca lança. Devolve se entregou.
 */
export async function relayReview(
  r: Review, side: Side, text: string, opts: { unpause?: boolean; approve?: boolean } = {},
): Promise<boolean> {
  const cardId = side === "author" ? r.cardId : r.reviewerCardId;
  const userId = side === "author" ? r.authorUserId : r.reviewerUserId;
  const samePlace = (x: Review) => x.phase === r.phase && x.round === r.round;
  try {
    if (side === "author" && opts.unpause) await unpauseAuthor(r);
    await sendToTerminal(cardId, text, {
      by: `review:${r.id}`,
      origin: REVIEW_ORIGIN,
      // Card dormindo (hibernado, nunca aberto, sessão perdida num restart) é acordado.
      wake: true,
      // Claude tem de estar de pé pra ler: um shell nu engoliria o texto e a revisão ficaria parada.
      requireAgent: true,
      // Nunca digitar num menu (o Enter escolheria a opção destacada); um card que acabou de subir
      // ganha o tempo de desenhar o prompt.
      guardInteractiveMenu: true,
      readyWaitMs: SEND_READY_WAIT_MS,
      // Com o chat nativo em uso, o texto vira turno do driver; digitado no tmux iria para OUTRO
      // processo Claude e a conversa bifurcaria.
      viaNativeChat: true,
      beforeDeliver: async () => recordCardActor(await findUser(userId), cardId),
    });
    if (opts.approve && r.approvePending) {
      await mutateReview(r.id, (x) => {
        if (x.phase === "ready") x.approvePending = undefined;
      }).catch((e: unknown) => logger.warn({ review: r.id, detail: (e as Error).message }, "could not clear approvePending"));
    }
    return true;
  } catch (err) {
    const reason = (err as Error).message;
    logger.warn({ review: r.id, card: cardId, side, detail: reason }, "PR review relay failed");
    const who = side === "author" ? "autor" : "revisor";
    try {
      if (opts.approve) {
        const after = await mutateReview(r.id, (x) => {
          if (x.phase !== "ready") return;
          x.approvePending = true;
          note(x, "system", `Approve não publicado: não consegui entregar ao revisor (${reason}).`);
        });
        if (after.approvePending) await notifyBoth(after, `review:${r.id}:approve_pending:${r.round}`, approvePendingText(after), "warning");
        return false;
      }
      let impasse = false as boolean;
      const after = await mutateReview(r.id, (x) => {
        if (CLOSED.has(x.phase) || !samePlace(x)) {
          note(x, "system", `Envio ao ${who} falhou depois que a revisão andou (${reason}); nada muda.`);
          return;
        }
        x.phase = "impasse";
        x.impasseReason = reason;
        note(x, "system", `Impasse: não consegui entregar ao ${who} (${reason}).`);
        impasse = true;
      });
      if (impasse) await announcePhase(after);
    } catch (e) {
      logger.warn({ review: r.id, detail: (e as Error).message }, "could not record the PR review relay failure");
    }
    return false;
  }
}

/** O que a fase nova pede: a lista ao autor, o Approve ao revisor, ou só o aviso. Devolve a revisão atual. */
async function dispatch(r: Review): Promise<Review> {
  if (r.phase === "fixing") {
    // O primeiro relay da rodada: o único que tira o card do autor de Paused.
    await relayReview(r, "author", await promptFor(r, "author"), { unpause: true });
  } else if (r.phase === "ready") {
    await announcePhase(r);
    await relayReview(r, "reviewer", reviewerApprovePrompt(r), { approve: true });
  } else if (r.phase === "impasse") {
    await announcePhase(r);
  }
  return (await getReview(r.id)) ?? r;
}

/** A linha de sistema que conta o resultado da rodada do revisor. */
function outcomeNote(r: Review): string {
  const blocking = blockingNow(r).length;
  const waiting = pendingQuestions(r.findings).length;
  const questions = waiting ? ` ${waiting} dúvida(s) esperam o revisor humano.` : "";
  switch (r.phase) {
    case "fixing":
      return `${blocking} bloqueante(s) em aberto: a lista vai ao autor.${questions}`;
    case "ready":
      return "Sem bloqueante em aberto: pronto para o merge humano.";
    case "impasse":
      return `Impasse: ${impasseText(r.impasseReason)}.`;
    default:
      return `Esperando o revisor humano decidir ${waiting} dúvida(s).`;
  }
}

/* ------------------------------------------------------------------ iniciar */

/** Serializa o "iniciar": a checagem de revisão ativa e a criação valem como uma coisa só. */
let starting: Promise<unknown> = Promise.resolve();
function serialStart<T>(work: () => Promise<T>): Promise<T> {
  const next = starting.then(work, work);
  starting = next.catch(() => undefined);
  return next;
}

/**
 * Abre a revisão do PR `prNumber` do card: cria o card do revisor (conta Claude do revisor, branch
 * do PR, escondido do board) e manda a rodada 1. Recusas com o código na mensagem, que a rota
 * traduz em 400: `revisor_igual_autor`, `sem_pr`, `pr_mergeado`, `revisao_ativa`, `revisor_sem_conta`.
 */
export async function startReview(input: {
  cardId: string;
  prNumber: number;
  reviewerUserId: string;
  authorUserId: string;
  coauthorUserId?: string;
  mergerUserId: string;
  by: string;
}): Promise<Review> {
  const review = await serialStart(async () => {
    if (input.reviewerUserId === input.authorUserId) {
      throw new Error("revisor_igual_autor: quem revisa não pode ser quem corrige");
    }
    const card = await getCard(input.cardId);
    if (!card) throw new Error("card not found");
    const pr = card.prs?.find((p) => p.number === input.prNumber);
    if (!pr) throw new Error(`sem_pr: o card não tem o PR #${input.prNumber}`);
    // Um PR já mergeado não tem o que revisar: revisar seria gastar duas IAs num diff que já está na base.
    if (pr.mergedAt !== undefined) throw new Error(`pr_mergeado: o PR #${pr.number} já foi mergeado`);
    if (await activeReviewFor(card.id, pr.number)) {
      throw new Error(`revisao_ativa: já existe uma revisão em andamento do PR #${pr.number} neste card`);
    }
    const accountSlug = await creatorAccountSlug(input.reviewerUserId);
    if (!accountSlug) throw new Error("revisor_sem_conta: o revisor não tem uma conta Claude própria no vibehub");

    const reviewerCard = await createReviewerCard({
      authorCard: card, reviewerAccountSlug: accountSlug, prBranch: pr.branch, title: `Revisão PR #${pr.number} · ${card.title}`,
    });
    const now = Date.now();
    const fresh: Review = {
      id: randomUUID(),
      cardId: card.id,
      projectId: card.projectId,
      prNumber: pr.number,
      prUrl: pr.url,
      prBranch: pr.branch,
      base: pr.base,
      reviewerUserId: input.reviewerUserId,
      authorUserId: input.authorUserId,
      ...(input.coauthorUserId ? { coauthorUserId: input.coauthorUserId } : {}),
      mergerUserId: input.mergerUserId,
      reviewerCardId: reviewerCard.id,
      round: 1,
      phase: "reviewing",
      findings: [],
      log: [],
      nudges: 0,
      createdAt: now,
      updatedAt: now,
    };
    note(fresh, "system", `Revisão iniciada: o revisor confere o PR #${pr.number} (rodada 1 de ${MAX_ROUNDS}).`);
    try {
      // O revisor age no card dele pelo `recordCardActor` do relay, que só pousa com `work`. Owner e
      // share de projeto já dão isso; quem só alcança o card do autor ganha um share `work` no card do
      // revisor — senão o `gh pr review` sairia na conta de outra pessoa.
      const reviewer = await findUser(input.reviewerUserId);
      if (reviewer && (await cardLevel(reviewer, reviewerCard.id)) !== "work") {
        await shareWith({ kind: "card", targetId: reviewerCard.id, userId: reviewer.id, level: "work" });
      }
      await insertReview(fresh);
    } catch (err) {
      // Sem revisão, o card do revisor é lixo: nunca foi aberto, então sai sem sessão pra matar.
      await removeCard(reviewerCard.id).catch(() => undefined);
      throw err;
    }
    logger.info(
      { audit: true, action: "review.start", review: fresh.id, card: card.worktreeSlug, pr: pr.number, reviewerCard: reviewerCard.id, by: input.by },
      "PR review started",
    );
    return fresh;
  });
  // O GitHub não depende do relay (nem o relay dele): os dois saem juntos.
  await Promise.all([relayReview(review, "reviewer", reviewerRoundPrompt(review)), namePeopleOnGithub(review)]);
  return (await getReview(review.id)) ?? review;
}

/* ------------------------------------------------------------------ revisor */

/**
 * A rodada do revisor (`vibehub_review_submit`). Só o card do revisor da revisão chama; rodada que não
 * é a atual, ou já submetida, devolve a revisão sem efeito. Achados passam pelo modelo (prova, lista
 * fechada); vereditos só `fixed|open|dropped`, e nunca sobre o que um humano já fechou.
 */
export async function submitReviewerRound(
  reviewerCardId: string,
  payload: {
    round: number;
    findings: SubmittedFinding[];
    verdicts?: { id: string; status: FindingStatus; reviewerReply?: string }[];
    headSha: string;
    summary: string;
    reviewId?: string;
  },
): Promise<Review> {
  const review = await reviewByReviewerCard(reviewerCardId);
  if (!review) {
    throw new Error("este card não é o revisor de nenhuma revisão: passe em `card` o $VIBEHUB_CARD_ID do card do revisor");
  }
  if (payload.reviewId && payload.reviewId !== review.id) {
    throw new Error(`a revisão ${payload.reviewId} não é a deste card de revisor (${review.id})`);
  }
  const fresh = (r: Review) => r.phase === "reviewing" && payload.round === r.round && r.lastSubmitRound !== payload.round;
  if (!fresh(review)) return review;
  const headSha = assertHeadSha(payload.headSha);
  const verdicts = payload.verdicts ?? [];
  const refused = verdicts.filter((v) => !REVIEWER_VERDICTS.has(v.status));
  if (refused.length > 0) {
    throw new Error(
      `veredito inválido (${refused.map((v) => `${v.id}: ${v.status}`).join(", ")}): o revisor só dá fixed, open ou dropped ` +
        "(aceitar a contestação do autor = dropped); risco aceito é decisão humana",
    );
  }

  let landed = false as boolean;
  const after = await mutateReview(review.id, (r) => {
    // De novo, dentro da fila: outro submit da mesma rodada pode ter pousado entre a leitura e aqui.
    if (!fresh(r)) return;
    // O veredito da IA nunca desfaz um humano. Risco aceito e retirada humana são finais: qualquer
    // veredito sobre eles é ignorado. Bloqueio humano (block/keep) só é protegido do `dropped` (a IA
    // não retira o que um humano mandou bloquear); `open` e `fixed` valem, porque o revisor tem de
    // poder recusar o "corrigido" do autor num item que um humano bloqueou.
    const overridesHuman = (v: { id: string; status: FindingStatus }) => {
      const f = r.findings.find((x) => x.id === v.id);
      if (!f) return false;
      if (f.status === "accepted_risk" || f.humanDecision === "accept_risk" || f.humanDecision === "drop") return true;
      return (f.humanDecision === "block" || f.humanDecision === "keep") && v.status === "dropped";
    };
    const skipped = verdicts.filter(overridesHuman).map((v) => `${v.id} (${v.status})`);
    const applied = verdicts.filter((v) => !overridesHuman(v));
    const judged = applyReviewerVerdicts(r, applied);
    const added = normalizeSubmittedFindings(payload.findings, r.round, r.findings);
    r.findings = [...judged, ...added];
    r.reviewedSha = headSha;
    r.prHeadSha = headSha;
    r.lastSubmitRound = r.round;
    r.nudges = 0;
    note(r, "reviewer", payload.summary || `Rodada ${r.round}: ${added.length} achado(s) novo(s), ${verdicts.length} veredito(s).`, {
      items: [
        ...applied.map((v) => ({ id: v.id, status: v.status, reply: v.reviewerReply })),
        ...added.map((f) => ({ id: f.id, status: f.status, isNew: true })),
      ],
    });
    if (skipped.length) note(r, "system", `Vereditos ignorados (desfariam uma decisão humana): ${skipped.join(", ")}.`);
    const next = phaseAfterReviewerRound(r);
    r.phase = next.phase;
    if (next.impasseReason) r.impasseReason = next.impasseReason;
    note(r, "system", outcomeNote(r));
    landed = true;
  });
  if (!landed) return after;
  await announceQuestions(after);
  return await dispatch(after);
}

/* ------------------------------------------------------------------ autor */

/** A revisão a que o card do autor responde: a nomeada, ou a única esperando correção dele. */
async function authorReview(authorCardId: string, reviewId?: string): Promise<Review> {
  if (reviewId) {
    const r = await getReview(reviewId);
    if (!r || r.cardId !== authorCardId) {
      throw new Error(`a revisão ${reviewId} não é deste card: só o card do autor responde, com o próprio $VIBEHUB_CARD_ID`);
    }
    return r;
  }
  const active = (await listReviewsForCards([authorCardId])).filter((r) => !CLOSED.has(r.phase));
  if (active.length === 0) {
    throw new Error("nenhuma revisão ativa tem este card como autor: passe em `card` o $VIBEHUB_CARD_ID do card do autor");
  }
  const fixing = active.filter((r) => r.phase === "fixing");
  if (fixing.length > 1) throw new Error("mais de uma revisão espera correção neste card: passe `review` com o id");
  return fixing[0] ?? active.reduce((a, b) => (b.createdAt >= a.createdAt ? b : a));
}

type AuthorAnswer = { id: string; status: AuthorAnswerStatus; commit?: string; reply: string };
const AUTHOR_ANSWERS: ReadonlySet<string> = new Set<AuthorAnswerStatus>(["fixed", "contested", "wontfix"]);

/** Sugestão que ainda aceita resposta do autor: não foi retirada nem aceita como risco por ninguém. */
const answerableSuggestion = (f: Finding): boolean =>
  f.severity === "suggestion" && f.status !== "dropped" && f.status !== "accepted_risk";

/** "2 corrigido(s), 1 contestado(s), 1 não vai(ão) aplicar" — só o que houve. */
function answerCounts(items: AuthorAnswer[]): string {
  const n = (status: AuthorAnswerStatus) => items.filter((it) => it.status === status).length;
  const parts = [`${n("fixed")} corrigido(s)`, `${n("contested")} contestado(s)`];
  if (n("wontfix")) parts.push(`${n("wontfix")} não vai(ão) aplicar`);
  return parts.join(", ");
}

/**
 * A resposta do autor (`vibehub_review_respond`). Só o card do autor chama.
 *  - Na rodada de correção (`fixing`), idempotente pela rodada: responde ao que bloqueia (corrigido ou
 *    contestado) e, se quiser, às sugestões (corrigida, contestada ou `wontfix` com o motivo); abre a
 *    rodada seguinte, com o delta ao revisor.
 *  - Fora dela, com a revisão aberta (inclusive em `ready`, quando alguém mandou a IA aplicar as
 *    sugestões): só as respostas a SUGESTÕES valem — fecham o item no painel, sem abrir rodada e sem
 *    mandar nada a ninguém (um push que tenha vindo junto a conferência do GitHub pega). A mesma
 *    resposta de novo não grava outra fala.
 * Resposta a id desconhecido, a item fechado ou a bloqueante fora da rodada vai ao log, sem derrubar o
 * resto. `wontfix` em bloqueante e contestar/não aplicar sem motivo são recusados antes de mexer em nada.
 */
export async function submitAuthorResponse(
  authorCardId: string,
  payload: { round: number; items: AuthorAnswer[]; headSha: string; reviewId?: string },
): Promise<Review> {
  const review = await authorReview(authorCardId, payload.reviewId);
  if (CLOSED.has(review.phase)) return review;
  const bad = payload.items.filter((it) => !AUTHOR_ANSWERS.has(it.status));
  if (bad.length) {
    throw new Error(`status inválido (${bad.map((it) => it.id).join(", ")}): o autor responde fixed, contested ou wontfix`);
  }
  const headSha = assertHeadSha(payload.headSha);
  const fresh = (r: Review) => r.phase === "fixing" && payload.round === r.round && r.lastRespondRound !== payload.round;
  // Na rodada vale o que bloqueia e as sugestões; fora dela, só as sugestões. O resto vai ao log.
  const answerableIn = (r: Review) => {
    const round = fresh(r);
    const known = new Map(r.findings.map((f) => [f.id, f]));
    return (it: AuthorAnswer) => {
      const f = known.get(it.id);
      return !!f && (answerableSuggestion(f) || (round && actionableForAuthor(f)));
    };
  };
  // As recusas valem antes da mutação, e só sobre o que ela vai aceitar: uma resposta mal formada a
  // um item que seria ignorado não derruba as outras.
  applyAuthorResponses(review, payload.items.filter(answerableIn(review)));

  let opened = false as boolean;
  const after = await mutateReview(review.id, (r) => {
    if (CLOSED.has(r.phase)) return;
    const round = fresh(r);
    const known = new Map(r.findings.map((f) => [f.id, f]));
    const answerable = answerableIn(r);
    // Fora da rodada, a mesma resposta de novo não grava outra fala.
    const changed = (it: AuthorAnswer) => {
      const f = known.get(it.id)!;
      return f.status !== it.status || f.authorReply !== it.reply || (it.commit !== undefined && f.commit !== it.commit);
    };
    const allowed = payload.items.filter((it) => answerable(it) && (round || changed(it)));
    const ignored = payload.items.filter((it) => !answerable(it)).map((it) => it.id);
    if (!round && allowed.length === 0) return;
    r.findings = applyAuthorResponses(r, allowed);
    r.prHeadSha = headSha;
    note(r, "author", `${round ? "" : "Sugestões respondidas: "}${answerCounts(allowed)}; head ${headSha.slice(0, 7)}.`, { items: allowed });
    if (ignored.length) {
      note(r, "system", round
        ? `Respostas ignoradas (id desconhecido ou item que não espera resposta do autor): ${ignored.join(", ")}.`
        : `Fora da rodada de correção só as respostas a sugestões valem; ignoradas: ${ignored.join(", ")}.`);
    }
    if (!round) return;
    r.lastRespondRound = r.round;
    r.nudges = 0;
    r.round += 1;
    r.phase = "reviewing";
    note(r, "system", `Rodada ${r.round} de ${MAX_ROUNDS}: o revisor confere só o diff.`);
    opened = true;
  });
  if (!opened) return after;
  await relayReview(after, "reviewer", reviewerDeltaPrompt(after));
  return (await getReview(after.id)) ?? after;
}

/* ------------------------------------------------------------------ humano */

/**
 * A decisão do revisor HUMANO sobre um item: uma dúvida (`question`) ou um bloqueante travado.
 *  - dúvida: `block` (passa a bloquear), `drop` (retirada) ou `accept_risk`; `keep` não vale aqui.
 *  - bloqueante: `keep`/`block` (segue bloqueando; o dev resolve), `accept_risk` ou `drop`.
 * Em `reviewing` com a rodada do revisor já entregue, a fase é recalculada (autor, Approve ou impasse).
 * Em `impasse` com a rodada do revisor entregue, de qualquer motivo, sai para `ready` quando o último
 * item travado é liberado; sem ela, só grava (a saída é o `retryReview`). Fora disso, só grava.
 */
export async function decideQuestion(reviewId: string, findingId: string, decision: Decision, by: string): Promise<Review> {
  if (!["block", "drop", "keep", "accept_risk"].includes(decision)) throw new Error(`decisão inválida: ${String(decision)}`);
  let recompute = false as boolean;
  const after = await mutateReview(reviewId, (r) => {
    if (r.phase !== "reviewing" && r.phase !== "fixing" && r.phase !== "impasse") {
      throw new Error(`a revisão está em ${r.phase}: não há decisão pendente`);
    }
    const f = r.findings.find((x) => x.id === findingId);
    if (!f) throw new Error(`achado desconhecido: ${findingId}`);
    if (f.severity !== "question" && f.severity !== "blocking") {
      throw new Error(`o achado ${findingId} é ${f.severity}: não espera decisão`);
    }
    if (f.severity === "question" && decision === "keep") {
      throw new Error(`keep vale para bloqueante travado; na dúvida ${findingId} decida block, drop ou accept_risk`);
    }
    f.humanDecision = decision;
    if (decision === "accept_risk") f.status = "accepted_risk";
    else if (decision === "drop") f.status = "dropped";
    else if (f.status === "dropped" || f.status === "accepted_risk") f.status = "open";
    const said: Record<Decision, string> = { block: "bloqueia", keep: "mantém o bloqueio", drop: "retira", accept_risk: "aceita o risco" };
    note(r, "human", `Decisão humana em ${findingId}: ${said[decision]}.`, { items: [{ id: f.id, status: f.status }], by });

    if (r.phase === "reviewing") {
      // No meio da rodada do revisor, quem fecha a fase é o submit dele.
      if (r.lastSubmitRound !== r.round) return;
      const next = phaseAfterReviewerRound(r);
      if (next.phase === r.phase) return;
      r.phase = next.phase;
      if (next.impasseReason) r.impasseReason = next.impasseReason;
    } else if (r.phase === "impasse") {
      // Sem a conferência do revisor nesta rodada, o "corrigido" do autor é palavra dele: ir a ready
      // aqui pediria Approve de código que ninguém olhou (e um "fixed" sem commit mergearia o bug). A
      // decisão fica gravada; a saída é o "tentar de novo", e o submit do revisor a honra.
      if (r.lastSubmitRound !== r.round) return;
      // Com a rodada conferida, o impasse (de qualquer motivo) sai pelo último item liberado;
      // "manter" segura (o dev resolve na mão; o resto sai pelo retryReview).
      if (phaseAfterReviewerRound(r).phase !== "ready") return;
      r.phase = "ready";
      r.impasseReason = undefined;
    } else {
      return;
    }
    note(r, "system", outcomeNote(r));
    recompute = true;
  });
  logger.info({ audit: true, action: "review.decide", review: reviewId, finding: findingId, decision, by }, "PR review decision recorded");
  return recompute ? await dispatch(after) : after;
}

/**
 * "Tentar de novo" do painel: a saída de um impasse que não é de rodadas (envio que falhou, IA que
 * não respondeu), do Approve que não chegou e de uma vez parada. Zera os lembretes, limpa o motivo e
 * devolve a vez a quem deve: `reviewing` se a rodada do revisor não foi entregue, senão `fixing`; em
 * `ready` reenvia o pedido de Approve.
 * Em `reviewing`/`fixing` esperando a ferramenta daquele lado, reenvia o texto da vez sem mudar a fase:
 * o fim de turno que o orquestrador não julga (pessoa usando o card, agente que declarou needs_me) não
 * tem prazo, e sem isto a única saída de uma IA parada seria cancelar a revisão inteira.
 * Não tira ninguém de Paused (quem pausou despausa e tenta de novo). Qualquer outro estado (inclusive
 * `reviewing` esperando a decisão humana das dúvidas) lança `nada_a_tentar`. Quem pode é a rota.
 */
export async function retryReview(reviewId: string, by: string): Promise<Review> {
  let side = null as Side | "approve" | null;
  const after = await mutateReview(reviewId, (r) => {
    if (r.phase === "ready" && r.approvePending) {
      side = "approve";
    } else if (r.phase === "impasse" && r.impasseReason !== "rodadas" && r.impasseReason !== HEAD_MOVED) {
      // "rodadas" e "push depois do pronto" não têm vez a devolver (a última rodada já foi): o revisor
      // humano decide os itens, ou cancela e pede uma revisão nova.
      r.phase = r.lastSubmitRound !== r.round ? "reviewing" : "fixing";
      side = r.phase === "reviewing" ? "reviewer" : "author";
    } else if (awaitingTool(r, "reviewer")) {
      side = "reviewer";
    } else if (awaitingTool(r, "author")) {
      side = "author";
    } else {
      throw new Error(
        `nada_a_tentar: a revisão está em ${r.phase}${r.impasseReason ? ` (${r.impasseReason})` : ""}; ` +
          "só impasse por falha/IA sem resposta, Approve pendente ou uma vez de IA parada têm o que tentar de novo",
      );
    }
    r.nudges = 0;
    r.impasseReason = undefined;
    note(r, "human", side === "approve" ? "Tentar de novo: o pedido de Approve volta ao revisor." :
      `Tentar de novo: a vez volta ao ${side === "reviewer" ? "revisor" : "autor"} (rodada ${r.round} de ${MAX_ROUNDS}).`, { by });
  });
  logger.info({ audit: true, action: "review.retry", review: reviewId, side, by }, "PR review retried");
  if (side === "approve") await relayReview(after, "reviewer", reviewerApprovePrompt(after), { approve: true });
  else if (side) await relayReview(after, side, await promptFor(after, side));
  return (await getReview(reviewId)) ?? after;
}

/**
 * A revisão fechou (`merged` ou `cancelled`): o card do revisor vai para `done`, a mesma escrita do
 * arrastar no board. Escondido do board, ninguém o veria nem apagaria, e cada revisão deixaria uma
 * worktree (mais o que a IA instalou para testar) no runner; em `done`, a hibernação e a retenção
 * cuidam dele como de qualquer card. O histórico da revisão (achados e conversa) mora no store das
 * revisões, não no card. Nunca lança: um card que sumiu, ou uma escrita que falhou, custa a faxina,
 * não o fechamento da revisão.
 */
async function retireReviewerCard(r: Review): Promise<void> {
  try {
    const card = await getCard(r.reviewerCardId);
    if (!card || card.column === "done") return;
    await updateCard(card.id, { column: "done" });
    logger.info({ review: r.id, card: card.worktreeSlug, phase: r.phase }, "reviewer card moved to done");
  } catch (err) {
    logger.warn({ review: r.id, card: r.reviewerCardId, detail: (err as Error).message }, "could not move the reviewer card to done");
  }
}

/**
 * Cancela a revisão, de qualquer fase ativa. `cancelled` não é ativa (`activeReviewFor`), então o
 * mesmo PR pode ser revisado de novo. O card do revisor vai para `done` (`retireReviewerCard`); o
 * histórico fica na revisão.
 */
export async function cancelReview(reviewId: string, by: string): Promise<Review> {
  const after = await mutateReview(reviewId, (r) => {
    if (CLOSED.has(r.phase)) throw new Error(`revisao_encerrada: a revisão já está em ${r.phase}`);
    r.phase = "cancelled";
    r.approvePending = undefined;
    note(r, "human", "Revisão cancelada.", { by });
  });
  logger.info({ audit: true, action: "review.cancel", review: reviewId, by }, "PR review cancelled");
  await retireReviewerCard(after);
  return after;
}

/**
 * Cancela a revisão por um motivo do SISTEMA (o card de um lado foi excluído, o PR foi fechado no
 * GitHub): a fala no log e a linha de auditoria. Idempotente — revisão já encerrada fica como está.
 */
async function cancelBySystem(
  reviewId: string, text: string, audit: Record<string, unknown>,
): Promise<{ review: Review; cancelled: boolean }> {
  let cancelled = false as boolean;
  const review = await mutateReview(reviewId, (x) => {
    if (CLOSED.has(x.phase)) return;
    x.phase = "cancelled";
    x.approvePending = undefined;
    note(x, "system", text);
    cancelled = true;
  });
  if (cancelled) logger.info({ audit: true, action: "review.cancel", review: reviewId, ...audit }, "PR review cancelled");
  return { review, cancelled };
}

/**
 * Um card saiu do board (o botão de excluir, a retenção de `done`, o projeto excluído). Toda revisão
 * ATIVA em que ele é o autor ou o revisor é cancelada: sem o card, nenhum relay chega e o "tentar de
 * novo" não teria para onde ir. Devolve os cards de revisor das revisões em que ele era o AUTOR, de
 * qualquer fase, para quem exclui levá-los junto: sem o autor, o card do revisor é só uma worktree
 * escondida. Idempotente.
 */
export async function closeReviewsOfRemovedCard(cardId: string, by?: string): Promise<string[]> {
  const asAuthor = await listReviewsForCards([cardId]);
  const asReviewer = await reviewByReviewerCard(cardId);
  for (const r of [...asAuthor, ...(asReviewer ? [asReviewer] : [])]) {
    if (CLOSED.has(r.phase)) continue;
    const side = r.cardId === cardId ? "autor" : "revisor";
    await cancelBySystem(r.id, `Revisão cancelada: o card do ${side} foi excluído.`, { reason: `${side} card removed`, card: cardId, by });
  }
  return [...new Set(asAuthor.map((r) => r.reviewerCardId))].filter((id) => id !== cardId);
}

/* ------------------------------------------------------------------ merge humano */

/**
 * O PR andou depois do `ready`: o botão de merge achou o PR num commit que não é o revisado
 * (`cause: "merge"`), ou o turno do autor terminou com um push novo no PR (`cause: "push"`,
 * {@link checkAuthorPush}). Numa mutação só: com rodada sobrando, a revisão volta a `reviewing` na
 * rodada seguinte e o revisor recebe o delta (desde o `reviewedSha` aprovado) pelo mesmo relay das
 * outras rodadas; na última, vira impasse "push depois do pronto". Só age em `ready`: o merge leva
 * minutos (o CI), e uma revisão que andou ou foi cancelada nesse meio fica como está. `headSha` (o
 * head lido) segura uma leitura velha: se a revisão já aprovou esse commit, não há o que reabrir.
 */
export async function reopenAfterHeadMoved(
  reviewId: string, by: string, opts: { cause?: "merge" | "push"; headSha?: string } = {},
): Promise<Review> {
  const cause = opts.cause ?? "merge";
  const head = opts.headSha?.toLowerCase();
  let outcome = null as "reopen" | "impasse" | null;
  const after = await mutateReview(reviewId, (r) => {
    if (r.phase !== "ready") return;
    if (head && r.reviewedSha === head) return;
    const approved = r.reviewedSha ? ` (${r.reviewedSha.slice(0, 7)})` : "";
    const why = cause === "push"
      ? `O autor empurrou depois do pronto${head ? ` (head ${head.slice(0, 7)})` : ""}: ${HEAD_MOVED}; o PR não está mais no commit aprovado${approved}.`
      : `Merge recusado: ${HEAD_MOVED}; o PR não está mais no commit aprovado${approved}.`;
    r.approvePending = undefined;
    r.nudges = 0;
    if (r.round < MAX_ROUNDS) {
      r.round += 1;
      r.phase = "reviewing";
      note(r, "system", `${why} Rodada ${r.round} de ${MAX_ROUNDS}: o revisor confere o que entrou.`);
      outcome = "reopen";
    } else {
      r.phase = "impasse";
      r.impasseReason = HEAD_MOVED;
      note(r, "system", `${why} Impasse: ${HEAD_MOVED} na última rodada; cancele e peça uma revisão nova.`);
      outcome = "impasse";
    }
  });
  logger.info({ audit: true, action: "review.head_moved", review: reviewId, cause, outcome, by }, "PR review: head moved after ready");
  if (outcome === "reopen") await relayReview(after, "reviewer", headMovedPrefix(after, cause) + reviewerDeltaPrompt(after));
  else if (outcome === "impasse") await announcePhase(after);
  return (await getReview(reviewId)) ?? after;
}

/**
 * O PR no GitHub, conferido contra a revisão: o que aconteceu lá FORA do painel, que nenhum clique
 * contou para cá.
 *  - MERGED: mergeado à mão, ou por uma IA pela API — a revisão fecha como mergeada (o mesmo
 *    `markReviewMerged` do botão: aviso nos dois cards, card do revisor para `done`), o PR do card
 *    ganha `mergedAt` e a branch dele sai do GitHub (o trabalho já está na base).
 *  - CLOSED sem merge: a revisão é cancelada (não há mais o que revisar nem mergear).
 *  - OPEN com o head diferente do aprovado, em `ready`: alguém mandou a IA do autor mexer no PR e
 *    ela empurrou — a revisão volta ao revisor na hora ({@link reopenAfterHeadMoved}), sem esperar
 *    o clique de merge para descobrir. Em `fixing`, push é a resposta à lista: nada muda.
 * Só revisão aberta vai ao GitHub. Nunca lança: uma leitura que falha deixa a revisão como está.
 */
export async function syncReviewWithGithub(reviewId: string): Promise<Review | undefined> {
  const r = await getReview(reviewId);
  // Com o merge do botão em andamento, o PR aparece MERGED antes de o botão fechar a revisão: é ele
  // quem fecha (com o nome de quem mergeou), não esta conferência.
  if (!r || CLOSED.has(r.phase) || merging.has(r.id)) return r;
  const pr = await readPrState(r.cardId, r.prUrl);
  if (!pr || merging.has(r.id)) return r;
  if (pr.state === "MERGED") {
    const after = await markReviewMerged(r.id, "GitHub", { outsidePanel: { headSha: pr.headSha } });
    await afterPrMerged(r.cardId, r.prUrl, r.base, r.prBranch);
    return after;
  }
  if (pr.state === "CLOSED") {
    const { review: after, cancelled } = await cancelBySystem(
      r.id, `PR #${r.prNumber} fechado no GitHub sem merge: revisão cancelada.`, { reason: "PR closed on GitHub" },
    );
    if (cancelled) await retireReviewerCard(after);
    return after;
  }
  const seen = r.prHeadSha === pr.headSha ? r : await mutateReview(r.id, (x) => {
    if (!CLOSED.has(x.phase)) x.prHeadSha = pr.headSha;
  });
  if (seen.phase === "ready" && seen.reviewedSha && pr.headSha !== seen.reviewedSha) {
    return await reopenAfterHeadMoved(r.id, "fim do turno do autor", { cause: "push", headSha: pr.headSha });
  }
  return seen;
}

/** Revisões com merge em andamento (o botão, ou o deliver do responsável): um por vez. */
const merging = new Set<string>();

/** Pega a vez do merge desta revisão; false = já há um em andamento. Devolva com {@link releaseMerge}. */
export function claimMerge(reviewId: string): boolean {
  if (merging.has(reviewId)) return false;
  merging.add(reviewId);
  return true;
}

export function releaseMerge(reviewId: string): void {
  merging.delete(reviewId);
}

/** De quanto em quanto tempo, no máximo, o painel aberto faz o servidor conferir o PR no GitHub. */
export const GITHUB_SYNC_MS = 60_000;
const lastGithubSync = new Map<string, number>();

/**
 * O painel leu a revisão: confere o PR no GitHub em segundo plano, no máximo uma vez por
 * {@link GITHUB_SYNC_MS} por revisão — o painel relê a cada 3 s e um `gh` por leitura seria
 * desperdício. É o que pega um merge feito direto no GitHub mesmo sem nenhum turno do autor.
 */
export function syncReviewSoon(r: Review): void {
  if (CLOSED.has(r.phase)) {
    lastGithubSync.delete(r.id);
    return;
  }
  if (!claimGithubSync(r.id)) return;
  void syncReviewWithGithub(r.id).catch((err: unknown) => {
    logger.warn({ review: r.id, detail: (err as Error).message }, "PR review could not sync with GitHub");
  });
}

/** Marca a conferência de agora, se a última foi há mais de {@link GITHUB_SYNC_MS}. Devolve se pode ir. */
function claimGithubSync(reviewId: string): boolean {
  const now = Date.now();
  if (now - (lastGithubSync.get(reviewId) ?? 0) < GITHUB_SYNC_MS) return false;
  lastGithubSync.set(reviewId, now);
  return true;
}

/**
 * O fim de turno do card do AUTOR: cada revisão aberta dele é conferida no GitHub — em `ready` sempre
 * (um push ali devolve a revisão ao revisor, e isso tem de aparecer já), nas outras fases no máximo
 * uma vez por {@link GITHUB_SYNC_MS} (lá um push é a resposta à lista; o que importa é pegar um merge
 * ou um fechamento feito por fora). Nunca lança.
 */
async function checkAuthorPush(cardId: string): Promise<void> {
  for (const r of await listReviewsForCards([cardId])) {
    if (CLOSED.has(r.phase)) continue;
    if (r.phase === "ready") lastGithubSync.set(r.id, Date.now());
    else if (!claimGithubSync(r.id)) continue;
    await syncReviewWithGithub(r.id);
  }
}

/**
 * O merge humano saiu: a revisão fecha em `merged` (deixa de ser ativa), os dois cards recebem o
 * aviso e o card do revisor vai para `done`. Grava mesmo se a revisão foi cancelada durante o merge —
 * o PR foi mergeado, e é isso que o painel tem de dizer. Repetir não grava nada nem avisa de novo.
 */
export async function markReviewMerged(
  reviewId: string, by: string, opts: { outsidePanel?: { headSha: string } } = {},
): Promise<Review> {
  let landed = false as boolean;
  const after = await mutateReview(reviewId, (r) => {
    if (r.phase === "merged") return;
    r.phase = "merged";
    r.approvePending = undefined;
    r.impasseReason = undefined;
    if (opts.outsidePanel) {
      // Ninguém clicou no botão: o PR apareceu mergeado no GitHub (à mão, ou por uma IA pela API).
      note(r, "system", `Mergeado em ${r.base} fora do painel, direto no GitHub (head ${opts.outsidePanel.headSha.slice(0, 7)}).`);
    } else {
      const head = r.reviewedSha ? ` (head ${r.reviewedSha.slice(0, 7)})` : "";
      note(r, "human", `Mergeado em ${r.base} por ${by}${head}.`, { by });
    }
    landed = true;
  });
  if (landed) {
    logger.info({ audit: true, action: "review.merged", review: reviewId, by }, "PR review merged");
    await announcePhase(after);
    await retireReviewerCard(after);
  }
  return after;
}

/* ------------------------------------------------------------------ fim de turno */

/**
 * Por que este fim de turno NÃO conta como "terminou sem a ferramenta", ou null se conta. O fallback
 * só cobra turnos que o relay abriu; sem origem no evento, estes sinais dizem que o turno era de outra
 * coisa: uma pessoa usando o card agora, o agente que declarou precisar dela, ou uma pergunta/
 * permissão aberta esperando alguém.
 */
async function notJudged(event: CardEvent): Promise<string | null> {
  const card = await getCard(event.cardId);
  if (!card) return "card sumiu";
  if (isHumanActive(card)) return "pessoa usando o card";
  const declared = event.state ?? card.declaredState;
  if (declared === "needs_me" || declared === "blocked") return `agente declarou ${declared}`;
  if (card.awaitingDecisionAt || card.pendingQuestionAt) return "pergunta ou permissão em aberto";
  const open = (await eventsAfter(0)).events.some(
    (e) => e.cardId === card.id && !e.resolvedAt && (e.kind === "question" || e.kind === "permission"),
  );
  return open ? "pergunta ou permissão em aberto" : null;
}

/**
 * Um card terminou o turno. Se for um lado que a revisão esperava (revisor em `reviewing` sem o submit
 * da rodada, autor em `fixing` sem a resposta) e o turno não é de outra coisa (`notJudged`), é
 * "terminou sem chamar a ferramenta": a primeira vez reenvia o texto da vez com o lembrete na frente
 * (sem tirar ninguém de Paused); a segunda vira impasse "IA não respondeu".
 * A decisão é tomada dentro da mutação, então dois fins de turno juntos não lembram duas vezes.
 */
async function onTurnFinished(event: CardEvent): Promise<void> {
  const cardId = event.cardId;
  const waiting: { id: string; side: Side }[] = [];
  const asReviewer = await reviewByReviewerCard(cardId);
  if (asReviewer && awaitingTool(asReviewer, "reviewer")) waiting.push({ id: asReviewer.id, side: "reviewer" });
  for (const r of await listReviewsForCards([cardId])) {
    if (awaitingTool(r, "author")) waiting.push({ id: r.id, side: "author" });
  }
  if (waiting.length === 0) return;
  const skip = await notJudged(event);
  if (skip) {
    logger.info({ card: cardId, reviews: waiting.map((w) => w.id), reason: skip }, "PR review: finished turn not judged");
    return;
  }
  for (const { id, side } of waiting) {
    let action = null as "nudge" | "impasse" | null;
    const tool = side === "reviewer" ? "vibehub_review_submit" : "vibehub_review_respond";
    const after = await mutateReview(id, (r) => {
      if (!awaitingTool(r, side)) return;
      if (r.nudges >= 1) {
        r.phase = "impasse";
        r.impasseReason = NO_ANSWER;
        note(r, "system", `Impasse: a IA do ${side === "reviewer" ? "revisor" : "autor"} terminou o turno de novo sem chamar ${tool}.`);
        action = "impasse";
      } else {
        r.nudges += 1;
        note(r, "system", `A IA do ${side === "reviewer" ? "revisor" : "autor"} terminou o turno sem chamar ${tool}: lembrete enviado.`);
        action = "nudge";
      }
    });
    if (action === "nudge") await relayReview(after, side, nudgePrefix(tool) + (await promptFor(after, side)));
    else if (action === "impasse") await announcePhase(after);
  }
}

/**
 * Liga o orquestrador ao feed de eventos dos cards (uma vez, no boot). O listener não lança e não
 * bloqueia: só agenda o julgamento (e a conferência do push do autor depois do pronto) para depois de
 * uma folga curta — a chamada da ferramenta que chegou no mesmo turno ganha — e engole qualquer erro
 * com um warn. Devolve o unsubscribe.
 */
export function startReviewOrchestrator(opts: { graceMs?: number } = {}): () => void {
  const graceMs = opts.graceMs ?? TURN_GRACE_MS;
  const timers = new Set<NodeJS.Timeout>();
  let stopped = false;
  const off = onCardEvent((event: CardEvent) => {
    if (stopped || event.kind !== "turn_finished") return;
    const timer = setTimeout(() => {
      timers.delete(timer);
      if (stopped) return;
      void onTurnFinished(event).catch((err: unknown) => {
        logger.warn({ card: event.cardId, detail: (err as Error).message }, "PR review could not judge a finished turn");
      });
      void checkAuthorPush(event.cardId).catch((err: unknown) => {
        logger.warn({ card: event.cardId, detail: (err as Error).message }, "PR review could not check the author's push");
      });
    }, graceMs);
    timer.unref?.();
    timers.add(timer);
  });
  return () => {
    stopped = true;
    off();
    for (const t of timers) clearTimeout(t);
    timers.clear();
  };
}

/**
 * Resposta curta das ferramentas MCP: se a rodada pedida está registrada, onde a revisão está e o que
 * a IA faz agora. Uma rodada que não pegou (errada, revisão em outra fase) diz qual é a vez de verdade,
 * em vez de um "ok" que deixaria a IA achar que entregou.
 */
export function reviewToolAnswer(r: Review, side: Side, askedRound: number): Record<string, unknown> {
  const registered = side === "reviewer" ? r.lastSubmitRound === askedRound : r.lastRespondRound === askedRound;
  const tool = side === "reviewer" ? "vibehub_review_submit" : "vibehub_review_respond";
  let next: string;
  if (awaitingTool(r, side)) next = `a vez é sua: rodada ${r.round}; chame ${tool} com round: ${r.round}`;
  else if (r.phase === "reviewing") {
    next = r.lastSubmitRound === r.round ? "esperando o revisor humano decidir as dúvidas" : "a vez é do revisor";
  } else if (r.phase === "fixing") next = "a vez é do autor";
  else if (r.phase === "ready") next = "pronto para o merge humano; ninguém mergeia daqui";
  else if (r.phase === "impasse") next = `impasse: ${impasseText(r.impasseReason)}`;
  else next = `revisão encerrada (${r.phase})`;
  return {
    review: r.id, registered, phase: r.phase, round: r.round,
    findings: r.findings.length, blocking: blockingOpen(r.findings).length, next,
  };
}
