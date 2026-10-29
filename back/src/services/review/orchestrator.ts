import { randomUUID } from "node:crypto";
import {
  getCard, createReviewerCard, removeCard, updateCard, cardMoveEffect,
} from "../board/registry.js";
import { resumeCard } from "../board/workspace.js";
import { recordCardActor } from "../board/actor.js";
import { findUser } from "../../auth/users.js";
import { creatorAccountSlug } from "../../auth/userGit.js";
import { sendToTerminal, SEND_READY_WAIT_MS } from "../maestro/maestro.js";
import type { MessageOrigin } from "../chat/provenance.js";
import { onCardEvent, recordMessage, type CardEvent } from "../events/cardEvents.js";
import { logger } from "../../utils/logger.js";
import {
  MAX_ROUNDS, applyAuthorResponses, applyReviewerVerdicts, blockingOpen, normalizeSubmittedFindings, pendingQuestions,
  phaseAfterReviewerRound,
  type Finding, type FindingStatus, type Review, type ReviewEvent, type ReviewPhase, type SubmittedFinding,
} from "./model.js";
import {
  activeReviewFor, getReview, insertReview, listReviewsForCards, mutateReview, reviewByReviewerCard,
} from "./store.js";
import {
  actionableForAuthor, authorFixPrompt, impasseText, nudgePrefix, oneLine, phaseNoticeText, reviewerApprovePrompt,
  reviewerDeltaPrompt, reviewerRoundPrompt,
} from "./prompts.js";

/**
 * ORQUESTRADOR DA REVISÃO DE PR — o servidor é o carteiro entre a IA do revisor (num card escondido,
 * na conta Claude do revisor) e a IA do autor (no card do autor). Nenhuma pessoa leva recado.
 *
 *   startReview ──► card do revisor: rodada 1 (/code-review)
 *   vibehub_review_submit ──► fixing: lista fechada ao autor | ready: Approve no GitHub | impasse
 *   vibehub_review_respond ──► rodada N+1: o revisor confere só o diff
 *   turn_finished sem a ferramenta ──► um lembrete; no segundo, impasse "IA não respondeu"
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
 *    `impasse` com o erro como motivo, aviso no card do autor e warn no log.
 *
 * E uma ausência deliberada: nada aqui mergeia. O merge é a rota humana da Task 4.
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
const CLOSED: ReadonlySet<ReviewPhase> = new Set(["merged", "cancelled"]);

type Side = "reviewer" | "author";
type Decision = "block" | "drop" | "keep" | "accept_risk";

/* ------------------------------------------------------------------ helpers */

function note(r: Review, who: ReviewEvent["who"], text: string): void {
  r.log.push({ at: Date.now(), round: r.round, who, text: oneLine(text, 400) });
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

/** O texto que a vez deste lado pede: rodada 1 inteira, delta da 2 em diante, ou a lista do autor. */
function promptFor(r: Review, side: Side): string {
  if (side === "author") return authorFixPrompt(r);
  return r.round <= 1 ? reviewerRoundPrompt(r) : reviewerDeltaPrompt(r);
}

/* ------------------------------------------------------------------ avisos */

/**
 * Mudança de fase pra `ready`, `impasse` ou `merged` vira um aviso no card do autor (a bandeja de
 * avisos que já existe). A chave fixa fase+rodada: um replay (relay refeito, boot) não duplica.
 * Nunca lança: um aviso que não grava custa o aviso, não a revisão.
 */
export async function announcePhase(r: Review): Promise<void> {
  if (r.phase !== "ready" && r.phase !== "impasse" && r.phase !== "merged") return;
  try {
    await recordMessage({
      cardId: r.cardId,
      type: "info",
      severity: r.phase === "impasse" ? "warning" : "info",
      text: phaseNoticeText(r),
      idempotencyKey: `review:${r.id}:${r.phase}:${r.round}`,
    });
  } catch (err) {
    logger.warn({ review: r.id, card: r.cardId, detail: (err as Error).message }, "could not record the review phase notice");
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
 * Falha → `impasse` com o erro (ou, com `keepPhase`, só uma linha no log: o Approve que não chegou
 * não pode prender o merge humano). Nunca lança. Devolve se entregou.
 */
export async function relayReview(
  r: Review, side: Side, text: string, opts: { keepPhase?: boolean } = {},
): Promise<boolean> {
  const cardId = side === "author" ? r.cardId : r.reviewerCardId;
  const userId = side === "author" ? r.authorUserId : r.reviewerUserId;
  try {
    if (side === "author") await unpauseAuthor(r);
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
    return true;
  } catch (err) {
    const reason = (err as Error).message;
    logger.warn({ review: r.id, card: cardId, side, detail: reason }, "PR review relay failed");
    const who = side === "author" ? "autor" : "revisor";
    if (opts.keepPhase) {
      await mutateReview(r.id, (x) => note(x, "system", `Não consegui entregar ao ${who}: ${reason}`)).catch(() => undefined);
      return false;
    }
    try {
      const after = await mutateReview(r.id, (x) => {
        if (CLOSED.has(x.phase)) return;
        x.phase = "impasse";
        x.impasseReason = reason;
        note(x, "system", `Impasse: não consegui entregar ao ${who} (${reason}).`);
      });
      await announcePhase(after);
    } catch (e) {
      logger.warn({ review: r.id, detail: (e as Error).message }, "could not record the PR review impasse");
    }
    return false;
  }
}

/** O que a fase nova pede: a lista ao autor, o Approve ao revisor, ou só o aviso. Devolve a revisão atual. */
async function dispatch(r: Review): Promise<Review> {
  if (r.phase === "fixing") {
    await relayReview(r, "author", authorFixPrompt(r));
  } else if (r.phase === "ready") {
    await announcePhase(r);
    await relayReview(r, "reviewer", reviewerApprovePrompt(r), { keepPhase: true });
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
 * traduz em 400: `revisor_igual_autor`, `sem_pr`, `revisao_ativa`, `revisor_sem_conta`.
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
  await relayReview(review, "reviewer", reviewerRoundPrompt(review));
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
    // O que um humano fechou (risco aceito, retirado por decisão) não é reaberto pela IA.
    const humanClosed = (id: string) => {
      const f = r.findings.find((x) => x.id === id);
      return !!f && (f.status === "accepted_risk" || f.humanDecision === "accept_risk" || f.humanDecision === "drop");
    };
    const skipped = verdicts.filter((v) => humanClosed(v.id)).map((v) => v.id);
    const judged = applyReviewerVerdicts(r, verdicts.filter((v) => !humanClosed(v.id)));
    const added = normalizeSubmittedFindings(payload.findings, r.round, r.findings);
    r.findings = [...judged, ...added];
    r.reviewedSha = headSha;
    r.lastSubmitRound = r.round;
    r.nudges = 0;
    note(r, "reviewer", payload.summary || `Rodada ${r.round}: ${added.length} achado(s) novo(s), ${verdicts.length} veredito(s).`);
    if (skipped.length) note(r, "system", `Vereditos ignorados (decisão humana já fechou): ${skipped.join(", ")}.`);
    const next = phaseAfterReviewerRound(r);
    r.phase = next.phase;
    if (next.impasseReason) r.impasseReason = next.impasseReason;
    note(r, "system", outcomeNote(r));
    landed = true;
  });
  return landed ? await dispatch(after) : after;
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

/**
 * A resposta do autor (`vibehub_review_respond`). Só o card do autor chama; idempotente pela rodada.
 * O autor só responde ao que bloqueia e está em pé: resposta a sugestão ou a item fechado é ignorada
 * com nota no log (a IA pode listar tudo; não é motivo para recusar o resto). Abre a rodada seguinte.
 */
export async function submitAuthorResponse(
  authorCardId: string,
  payload: {
    round: number;
    items: { id: string; status: "fixed" | "contested"; commit?: string; reply: string }[];
    headSha: string;
    reviewId?: string;
  },
): Promise<Review> {
  const review = await authorReview(authorCardId, payload.reviewId);
  const fresh = (r: Review) => r.phase === "fixing" && payload.round === r.round && r.lastRespondRound !== payload.round;
  if (!fresh(review)) return review;
  const headSha = assertHeadSha(payload.headSha);
  const bad = payload.items.filter((it) => it.status !== "fixed" && it.status !== "contested");
  if (bad.length) throw new Error(`status inválido (${bad.map((it) => it.id).join(", ")}): o autor só responde fixed ou contested`);

  let landed = false as boolean;
  const after = await mutateReview(review.id, (r) => {
    if (!fresh(r)) return;
    const known = new Map(r.findings.map((f) => [f.id, f]));
    const unknown = payload.items.filter((it) => !known.has(it.id)).map((it) => it.id);
    if (unknown.length) throw new Error(`achado desconhecido: ${unknown.join(", ")}`);
    const allowed = payload.items.filter((it) => actionableForAuthor(known.get(it.id)!));
    const ignored = payload.items.filter((it) => !actionableForAuthor(known.get(it.id)!)).map((it) => it.id);
    r.findings = applyAuthorResponses(r, allowed);
    r.lastRespondRound = r.round;
    r.nudges = 0;
    const fixed = allowed.filter((it) => it.status === "fixed").length;
    const contested = allowed.length - fixed;
    note(r, "author", `${fixed} corrigido(s), ${contested} contestado(s); head ${headSha.slice(0, 7)}.`);
    if (ignored.length) note(r, "system", `Respostas ignoradas (não esperam resposta do autor): ${ignored.join(", ")}.`);
    r.round += 1;
    r.phase = "reviewing";
    note(r, "system", `Rodada ${r.round} de ${MAX_ROUNDS}: o revisor confere só o diff.`);
    landed = true;
  });
  if (!landed) return after;
  await relayReview(after, "reviewer", reviewerDeltaPrompt(after));
  return (await getReview(after.id)) ?? after;
}

/* ------------------------------------------------------------------ humano */

/**
 * A decisão do revisor HUMANO sobre um item: uma dúvida (`question`) ou um bloqueante travado.
 *  - dúvida: `block` (passa a bloquear), `drop` (retirada) ou `accept_risk`; `keep` não vale aqui.
 *  - bloqueante: `keep`/`block` (segue bloqueando; o dev resolve), `accept_risk` ou `drop`.
 * Com a rodada do revisor já entregue, a fase é recalculada: pode ir ao autor, ao Approve, ou sair
 * do impasse para `ready` quando o último item travado é liberado. Fora disso, só grava.
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
    note(r, "human", `Decisão humana em ${findingId}: ${said[decision]}.`);

    // Só a rodada do revisor já entregue tem fase a recalcular; no meio de uma, quem fecha é o submit.
    if (r.lastSubmitRound !== r.round) return;
    if (r.phase === "reviewing") {
      const next = phaseAfterReviewerRound(r);
      if (next.phase === r.phase) return;
      r.phase = next.phase;
      if (next.impasseReason) r.impasseReason = next.impasseReason;
    } else if (r.phase === "impasse") {
      // Impasse só sai pelo último item liberado; "manter" segura (o dev resolve na mão).
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

/* ------------------------------------------------------------------ fim de turno */

/**
 * Um card terminou o turno. Se for um lado que a revisão esperava (revisor em `reviewing` sem o submit
 * da rodada, autor em `fixing` sem a resposta), é "terminou sem chamar a ferramenta": a primeira vez
 * reenvia o texto da vez com o lembrete na frente; a segunda vira impasse "IA não respondeu".
 * A decisão é tomada dentro da mutação, então dois fins de turno juntos não lembram duas vezes.
 */
async function onTurnFinished(cardId: string): Promise<void> {
  const waiting: { id: string; side: Side }[] = [];
  const asReviewer = await reviewByReviewerCard(cardId);
  if (asReviewer && awaitingTool(asReviewer, "reviewer")) waiting.push({ id: asReviewer.id, side: "reviewer" });
  for (const r of await listReviewsForCards([cardId])) {
    if (awaitingTool(r, "author")) waiting.push({ id: r.id, side: "author" });
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
    if (action === "nudge") await relayReview(after, side, nudgePrefix(tool) + promptFor(after, side));
    else if (action === "impasse") await announcePhase(after);
  }
}

/**
 * Liga o orquestrador ao feed de eventos dos cards (uma vez, no boot). O listener não lança e não
 * bloqueia: só agenda o julgamento para depois de uma folga curta — a chamada da ferramenta que
 * chegou no mesmo turno ganha — e engole qualquer erro com um warn. Devolve o unsubscribe.
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
      void onTurnFinished(event.cardId).catch((err: unknown) => {
        logger.warn({ card: event.cardId, detail: (err as Error).message }, "PR review could not judge a finished turn");
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
