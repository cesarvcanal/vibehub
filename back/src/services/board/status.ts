import * as registry from "./registry.js";
import { killCardSession, restartCard } from "./workspace.js";
import * as outbox from "./outbox.js";
import { cardHoldsBackgroundWork, onCardStatusSink } from "./agentState.js";
import { observeCardStatus } from "../events/cardEvents.js";
import { logger } from "../../utils/logger.js";

/**
 * A STATUS REPORT for a card (working|waiting) and everything it sets in motion: the dot and the
 * column (applyCardStatus), a pending pause or restart that falls due, the outbox flush. Two callers:
 * the runner hooks (POST /api/runner/status) and the native chat's manager, when the last
 * background task of a turn that already closed ends with no hook to say so.
 *
 * TRABALHO EM SEGUNDO PLANO (produção, 2026-10-20): o turno dispara a suíte com `run_in_background`
 * e fecha; o hook `Stop` chega com `waiting` e o card virava "aguardando" no board enquanto o chat
 * mostrava "1 tarefa rodando em segundo plano — o Claude segue trabalhando". Enquanto o driver do
 * chat nativo segura uma tarefa viva (dentro do teto, ver BACKGROUND_HOLD_MAX_MS), `waiting` vale
 * como `working`: o Claude não chegou ao prompt de verdade, vai retomar quando ela terminar. Isso
 * também segura a pausa/reinício pendente e a fila, que matariam ou atropelariam a tarefa.
 */
export async function reportCardStatus(cardId: string, reported: registry.CardStatus): Promise<registry.Card | undefined> {
  const status: registry.CardStatus = reported === "waiting" && cardHoldsBackgroundWork(cardId) ? "working" : reported;
  // State BEFORE the status is applied: it is what decides whether this is the moment to carry out
  // a PENDING RESTART (a card flagged while the brain/MCPs changed under a working Claude).
  // SNAPSHOT the primitives — `getCard` hands back the LIVE cached card, so applyCardStatus mutates
  // that very object and reading these fields afterwards would always show the post-status state.
  const before = await registry.getCard(cardId);
  const wasPending = Boolean(before?.restartPendingAt);
  const wasLive = before ? registry.hasLiveSession(before) : false;
  const wasColumn = before?.column;
  const pendingReason = before?.restartReason;
  const wasStatus = before?.status;
  const card = await registry.applyCardStatus(cardId, status);
  // What a person away from the board hears (services/events/cardEvents.ts): a turn that ended, or
  // a new one clearing what was open. Started now, with what was declared at this moment (the card
  // is the live cached object); awaited only at the end, so it never holds the pause, the restart or
  // the flush back. It never rejects.
  const observed = card
    ? observeCardStatus(card.id, wasStatus, status, { state: card.declaredState, summary: card.declaredSummary })
    : undefined;
  // A PAUSE BEATS the pending restart: a card whose PENDING PAUSE is due now is going to sleep, so
  // restarting it would be wasted work — applyCardStatus already dropped the flag in that case.
  const pausing = wasColumn ? registry.shouldEndSessionOnStatus(status, wasColumn, wasLive) : false;
  if (card && pausing) {
    // The PENDING PAUSE is due: the card was dragged into Paused while Claude was working, and
    // Claude has just finished. applyCardStatus stamped `pausedAt` — which is the board saying
    // "this session is dead" — so it has to actually die, here. Without this the card looked
    // parked while its tmux session (and the shell beside it) stayed resident in the runner.
    // Best-effort: killCardSession never throws, and a hook must not fail over the runner.
    await killCardSession(card, { includeShell: true });
    logger.info(
      { audit: true, action: "card.pause.due", card: card.worktreeSlug, session: card.tmuxSession },
      "pending pause carried out — Claude finished and the tmux sessions were ended",
    );
  }
  if (card && !pausing && registry.shouldRestartOnStatus(status, wasPending, wasLive)) {
    // PENDING RESTART (brain/MCP): the card was `working` when the brain/MCPs changed; now Claude has
    // finished (status != working), so restart the session to re-read them at startup (`claude -c`
    // resumes the SAME conversation). applyCardStatus has already cleared the flag.
    try {
      await restartCard(card.id);
      logger.info(
        { audit: true, action: "card.restart.pending", card: card.worktreeSlug, reason: pendingReason },
        "pending restart carried out — Claude finished and the session was restarted to re-read the brain/MCPs",
      );
    } catch (err) {
      // The hook is fire-and-forget: a restart that fails must never turn into an error for it.
      logger.warn(
        { card: card.worktreeSlug, detail: (err as Error).message },
        "pending restart failed (best-effort) — the card keeps running with the old brain/MCPs",
      );
    }
  }
  // The agent just told us where it is. `waiting` means it reached its prompt — the best possible
  // moment for anything queued for this card, and the reason a message typed while Claude was
  // down lands the instant it comes back. Fire-and-forget: the hook has a 3s timeout.
  if (card && status === "waiting") void outbox.flushCard(card.id);
  await observed;
  return card;
}

onCardStatusSink(reportCardStatus);
