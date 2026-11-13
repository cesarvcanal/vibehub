import * as registry from "../board/registry.js";
import { getSettings, type Settings } from "../settings/settings.js";
import { HISTORY_REPLAY_LIMIT, appendHistory, readHistory } from "./history.js";
import {
  INFLIGHT_OWNER,
  clearInflightMarker,
  isInflightOwnerAlive,
  listInflightMarkers,
  readInflightMarker,
  releaseInflightOwnerSync,
  type InflightMarker,
} from "./inflight.js";
import { installCardSdkDriver, sdkDriverCommand } from "./driver.js";
import { restoreMissingWorkspace } from "../board/workspace.js";
import { reportCardStatusFromDriver } from "../board/agentState.js";
import { BACKGROUND_HOLD_MAX_MS, SYSTEM_ORIGIN, driverTurnRunning, ensureDriverSession, injectSystemTurn, shutdownAllDrivers } from "./manager.js";
import { stopAllMirrors } from "./mirror.js";
import { transcriptDirFor } from "../maestro/cardSession.js";
import { effectiveAccountSlug } from "../board/registry.js";
import { logger } from "../../utils/logger.js";
import { defusedCommandList } from "../../utils/ultraWords.js";

/**
 * BOOT RESUME — a panel deploy can no longer kill a native chat turn SILENTLY.
 *
 * The incident (2x on 2026-08-31): push to main → auto-deploy restarts app-vibehub → the SDK driver
 * (a child of the back via docker exec) dies with it, in the middle of a long job — and the card went silent,
 * without a single line saying what happened. The back could not warn: it was the one dying.
 *
 * The answer is durable, not heroic: the manager writes a MARKER per card while a turn is in
 * flight (services/sdk/inflight.ts). This sweep runs ONCE at boot and, for each orphaned marker:
 *
 *  1. writes a visible system line in the card's sdk-history ("o turno foi interrompido por uma
 *     atualização do painel…") — the silence ends here, even with everything else switched off;
 *  2. with `sdkAutoResume` on (default) and attempts == 0: brings the driver up again (resume of the session
 *     persisted on the card) and injects a CONTINUATION turn with system provenance — the message
 *     never looks like the user's speech (the origin mechanism from #48), and reaches the driver as a NORMAL
 *     user turn (never wrapped in a notification — the lesson of "No response requested.");
 *  3. attempts >= 1 (the interrupted turn WAS ALREADY an automatic resume): resumes AGAIN only if it
 *     advanced (`progressed`: the AI wrote or ran something before dying) and has not yet spent
 *     MAX_AUTO_RESUMES. On a day of many deploys the work goes on to the end (production, 2026-10-19:
 *     the second update in a row dropped the task halfway); what does not advance is the real
 *     loop — the resume that dies on arrival — and that one stops with the system line and an explicit
 *     stopped state. The cap covers the case that advances AND knocks the panel down on every round, right after
 *     coming back: a resume that stayed up for SETTLED_RESUME_MS restarts the chain (nextResumeAttempt).
 *  4. the turn was STOPPED on a question card: nothing to resume — only the line, and the card stays
 *     open for the person to answer (the answer goes as a message, with the background that died;
 *     see manager.ts).
 *
 * Best effort per card: a card that fails does not stop the others, and no failure brings the boot down.
 *
 * TRULY ORPHANED, not just "there is a marker": the tech.multi deploy is BLUE/GREEN — this process
 * is born with the old one STILL running the turn. Resuming there put two CLIs in the same session and the old
 * one's mirror recorded the resume prompt as terminal conversation: the system message showed up
 * twice (production, 2026-10-08). The sweep waits for the marker's owner to stop beating — the
 * blue/green switch removes the old one with `docker rm -f` (SIGKILL) — or to drop the heartbeat on a SIGTERM
 * (`handOffSdkOnShutdown`). If the turn ends over there in the meantime, the marker goes away and there is nothing to resume.
 */

/** How often the sweep re-checks a marker whose owner is still alive. */
const OWNER_POLL_MS = 2_000;

/** The continuation message injected into the driver — system provenance, short and direct text. */
export const RESUME_CONTINUATION_TEXT =
  "Continue de onde parou: o processo anterior foi interrompido por um reinício do servidor do painel (deploy). " +
  "Retome a tarefa em andamento e conclua o que estava fazendo.";

/**
 * The continuation of a turn that had background work: the interruption (a deploy or a driver
 * drop) killed those tasks and their
 * completion notice will never come. Without saying so, the agent "resumed" waiting for a result
 * that never arrives — or there was no resume at all, and the card stopped silently in the middle of the delivery. PURE.
 */
export function resumeContinuationText(marker: InflightMarker, base: string = RESUME_CONTINUATION_TEXT): string {
  const tasks = marker.background?.tasks ?? [];
  if (tasks.length === 0) return base;
  // The quoted command is not this turn's request: with the reserved word in it, the resume went up to max.
  const list = defusedCommandList(tasks.slice(0, 8));
  return `${base} A interrupção também encerrou o que estava rodando em segundo plano — ` +
    `o resultado disso não vai chegar:\n${list}\nConfira o estado atual, rode de novo o que ainda for ` +
    `necessário e siga até o fim.`;
}

/**
 * Only background, and for a long time (an `npm run dev`, a `tail -f`): it is not a delivery halfway
 * through, it is a background process. Waking the agent on every deploy because of it would be noise. PURE.
 */
export function isStaleBackgroundOnly(marker: InflightMarker, now: number): boolean {
  const bg = marker.background;
  return !!bg && bg.idle && now - bg.since > BACKGROUND_HOLD_MAX_MS;
}


/** Consecutive automatic resumes, at most, that die right after advancing. */
export const MAX_AUTO_RESUMES = 5;

/**
 * A resume that advanced and stayed up for this long did real work: the deploy that killed it is
 * someone else's, and it does not spend the cap. On a day with a deploy every ~5 min, the 5th resume of a long
 * job stopped the card midway with `progressed: true` (production, troca-de-effort-f121, 2026-11-10).
 * The cap is left for the turn that knocks the panel down right after coming back.
 */
export const SETTLED_RESUME_MS = 2 * 60_000;

/**
 * The number of the interrupted turn's next automatic resume, or null when there is no other. One that
 * advanced and settled restarts the chain at 1 — it still needs to advance to earn the next one. PURE.
 */
export function nextResumeAttempt(marker: InflightMarker, now: number): number | null {
  if (marker.attempts === 0) return 1;
  if (marker.progressed !== true) return null;
  if (now - marker.startedAt >= SETTLED_RESUME_MS) return 1;
  return marker.attempts < MAX_AUTO_RESUMES ? marker.attempts + 1 : null;
}

/** The system lines the card gets, depending on the case. */
export const NOTE_RESUMING =
  "O turno foi interrompido por uma atualização do painel — retomando automaticamente…";
export const NOTE_NOT_AGAIN =
  "O turno foi interrompido de novo por uma atualização do painel, sem avançar desde a última retomada " +
  "(ou depois de muitas retomadas seguidas). Para evitar um loop, não vou retomar automaticamente outra " +
  "vez — mande uma mensagem para continuar.";
export const NOTE_BACKGROUND_STALE =
  "Uma atualização do painel encerrou as tarefas que rodavam em segundo plano neste card havia horas " +
  "(sem turno em andamento). Não vou retomar sozinho — mande uma mensagem se precisar delas de volta.";
export const NOTE_AUTO_OFF =
  "O turno foi interrompido por uma atualização do painel. A retomada automática está desligada " +
  "(sdkAutoResume) — mande uma mensagem para continuar.";

export const NOTE_AWAITING_ANSWER =
  "O turno foi interrompido por uma atualização do painel enquanto o agente esperava a sua resposta. " +
  "A pergunta continua aberta: responda o cartão e ele segue de onde parou.";

/** The line that follows a "retomando…" that did not work out — the card does not keep promising forever. */
export const NOTE_RESUME_FAILED =
  "A retomada automática falhou antes de chegar ao Claude. Mande uma mensagem para continuar.";

/** The words of a resume: what the card reads and what the agent receives, depending on the cause. */
interface ResumeTexts {
  cause: "restart" | "crash";
  resuming: string;
  notAgain: string;
  backgroundStale: string;
  autoOff: string;
  /** The turn was stopped on a question card: there is no resume, the person answers the card. */
  awaitingAnswer: string;
  continuation: string;
}

const DEPLOY_TEXTS: ResumeTexts = {
  cause: "restart",
  resuming: NOTE_RESUMING,
  notAgain: NOTE_NOT_AGAIN,
  backgroundStale: NOTE_BACKGROUND_STALE,
  autoOff: NOTE_AUTO_OFF,
  awaitingAnswer: NOTE_AWAITING_ANSWER,
  continuation: RESUME_CONTINUATION_TEXT,
};

/** The driver dropped with the back up — there was no panel update, and the card must not say there was. */
export const CRASH_TEXTS: ResumeTexts = {
  cause: "crash",
  resuming: "O processo do Claude deste card caiu no meio do turno — retomando automaticamente…",
  notAgain:
    "O processo do Claude deste card caiu de novo, sem avançar desde a última retomada (ou depois de muitas " +
    "retomadas seguidas). Para evitar um loop, não vou retomar automaticamente outra vez — mande uma mensagem para continuar.",
  backgroundStale:
    "O processo do Claude deste card caiu e encerrou as tarefas que rodavam em segundo plano havia horas " +
    "(sem turno em andamento). Não vou retomar sozinho — mande uma mensagem se precisar delas de volta.",
  autoOff:
    "O processo do Claude deste card caiu no meio do turno. A retomada automática está desligada " +
    "(sdkAutoResume) — mande uma mensagem para continuar.",
  awaitingAnswer:
    "O processo do Claude deste card caiu enquanto o agente esperava a sua resposta. " +
    "A pergunta continua aberta: responda o cartão e ele segue de onde parou.",
  continuation:
    "Continue de onde parou: o processo anterior do Claude deste card caiu no meio do trabalho (foi encerrado " +
    "de fora, sem reinício do painel). Retome a tarefa em andamento e conclua o que estava fazendo.",
};

/** This process received SIGTERM (handOffSdkOnShutdown). */
let shuttingDown = false;

/** How long a crash resume waits: the runner that knocked down the driver (memory, restart) catches its breath first. */
export const CRASH_RESUME_DELAY_MS = 10_000;

/** Test seams: every side effect the sweep performs, replaceable as one bundle. */
export interface ResumeDeps {
  listMarkers: typeof listInflightMarkers;
  clearMarker: typeof clearInflightMarker;
  getCard: typeof registry.getCard;
  getProject: typeof registry.getProject;
  settings: typeof getSettings;
  installDriver: typeof installCardSdkDriver;
  restoreWorkspace: typeof restoreMissingWorkspace;
  commandFor: typeof sdkDriverCommand;
  ensureSession: typeof ensureDriverSession;
  inject: typeof injectSystemTurn;
  /** `lostBackground`: the background that died, written in the note to go along with the card's answer. */
  appendNote: (cardId: string, text: string, extra?: { lostBackground?: string[] }) => Promise<void>;
  readMarker: typeof readInflightMarker;
  /** This process's identity: the marker it signs is a live turn FROM HERE, not an orphan. */
  selfOwner: string;
  ownerAlive: typeof isInflightOwnerAlive;
  /** A driver of this card has a turn running right now (the successor the person already used). */
  turnRunning: (cardId: string) => boolean;
  /** This process received SIGTERM: the one that resumes now is the new process, not this one. */
  stopping: () => boolean;
  /** The dot goes to `waiting` — the drop that did not become a resume (the manager held it at `working`). */
  reportIdle: (cardId: string) => void;
  /**
   * Is the turn started at `since` waiting for the person on an open question card? Along with it, the
   * parallel work the restart killed (subagents with no result).
   */
  awaitingAnswer: (cardId: string, since: number) => Promise<{ open: boolean; lostParallel: string[] }>;
  /** The card lights up "precisa de você": the open card is waiting for the person. */
  markAwaitingDecision: (cardId: string) => Promise<void>;
  wait: (ms: number) => Promise<void>;
}

const realDeps: ResumeDeps = {
  listMarkers: listInflightMarkers,
  clearMarker: clearInflightMarker,
  getCard: registry.getCard,
  getProject: registry.getProject,
  settings: getSettings,
  installDriver: installCardSdkDriver,
  restoreWorkspace: restoreMissingWorkspace,
  commandFor: sdkDriverCommand,
  ensureSession: ensureDriverSession,
  inject: injectSystemTurn,
  appendNote: (cardId, text, extra) =>
    appendHistory(cardId, { type: "system_note", text, ...(extra?.lostBackground?.length ? { lostBackground: extra.lostBackground } : {}), at: Date.now() }),
  readMarker: readInflightMarker,
  selfOwner: INFLIGHT_OWNER,
  ownerAlive: isInflightOwnerAlive,
  turnRunning: driverTurnRunning,
  stopping: () => shuttingDown,
  reportIdle: (cardId) => reportCardStatusFromDriver(cardId, "waiting"),
  awaitingAnswer: awaitingAnswerInHistory,
  markAwaitingDecision: (cardId) => registry.setCardAwaitingDecision(cardId, Date.now()),
  wait: (ms) => new Promise((resolve) => { setTimeout(resolve, ms).unref?.(); }),
};

/**
 * The question cards asked since `since` that no `question_result` closed — what the interrupted
 * turn was waiting for from the person. PURE.
 */
export function openQuestionIds(events: ReadonlyArray<{ type: string; id?: unknown; at?: number }>, since: number): string[] {
  const open = new Set<string>();
  for (const event of events) {
    if (typeof event.id !== "string") continue;
    if (event.type === "user_question" && (event.at ?? 0) >= since) open.add(event.id);
    else if (event.type === "question_result") open.delete(event.id);
  }
  return [...open];
}

/**
 * The subagents (Agent/Task) called since `since` that did not come back — they ran in parallel and died
 * with the restart. PURE.
 */
function unfinishedSubagents(
  events: ReadonlyArray<{ type: string; id?: unknown; name?: unknown; input?: unknown; at?: number }>,
  since: number,
): string[] {
  const open = new Map<string, string>();
  for (const event of events) {
    if (typeof event.id !== "string" || (event.at ?? 0) < since) continue;
    if (event.type === "tool_use" && (event.name === "Agent" || event.name === "Task")) {
      const input = (event.input ?? {}) as { description?: unknown };
      open.set(event.id, `subagente: ${typeof input.description === "string" && input.description ? input.description : event.id}`);
    } else if (event.type === "tool_result") open.delete(event.id);
  }
  return [...open.values()];
}

/** The card's history says whether the turn started at `since` is waiting for a card's answer. */
export async function awaitingAnswerInHistory(cardId: string, since: number): Promise<{ open: boolean; lostParallel: string[] }> {
  const events = await readHistory(cardId, HISTORY_REPLAY_LIMIT, { strict: true });
  return { open: openQuestionIds(events, since).length > 0, lostParallel: unfinishedSubagents(events, since) };
}

/**
 * Waits for the marker to stop having a live owner. Returns the ORPHANED marker (the re-read version, which is
 * the one that counts), or null when there is nothing to resume: the turn finished at the owner, or the marker became
 * this process's (someone sent a message here while the old one was still on its way out).
 */
async function orphanedMarker(cardId: string, first: InflightMarker, deps: ResumeDeps): Promise<InflightMarker | null> {
  let marker: InflightMarker | null = first;
  let announced = false;
  while (marker) {
    // No owner = written by a version from before this mechanism: orphaned as it always was.
    if (!marker.owner) return marker;
    if (marker.owner === deps.selfOwner) return null;
    if (!(await deps.ownerAlive(marker.owner))) return marker;
    if (!announced) {
      announced = true;
      logger.info({ card: cardId, owner: marker.owner }, "sdk turn still alive in the previous instance — waiting for it to hand off");
    }
    await deps.wait(OWNER_POLL_MS);
    marker = await deps.readMarker(cardId);
  }
  return null;
}

interface ResumeSummary {
  /** Cards whose interrupted turn was resumed automatically. */
  resumed: string[];
  /** Cards that only got the system line (attempts spent, flag off, sdkDriver off, card gone). */
  noted: string[];
}

/**
 * The one boot sweep. Never throws; returns what it did (for the log and for the tests).
 * Call it AFTER listen — the resume must not delay the server from accepting connections.
 */
export async function resumeInterruptedTurns(deps: ResumeDeps = realDeps): Promise<ResumeSummary> {
  const summary: ResumeSummary = { resumed: [], noted: [] };
  let markers: Array<{ cardId: string; marker: InflightMarker }>;
  try {
    markers = await deps.listMarkers();
  } catch (err) {
    logger.warn({ detail: (err as Error).message }, "could not list sdk inflight markers at boot");
    return summary;
  }
  if (markers.length === 0) return summary;

  let settings: Settings;
  try {
    settings = await deps.settings();
  } catch (err) {
    logger.warn({ detail: (err as Error).message }, "could not read settings for the sdk boot resume");
    return summary;
  }

  // Each card in its own task: one card's live turn does not delay another's resume.
  // The driver install in the runner is a single one, shared by all.
  let install: Promise<void> | null = null;
  const installOnce = (): Promise<void> => (install ??= deps.installDriver());
  await Promise.all(markers.map(async ({ cardId, marker: first }) => {
    let marker: InflightMarker | null;
    try {
      marker = await orphanedMarker(cardId, first, deps);
    } catch (err) {
      logger.warn({ card: cardId, detail: (err as Error).message }, "could not tell whether an sdk inflight marker is orphaned");
      return;
    }
    if (!marker) return;
    const outcome = await resumeCard(cardId, marker, settings, deps, installOnce, DEPLOY_TEXTS);
    if (outcome === "resumed") summary.resumed.push(cardId);
    else if (outcome === "noted") {
      summary.noted.push(cardId);
      // The `working` on the board belongs to the process that died with the turn: no hook or driver from here will
      // clear it (production, card a28ffa23, 2026-10-20). Only on "noted": "skipped" is a card stopped on
      // purpose (a report would unhibernate it) or a conversation that went on in a live turn, which owns the dot.
      settleUnresumed(cardId, outcome, deps);
    }
  }));
  return summary;
}

/** What fell to ONE card whose turn died (see `resumeCard`). */
type ResumeOutcome = "resumed" | "noted" | "skipped";

/**
 * ONE card whose turn died: the visible line and, if the rules allow, the resume. The same for the
 * boot (deploy) and for the driver drop; only the words change. Never throws. "skipped" = nothing to
 * say or to resume: the card vanished or was stopped on purpose (marker swept silently), or the
 * conversation moved on during the preparation.
 */
async function resumeCard(
  cardId: string,
  marker: InflightMarker,
  settings: Settings,
  deps: ResumeDeps,
  installOnce: () => Promise<void>,
  texts: ResumeTexts,
): Promise<ResumeOutcome> {
  let announced = false;
  try {
    const card = await deps.getCard(cardId);
    const project = card ? await deps.getProject(card.projectId) : undefined;
    if (!card || !project) {
      // The card is gone (deleted between the marker and this boot): nothing to tell, no one to tell it to.
      await deps.clearMarker(cardId);
      return "skipped";
    }
    if (!registry.hasLiveSession(card)) {
      // Paused or hibernated after the drop: the card was stopped ON PURPOSE — the pause had no live driver
      // to clear the marker (it had already dropped). Resuming would undo the person's decision.
      await deps.clearMarker(cardId);
      return "skipped";
    }
    if (!settings.sdkDriver || !settings.sdkAutoResume) {
      await deps.appendNote(cardId, texts.autoOff);
      await deps.clearMarker(cardId);
      logger.info({ audit: true, action: "sdk.resume.off", card: card.worktreeSlug }, "interrupted sdk turn noted — auto-resume off");
      return "noted";
    }
    if (isStaleBackgroundOnly(marker, Date.now())) {
      await deps.appendNote(cardId, texts.backgroundStale);
      await deps.clearMarker(cardId);
      logger.info({ audit: true, action: "sdk.resume.background_stale", card: card.worktreeSlug }, "long-lived background work ended by the restart — noted, not resumed");
      return "noted";
    }
    const waiting = await awaitingAnswer(cardId, marker, deps);
    if (waiting) {
      // Stopped on a question card, the turn has nothing to resume: it waits for the person. The resume
      // closed the card ("respondeu por mensagem") and the agent asked again on a blank
      // card — what had already been ticked was lost (production, 2026-11-03). Left open, the click goes to the
      // model as a message (the orphan's answer, manager.ts) — with what the others ticked and, if the
      // restart killed something in the background, with the list of what died (written in this note).
      // What died along with it — background and parallel subagents — goes to the model with the answer.
      const lostBackground = [...(marker.background?.tasks ?? []), ...waiting.lostParallel];
      await deps.appendNote(cardId, texts.awaitingAnswer, lostBackground.length ? { lostBackground } : undefined);
      await deps.clearMarker(cardId);
      await deps.markAwaitingDecision(cardId).catch(() => undefined);
      logger.info({ audit: true, action: "sdk.resume.awaiting_answer", card: card.worktreeSlug }, "interrupted sdk turn was waiting on a question card — left open, not resumed");
      return "noted";
    }
    const attempt = nextResumeAttempt(marker, Date.now());
    if (attempt === null) {
      await deps.appendNote(cardId, texts.notAgain);
      await deps.clearMarker(cardId);
      logger.warn(
        { audit: true, action: "sdk.resume.loop_guard", card: card.worktreeSlug, attempts: marker.attempts, progressed: !!marker.progressed },
        "interrupted sdk turn NOT resumed again — loop guard",
      );
      return "noted";
    }
    await deps.appendNote(cardId, texts.resuming);
    announced = true;
    await installOnce();
    await deps.restoreWorkspace(card.id);
    // The resume uses the key persisted on the card (resumeSessionId — written by the manager on every
    // session/result). The connect's transcript probe does not run here: it is the same target in practice,
    // and the boot must not depend on an ls in the runner for each card.
    const command = await deps.commandFor(project, card);
    // The preparation takes seconds (install, workspace, command): if in the meantime the conversation
    // MOVED ON — the person wrote in a driver the reconnect brought up, and the marker is already their turn —
    // the continuation would land on top of someone's turn. Checked here, right before injecting.
    if (deps.stopping()) return "skipped"; // the marker stays: it is the message for the new process
    if (await conversationMovedOn(cardId, marker, deps)) {
      logger.info({ audit: true, action: "sdk.resume.superseded", card: card.worktreeSlug }, "the conversation moved on while the resume was being prepared — not injected");
      return "skipped";
    }
    const session = deps.ensureSession({
      cardId: card.id,
      label: card.worktreeSlug,
      command,
      transcriptDir: transcriptDirFor(project, card, effectiveAccountSlug(card, project)),
    });
    // WITHOUT progress — the resumed turn's marker only gets `progressed` when the AI produces something
    // (manager); if it dies before that, the next boot only takes note.
    deps.inject(session, resumeContinuationText(marker, texts.continuation), SYSTEM_ORIGIN, attempt);
    logger.info(
      {
        audit: true, action: "sdk.resume", card: card.worktreeSlug, cause: texts.cause,
        interruptedAt: marker.startedAt, preview: marker.preview, attempt,
        background: marker.background?.tasks,
      },
      "interrupted sdk turn resumed",
    );
    return "resumed";
  } catch (err) {
    logger.warn({ card: cardId, detail: (err as Error).message }, "could not resume an interrupted sdk turn");
    // After a "retomando…" on screen, silence would be the same old silent stop.
    if (announced) await deps.appendNote(cardId, NOTE_RESUME_FAILED).catch(() => undefined);
    // The marker stays only when nothing was written: with the note already down, keeping the
    // marker would note the same interruption again on the next boot. Best-effort cleanup:
    await deps.clearMarker(cardId).catch(() => undefined);
    return "noted";
  }
}

/**
 * Was the marker's turn waiting for a card's answer? Returns the parallel work that
 * died with it, or null. When in doubt (unreadable disk), null: resumes as before.
 */
async function awaitingAnswer(cardId: string, marker: InflightMarker, deps: ResumeDeps): Promise<{ lostParallel: string[] } | null> {
  try {
    const found = await deps.awaitingAnswer(cardId, marker.startedAt);
    return found.open ? { lostParallel: found.lostParallel } : null;
  } catch (err) {
    logger.warn({ card: cardId, detail: (err as Error).message }, "could not read the history for open question cards — resuming as usual");
    return null;
  }
}

/** The conversation moved on since this marker: another turn on disk, or a turn running in a live driver. */
async function conversationMovedOn(cardId: string, marker: InflightMarker, deps: ResumeDeps): Promise<boolean> {
  const now = await deps.readMarker(cardId);
  return !now || now.startedAt !== marker.startedAt || deps.turnRunning(cardId);
}

/**
 * THE DRIVER DROPPED with the back up (OOM, kill, the docker exec that died) and there was work in flight. The
 * marker belongs to this process, alive — the boot sweep would never see it as an orphan, and the turn would only come back
 * on the next deploy, at the wrong time. It waits a little (the runner that knocked down the driver catches its breath), re-reads the
 * marker and only resumes if NOTHING moved in the meantime: the same turn (the person did not send another
 * message in a successor driver) and no turn running. From there on, the boot's rules.
 */
export async function resumeAfterDriverCrash(
  cardId: string,
  crashed: InflightMarker,
  deps: ResumeDeps = realDeps,
): Promise<ResumeOutcome> {
  let outcome: ResumeOutcome = "skipped";
  try {
    await deps.wait(CRASH_RESUME_DELAY_MS);
    // SIGTERM during the wait: the marker is the message for the new process, which resumes it itself.
    if (deps.stopping()) return "skipped";
    // Checked right here too: a superseded drop does not even get the "retomando…" line.
    if (!(await conversationMovedOn(cardId, crashed, deps))) {
      outcome = await resumeCard(cardId, crashed, await deps.settings(), deps, () => deps.installDriver(), CRASH_TEXTS);
    }
  } catch (err) {
    logger.warn({ card: cardId, detail: (err as Error).message }, "could not resume after an sdk driver crash");
    // If left, this live process's marker would be resumed on the next deploy, at the wrong time.
    await deps.clearMarker(cardId).catch(() => undefined);
  }
  // The manager held the dot at `working` waiting for this verdict.
  settleUnresumed(cardId, outcome, deps);
  return outcome;
}

/**
 * The dead turn that did NOT become a resume: with no live turn in another driver, the dot goes to `waiting` — the
 * real "turno terminou", once. On a SIGTERM the new process is the one that decides.
 */
function settleUnresumed(cardId: string, outcome: ResumeOutcome, deps: ResumeDeps): void {
  if (outcome !== "resumed" && !deps.stopping() && !deps.turnRunning(cardId)) deps.reportIdle(cardId);
}

/**
 * This process's goodbye on a SIGTERM (`docker stop`, restart; the blue/green switch is SIGKILL and does not
 * come through here — there the heartbeat ages on its own). In THIS order, which is the one that closes the duplicate:
 *  1. the mirrors stop: from here on nothing the new process writes in the transcript comes back as
 *     "terminal" on this side;
 *  2. the drivers close (the markers stay: they are the message for the new one);
 *  3. the heartbeat goes away: only now does the new one's sweep start seeing this one's markers as orphans.
 * Synchronous — the docker stop gives seconds, not promises.
 */
export function handOffSdkOnShutdown(): void {
  shuttingDown = true; // a crash resume on hold brings nothing else up (see resumeAfterDriverCrash)
  try { stopAllMirrors(); } catch { /* best-effort by design */ }
  try { shutdownAllDrivers(); } catch { /* best-effort by design */ }
  releaseInflightOwnerSync();
}
