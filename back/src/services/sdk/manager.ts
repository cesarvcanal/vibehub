import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { WebSocket } from "ws";
import * as registry from "../board/registry.js";
import { onCardDriverProbe, type DriverActivity } from "../board/agentState.js";
import { onCardInUseProbe, onCardSessionKill } from "../board/workspace.js";
import { HISTORY_REPLAY_LIMIT, appendHistory, appendHistoryReported, readHistory, replayableHistoryEvent, rewindHistory, type HistoryEvent } from "./history.js";
import { clearInflightMarker, inflightPreview, writeInflightMarker } from "./inflight.js";
import { createLineReader, forgetDriverKeys, noteDriverEventFor, onOutsideTurn } from "./mirror.js";
import { writeCardCatalog } from "./catalog.js";
import { forgetCardWorkflows, lastWorkflowRuns, watchCardWorkflows } from "./workflow.js";
import { isHarnessFiller } from "../chat/chat.js";
import {
  buildOrphanAnswerText, buildSupersedeText, interruptNote, normalizeSlashCommands, parseDriverLine, parseSdkClientFrame, parseTypingFrame, encodeControl,
  type CatalogEvent, type DriverControl, type DriverEvent, type QuestionAnswerControl, type UserQuestionItem,
} from "./protocol.js";
import type { MessageOrigin } from "../chat/provenance.js";
import { logger } from "../../utils/logger.js";

/**
 * SDK DRIVER MANAGER — ONE driver process per card, owned by the BACKEND, not by a websocket.
 *
 * The bug this closes (the reload-mid-turn bug): the driver used to be spawned per
 * CONNECTION and torn down in the socket's close handler — the user sent a message on the native
 * chat, hit Cmd+Shift+R, the socket died and killed the driver MID-TURN. The answer never reached
 * the transcript, and the reconnect's fresh driver resumed the session without continuing the
 * pending turn: the message was silently swallowed.
 *
 * The manager decouples the turn from the page:
 *  - `ensureDriverSession` spawns AT MOST one driver per card and hands every later connect the
 *    same live process (two tabs of one card multiplex one driver — never two);
 *  - the manager itself listens to the driver's stdout: history persistence, mirror dedupe keys
 *    and resume-id persistence all live HERE, the side that survives — a turn keeps flowing into
 *    `sdk-history` with zero pages open;
 *  - `attachSocket` fans events out to every connected socket and funnels controls (user message,
 *    interrupt, permission decision) into the one stdin; a socket closing merely detaches it;
 *  - end of life: `stopCardDriver` (wired into `killCardSession` via `onCardSessionKill`, so
 *    pause/hibernate/restart/delete/model-switch all end the driver), plus an IDLE timer — a
 *    driver with no sockets AND no running turn for `DRIVER_IDLE_MS` shuts down on its own (the
 *    persisted resume id brings the conversation back on the next connect).
 *
 * The runner reaper never touches a live driver: the driver is not a `claude`/watcher process, its
 * SDK subprocesses hang off it (never ppid 1 while it lives), and `reapCandidates` additionally
 * refuses anything carrying the driver's path (see services/reaper/reaper.ts).
 */

/** No sockets AND no running turn for this long ⇒ the driver shuts down (resume covers the rest). */
export const DRIVER_IDLE_MS = 15 * 60_000;

/** Websocket keepalive — same cadence as the terminal socket (proxies drop idle websockets). */
const KEEPALIVE_MS = 25_000;

/**
 * The floor between two "está digitando" relays from ONE socket. The front already throttles; this
 * is the server's own guard, so a misbehaving tab can never turn keystrokes into a fan-out storm.
 * The "parou" is never held back by it (a stale indicator is the visible bug, not a busy wire).
 */
export const TYPING_RELAY_MIN_MS = 1_000;

export interface DriverSession {
  cardId: string;
  /** Log label (the card's worktree slug). */
  label: string;
  child: ChildProcessWithoutNullStreams;
  sockets: Set<WebSocket>;
  /** The driver said `ready` — a socket attaching after this gets a synthesized one. */
  ready: boolean;
  /** Latest session id the driver reported — the resume key (also persisted on the card). */
  lastSessionId?: string;
  /**
   * The card's transcript directory inside the runner (`/root/.claude/projects/<slug>`). It is the
   * root of where the harness writes a workflow's journal, and the ONLY reason the manager knows
   * it: see `workflowDirs` below. Absent = this driver was spawned without it and the fleet simply
   * is not watched.
   */
  transcriptDir?: string;
  /** Turns in flight or queued in the driver: +1 per user send, -1 per result. */
  activeTurns: number;
  /**
   * The session's command CATALOGUE (what the chat's "/" menu offers), as last reported by the
   * driver. Kept HERE, next to `ready`: it is session state, not conversation — it is never
   * written to the history, and a page that attaches later gets it replayed from this field
   * instead of waiting for the next `init` (which only comes with the next turn).
   */
  catalog?: CatalogEvent;
  idleTimer: NodeJS.Timeout | null;
  /** Rolling tail of the driver's stderr — what a post-mortem has to say (see STDERR_TAIL_MAX). */
  stderrTail: string;
  /** The session was stopped or its child closed — a new ensure must spawn anew. */
  closed: boolean;
  /**
   * A stop was asked for and the aborted turn has not reported back yet: the note that will
   * NARRATE the cut in the conversation (see `interruptNote`). It is flushed with the turn's
   * `result` — not when the interrupt is sent — so it lands AFTER the last deltas the aborting turn
   * still emits, right under the sentence that stops mid-way instead of on top of it.
   */
  pendingInterruptNote?: string;
  /**
   * THE EDITS IN FLIGHT, oldest first — one entry per `edit_user` written to stdin, consumed in
   * order by the `rewound` answers that come back. A `rewound` that belongs to nothing (a driver
   * reporting twice, a stale frame) finds the queue empty and cuts nothing.
   *
   * `original` is the message being replaced (the log's cut point); `text` is the CORRECTED
   * version. Both are needed because the two shapes of an edit reach the model with DIFFERENT
   * words — the clean text after a rewind, the supersede wrapper when the rewind is refused — and
   * only the driver chooses. The mirror's dedupe is registered at send time with the wrapper, so
   * a rewind left the transcript line unrecognised and the terminal mirror published the corrected
   * message a second time: one more bubble UNDER the one just corrected (produção, 2026-10-01).
   *
   * A QUEUE and not one slot because nothing stops a second edit from going out before the first
   * is answered (with no turn running the screen dispatches an edit immediately). With one slot
   * the second overwrote the first, and then the first `rewound` cut the log at the WRONG message —
   * deleting a correction the person wrote and the model had already read.
   */
  rewinds: Array<{ original: string; text: string }>;
  /**
   * OS RECIBOS JÁ EMITIDOS — `cid` → o envio que o driver já leu (`AcceptedSend`): a promessa de
   * durabilidade que o primeiro envio ganhou e a linha que ela grava.
   *
   * O "Reenviar" da bolha manda as MESMAS palavras com o MESMO `cid`, de propósito: ele existe para
   * o caso em que o recibo se perdeu, não a mensagem (o socket caiu entre o append e o `user_ack`,
   * que então é descartado em silêncio; ou o prazo do navegador venceu enquanto esta conexão ainda
   * estava sendo montada). Sem esta memória o reenvio virava uma mensagem NOVA: segunda linha no
   * histórico, segundo turno, e o agente executando duas vezes uma instrução que pode ser
   * destrutiva. Um cid já aceito não é uma mensagem — é a cobrança de um recibo, e é só o recibo
   * que ele recebe de volta.
   */
  acceptedCids: Map<string, AcceptedSend>;
  /** Cancela a inscrição no espelho (conversa vinda da aba Terminal). Vive o que o driver viver. */
  offOutside?: () => void;
  /**
   * AS PERGUNTAS QUE ESTE DRIVER FEZ — todo `user_question` que ele emitiu, encerrado ou não. O
   * driver guarda as dele só em memória; um cartão pendente no histórico que NÃO está aqui é
   * ÓRFÃO: quem o abriu morreu (deploy, crash, hibernação) e este driver nunca ouviu falar dele.
   * Nunca sai daqui ao ser encerrada: o `question_result` do driver chega ao disco DEPOIS de chegar
   * aqui, e uma leitura no meio desse caminho tomaria a pergunta dele por órfã (resultado duplicado).
   */
  ownQuestions: Set<string>;
  /** Órfãs que este manager já ENCERROU: um clique tardio nelas recebe o erro, nunca silêncio. */
  settledOrphans: Set<string>;
  /** Órfãs com uma resposta A CAMINHO: o segundo clique (outra aba, duplo clique) vira nada. */
  answeringOrphans: Set<string>;
  /**
   * A varredura de órfãs por mensagem já rodou. Órfã é pergunta de um driver ANTERIOR: depois que
   * este driver subiu nenhuma nova pode nascer, então uma varredura basta — sem ler o histórico
   * inteiro a cada mensagem da vida da sessão.
   */
  orphansSwept: boolean;
}

/**
 * Quantos recibos uma sessão lembra. Alto o bastante para cobrir qualquer reenvio que uma pessoa
 * ainda faria (o outbox do navegador guarda poucos), baixo o bastante para a memória não crescer
 * com a conversa. O mais antigo sai primeiro: um cid esquecido só volta a ser uma mensagem nova.
 */
const ACCEPTED_CIDS_MAX = 256;

/**
 * Um envio que o driver JÁ leu: a promessa de durabilidade do seu recibo e a linha do histórico que
 * ela tenta gravar. A linha fica guardada porque a gravação pode falhar (disco cheio) DEPOIS de o
 * modelo ter recebido a mensagem — e aí o reenvio desse cid é a hora de gravá-la de novo, nunca de
 * mandá-la outra vez ao driver (ver `chargeReceipt`).
 */
interface AcceptedSend {
  persisted: Promise<boolean>;
  line: HistoryEvent;
}

/** Lembra o recibo deste envio, descartando os mais antigos. A ordem do `Map` é a de inserção. */
function rememberCid(session: DriverSession, cid: string | undefined, sent: AcceptedSend): void {
  if (!cid) return;
  session.acceptedCids.set(cid, sent);
  while (session.acceptedCids.size > ACCEPTED_CIDS_MAX) {
    const oldest = session.acceptedCids.keys().next();
    if (oldest.done) break;
    session.acceptedCids.delete(oldest.value);
  }
}

/**
 * What became of ONE client frame, so the socket that sent it can be TOLD.
 *
 * The bug this exists for (produção, 2026-09-17): a send whose driver had just been killed — the
 * idle sweep hibernating a card someone was chatting in — was written into a dead stdin inside a
 * `try {} catch {}`, persisted to the history anyway, and answered with silence. On screen it was
 * a message "enviada" that spun forever; on the next F5 it was either a message nobody ever
 * answered or (when the socket itself was the dead end) no message at all. Nothing in the pipe
 * could tell the difference, because nothing in the pipe ever ANSWERED.
 *
 * Now every user frame gets a verdict: `accepted` once the message is durably in the card's
 * history AND in the driver's stdin, `refused` when the driver is gone (nothing written, nothing
 * persisted — the browser keeps the words and may resend), or `ignored` for a frame that is not a
 * turn (an interrupt, a permission click: those need no receipt).
 */
export type ClientFrameOutcome =
  /** `persisted` resolves `true` once the message is on disk, `false` when that write failed. */
  | { kind: "accepted"; cid?: string; persisted: Promise<boolean> }
  | { kind: "refused"; cid?: string; reason: string }
  | { kind: "ignored" };

/** How much stderr the post-mortem keeps. Enough for a stack trace, bounded against a chatty child. */
export const STDERR_TAIL_MAX = 2000;

const sessions = new Map<string, DriverSession>();

/* ------------------------------------------------------------- test seams */

type DriverSpawner = (file: string, args: string[]) => ChildProcessWithoutNullStreams;

const realSpawner: DriverSpawner = (file, args) =>
  spawn(file, args, { stdio: ["pipe", "pipe", "pipe"] }) as ChildProcessWithoutNullStreams;

let spawner: DriverSpawner = realSpawner;

/** Test hook: replace (or with null, restore) how the driver child is spawned. */
export function setDriverSpawnerForTesting(fn: DriverSpawner | null): void {
  spawner = fn ?? realSpawner;
}

/** Test hook: stop and forget every live driver session. */
export function resetSdkSessionsForTesting(): void {
  for (const cardId of [...sessions.keys()]) stopCardDriver(cardId);
  sessions.clear();
}

/** Whether a card has a LIVE driver right now. */
export function hasDriverSession(cardId: string): boolean {
  const session = sessions.get(cardId);
  return !!session && !session.closed;
}

/**
 * Is this card's chat ACTUALLY in use — a page connected to it, or a turn running?
 *
 * This is the veto the idle sweep asks for (see `onCardInUseProbe` in services/board/workspace.ts).
 * It is deliberately narrower than `hasDriverSession`: a driver nobody is connected to and that is
 * doing nothing may be hibernated like any cold card (its own idle stop would kill it anyway), but
 * a card with someone's chat OPEN is a card whose next keystroke can arrive at any instant — and
 * hibernating it kills this driver right under that keystroke, which is exactly what ate messages.
 */
export function isCardChatInUse(cardId: string): boolean {
  const session = sessions.get(cardId);
  if (!session || session.closed) return false;
  return session.sockets.size > 0 || session.activeTurns > 0;
}

/**
 * What this card's driver is doing right now, for the board's session view (see
 * `onCardDriverProbe` in services/board/agentState.ts): `turn` while a turn is in flight, `idle`
 * for a live driver at the prompt, `none` when there is no driver. Read-only and in-memory.
 */
export function driverActivity(cardId: string): DriverActivity {
  const session = sessions.get(cardId);
  if (!session || session.closed) return "none";
  return session.activeTurns > 0 ? "turn" : "idle";
}

/* ---------------------------------------------------------------- helpers */

/** ws sockets expose the raw TCP socket as `_socket`; flushing small frames beats batching them. */
function disableNagle(socket: WebSocket): void {
  const raw = (socket as unknown as { _socket?: { setNoDelay?: (v: boolean) => void } })._socket;
  try { raw?.setNoDelay?.(true); } catch { /* the socket is already closing */ }
}

function broadcast(session: DriverSession, event: object): void {
  const frame = JSON.stringify(event);
  for (const socket of session.sockets) {
    try { socket.send(frame); } catch { /* that socket is going away; its close handler detaches it */ }
  }
}

/**
 * The PANEL's own line in the conversation — broadcast to every open tab AND written to the
 * history, so a reload still reads it. Used for the interrupt notes: without them a turn cut
 * mid-sentence looked like Claude simply trailing off.
 */
function emitSystemNote(session: DriverSession, text: string): void {
  const at = Date.now();
  broadcast(session, { type: "system_note", text, at });
  void appendHistory(session.cardId, { type: "system_note", text, at });
}

function clearIdleTimer(session: DriverSession): void {
  if (session.idleTimer) {
    clearTimeout(session.idleTimer);
    session.idleTimer = null;
  }
}

/**
 * Arm the idle stop when NOTHING holds the driver: no page connected and no turn in flight. The
 * check runs again when the timer fires — a turn or a socket that showed up in between wins.
 */
function maybeScheduleIdleStop(session: DriverSession): void {
  if (session.closed || session.sockets.size > 0 || session.activeTurns > 0) return;
  if (session.idleTimer) return;
  session.idleTimer = setTimeout(() => {
    session.idleTimer = null;
    if (session.closed || session.sockets.size > 0 || session.activeTurns > 0) return;
    logger.info({ card: session.label, audit: true, action: "sdk.driver.idle" }, "sdk driver idle — shutting it down (resume id persisted)");
    stopCardDriver(session.cardId);
  }, DRIVER_IDLE_MS);
  session.idleTimer.unref?.();
}

/** One driver event, seen by the SURVIVING side: persist, remember, fan out. */
function handleDriverEvent(session: DriverSession, event: DriverEvent): void {
  // The harness's canned close-out for a turn that died mid-flight ("No response requested.") can
  // also arrive LIVE, as the resumed session's first assistant message. It is filler, not an
  // answer — shown, it reads as Claude dismissing the person's message (the production symptom).
  if (event.type === "assistant_text" && typeof (event as { text?: unknown }).text === "string"
    && isHarnessFiller("assistant", (event as { text: string }).text)) return;
  if (event.type === "ready") {
    session.ready = true;
    // Stamp the manager's live turn count on the frame: a message may already be queued on the
    // fresh driver's stdin (sent before it booted) — the front's spinner must know it.
    event = { ...event, turnActive: session.activeTurns > 0 };
  }
  if ((event.type === "session" || event.type === "result") && event.sessionId && event.sessionId !== session.lastSessionId) {
    session.lastSessionId = event.sessionId;
    // Persist the resume key on the card (board.json) so the NEXT driver spawn — after an idle
    // stop, a pause, a backend restart — continues this very conversation (`--resume`).
    void registry.updateCard(session.cardId, { resumeSessionId: event.sessionId }).catch((err: unknown) => {
      logger.warn({ card: session.label, detail: (err as Error).message }, "could not persist the sdk session id");
    });
  }
  if (event.type === "catalog") {
    // Normalised HERE, on the side that talks to the browser: the driver forwards what the CLI
    // said, and this is where names are validated, descriptions flattened and the list capped.
    const raw = event as unknown as { commands?: unknown; skills?: unknown; plugins?: unknown; hidden?: unknown };
    event = {
      type: "catalog",
      commands: normalizeSlashCommands(raw.commands, { skills: raw.skills, plugins: raw.plugins, hidden: raw.hidden }),
    };
    session.catalog = event;
    // EM DISCO também: o driver anuncia o catálogo uma vez, ao subir, e o menu "/" precisa existir
    // no INSTANTE do connect — não depois do boot do driver seguinte (ver ./catalog.ts).
    void writeCardCatalog(session.cardId, event);
  }
  // A FROTA FICOU VISÍVEL. A tool `Workflow` devolve na hora e trabalha em segundo plano: o turno
  // acaba, o modelo diz "te trago quando voltar" e o chat ficava mudo por minutos — lido do outro
  // lado como "ele terminou" (produção, 2026-10-02). A sondagem do diário começa aqui, no instante
  // da chamada, e se encerra sozinha (ver services/sdk/workflow.ts): é ela quem alimenta o painel.
  if (event.type === "tool_use" && event.name === "Workflow") startWorkflowWatch(session);
  if (event.type === "turn_absorbed") {
    // Streaming input: this send folded into the turn ALREADY running (the model absorbs it at its
    // next step) — it will not produce its own `result`, so its +1 comes back off. Floor at 1: an
    // absorbed send implies a turn IS in flight, and its own result is still owed.
    session.activeTurns = Math.max(1, session.activeTurns - 1);
  }
  // A stop the person asked for: the note goes out right AFTER this result (below), so the reader
  // sees the truncated answer and then the line explaining why it stops there.
  let interruptNoteToFlush: string | undefined;
  if (event.type === "result") {
    session.activeTurns = Math.max(0, session.activeTurns - 1);
    interruptNoteToFlush = session.pendingInterruptNote;
    session.pendingInterruptNote = undefined;
    // The last turn in flight CLOSED: the durable "turn in flight" marker comes off. A deploy that
    // lands after this point interrupts nothing — no marker, no boot-resume (see ./inflight.ts).
    if (session.activeTurns === 0) void clearInflightMarker(session.cardId);
    maybeScheduleIdleStop(session);
  }
  let silenced = false;
  if (event.type === "rewound") {
    // One answer, one edit: the oldest unanswered one. `ok: false` consumes its entry too (the
    // driver fell back to a supersede — there is nothing to cut, but that edit IS answered).
    const edit = session.rewinds.shift();
    if (event.ok && edit) {
      // A REWIND means the CLEAN text went to the model — not the supersede wrapper this edit was
      // registered with. The transcript will carry those words, and the mirror only drops a line
      // it recognises as the driver's own: without this key it republished the corrected message
      // as if the terminal had just said it, drawing a SECOND bubble under the corrected one.
      if (edit.text !== "") noteDriverEventFor(session.cardId, { type: "user", text: edit.text });
      // A nota do corte ("…a resposta acima ficou pela metade") perde o assunto: o rebobinar
      // APAGOU essa meia resposta. Quase sempre ela já saiu antes daqui — o `endStream` do driver
      // ESPERA o `result` do stream morrendo antes de anunciar o rebobinar, então o result (e a
      // nota com ele) vem primeiro, e quem a tira é o corte do log (`dropOrphanInterruptNotes`).
      // Isto cobre a outra janela: o stream que não solta dentro do prazo do `endStream`, e o
      // `rewound` chega na frente — evita escrever uma linha que já nasceria órfã. Dentro do `if`
      // do dono, como o corte: um frame que não pertence a edição nenhuma não apaga a nota de uma
      // parada que foi de outra pessoa.
      session.pendingInterruptNote = undefined;
      void rewindHistory(session.cardId, edit.original, edit.text).then((dropped) => {
        logger.info(
          { audit: true, action: "sdk.rewind", card: session.label, dropped },
          "the conversation was rewound to before an edited message",
        );
      });
    } else if (event.ok) {
      // Um `ok: true` SEM dono (driver repetindo, frame atrasado) não chega à tela: lá ele não é
      // inofensivo como aqui. `dropRewoundRows` corta da última linha "editada" até a última
      // mensagem — e uma edição RECUSADA deixa essa marca para sempre —, então um frame perdido
      // apagaria turnos inteiros que o modelo ainda tem. O log já se protege sozinho (sem dono,
      // sem corte); a tela não tem como.
      silenced = true;
      logger.warn(
        { audit: true, action: "sdk.rewind.orphan", card: session.label },
        "a rewind confirmation arrived for no edit in flight — not forwarded to the screen",
      );
    }
  }
  if (event.type === "user_question") session.ownQuestions.add(event.id);
  if (!silenced) broadcast(session, event);
  if (interruptNoteToFlush) emitSystemNote(session, interruptNoteToFlush);
  // History + mirror dedupe are MANAGER duties, not socket duties: they must keep happening while
  // no page is open — that is the whole point of the detach.
  noteDriverEventFor(session.cardId, event);
  if (replayableHistoryEvent(event)) void appendHistory(session.cardId, { ...event, at: Date.now() });
}

/**
 * Onde a sessão ATUAL deste card guarda as rodadas de workflow e os scripts delas. Os dois caminhos
 * são do harness (`<transcriptDir>/<sessionId>/…`) e dependem do id de sessão, que só existe depois
 * do primeiro `session`/`result` — antes disso não há o que sondar. PURE (dado o estado da sessão).
 */
export function workflowDirs(session: Pick<DriverSession, "transcriptDir" | "lastSessionId">): { runs: string; scripts: string } | null {
  const dir = session.transcriptDir;
  const sessionId = session.lastSessionId;
  if (!dir || !sessionId) return null;
  const base = `${dir.replace(/\/+$/, "")}/${sessionId}`;
  return { runs: `${base}/subagents/workflows`, scripts: `${base}/workflows/scripts` };
}

/** Liga a sondagem da frota deste card (idempotente — ver `watchCardWorkflows`). */
function startWorkflowWatch(session: DriverSession): void {
  watchCardWorkflows(session.cardId, {
    label: session.label,
    dirs: () => workflowDirs(session),
    watchers: () => session.sockets.size,
    publish: (run) => broadcast(session, { type: "workflow_progress", ...run }),
  });
}

/* ------------------------------------------------------------------- API */

export interface EnsureDriverOpts {
  cardId: string;
  /** Log label (the card's worktree slug). */
  label: string;
  /** The spawn command (built by the route via `sdkDriverCommand` + `resumeTargetFor`). */
  command: { file: string; args: string[] };
  /** The card's transcript dir in the runner — where a workflow's journal lives (optional). */
  transcriptDir?: string;
}

/**
 * The card's ONE driver: returns the live session, or spawns it. Spawning is synchronous, so two
 * simultaneous connects cannot race a second driver into existence.
 */
export function ensureDriverSession(opts: EnsureDriverOpts): DriverSession {
  const existing = sessions.get(opts.cardId);
  if (existing && !existing.closed) return existing;

  const child = spawner(opts.command.file, opts.command.args);
  const session: DriverSession = {
    cardId: opts.cardId,
    label: opts.label,
    child,
    sockets: new Set(),
    ready: false,
    activeTurns: 0,
    rewinds: [],
    idleTimer: null,
    stderrTail: "",
    closed: false,
    acceptedCids: new Map(),
    ownQuestions: new Set(),
    settledOrphans: new Set(),
    answeringOrphans: new Set(),
    orphansSwept: false,
    ...(opts.transcriptDir ? { transcriptDir: opts.transcriptDir } : {}),
  };
  sessions.set(opts.cardId, session);
  // Conversa que entrou pela aba Terminal: a corrente aberta do driver está num ponto que já não é o
  // fim do arquivo. Seguir dela órfã o turno do terminal, e turno órfão não tem ponto de volta — era
  // por isso que editar aquela mensagem não rebobinava. O driver só MARCA; religa no próximo envio.
  session.offOutside = onOutsideTurn(opts.cardId, () => { writeToDriver(session, { type: "reanchor" }); });
  logger.info({ card: opts.label }, "sdk driver spawned (card-owned, survives the page)");

  // Whole lines only, multibyte characters intact, linear in the line's size (see createLineReader).
  const readLines = createLineReader();
  child.stdout.on("data", (chunk: Buffer) => {
    for (const line of readLines(chunk)) {
      const event = parseDriverLine(line);
      if (event) handleDriverEvent(session, event);
    }
  });
  // EPIPE on the way IN: the child (or the docker exec carrying it) is gone. Without this the
  // error surfaced as an unhandled 'error' event at best and as silence at worst — and the next
  // message was written into the same dead pipe.
  child.stdin.on("error", (err: Error) => {
    logger.warn({ card: opts.label, detail: err.message }, "sdk driver stdin died");
    broadcast(session, { type: "error", message: `driver input closed: ${err.message}` });
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    // KEEP the tail, don't just debug-log it: in the original incident the driver died with its
    // stderr invisible (debug level) and its exit frame sent to an already-closed socket — a fully
    // SILENT death. The tail is the post-mortem the exit handler below reports.
    const text = chunk.toString();
    session.stderrTail = (session.stderrTail + text).slice(-STDERR_TAIL_MAX);
    // O driver fala por `[sdk-driver] …` quando ENGOLE alguma coisa de propósito (um erro de
    // stream que era teardown nosso, um diagnóstico interno do CLI). Engolir em nível `debug` é
    // invisível em produção — exatamente o ponto cego do incidente da morte silenciosa —, então
    // essas linhas sobem para `warn`. O resto do stderr segue sendo ruído de boot.
    const deliberate = text.includes("[sdk-driver] ");
    const log = deliberate ? logger.warn.bind(logger) : logger.debug.bind(logger);
    log({ card: opts.label, stderr: text.slice(0, 500) }, "sdk driver stderr");
  });
  child.on("error", (err) => {
    logger.warn({ card: opts.label, detail: err.message }, "sdk driver process error");
    broadcast(session, { type: "error", message: `driver process error: ${err.message}` });
  });
  child.on("close", (code) => {
    // The driver died (idle stop, killCardSession, a crash): tell whoever is watching and close
    // their sockets — the front's reconnect loop spawns the successor on its next connect.
    const deliberate = session.closed; // stopCardDriver stamped it BEFORE killing
    clearIdleTimer(session);
    session.closed = true;
    if (sessions.get(opts.cardId) === session) sessions.delete(opts.cardId);
    // O estado POR CARD só é deste driver enquanto nenhum sucessor assumiu o card. Um `close` pode
    // chegar segundos depois do `stopCardDriver` (o docker exec demora a morrer), quando a troca de
    // modelo ou o reconnect já subiu o driver seguinte — e apagar agora seria apagar o DELE.
    const succeeded = sessions.has(opts.cardId);
    // A memória de dedupe é do DRIVER: ele acabou, ela acaba junto — o sucessor fala do zero.
    if (!succeeded) forgetDriverKeys(opts.cardId);
    // A inscrição no espelho também: deixada de pé, ela escreveria no stdin de um driver morto.
    session.offOutside?.();
    delete session.offOutside;
    // A sondagem da frota também: ela publica NESTA sessão. Deixada de pé, ela ainda recusaria ser
    // substituída pela do driver seguinte (a segunda chamada só estende a primeira).
    if (!succeeded) forgetCardWorkflows(opts.cardId);
    const stderrNote = session.stderrTail.trim() === "" ? "" : ` — stderr: ${session.stderrTail.trim().slice(-400)}`;
    broadcast(session, { type: "error", message: `driver exited (code ${code ?? "?"})${stderrNote}` });
    for (const socket of session.sockets) {
      try { socket.close(); } catch { /* already closed */ }
    }
    session.sockets.clear();
    // A death nobody asked for is NEVER silent: warn with the exit code, the stderr tail and
    // whether a turn was running — the log line that was missing from the incident.
    if (deliberate && (code === 0 || code === null)) {
      logger.debug({ card: opts.label, code }, "sdk driver exited");
    } else {
      logger.warn(
        {
          audit: true,
          action: "sdk.driver.exit",
          card: opts.label,
          code,
          deliberate,
          turnsInFlight: session.activeTurns,
          stderr: session.stderrTail.trim().slice(-STDERR_TAIL_MAX) || undefined,
        },
        "sdk driver exited unexpectedly",
      );
    }
  });
  return session;
}

/**
 * Can this session still TAKE a turn? A driver that died (killed by a hibernate, a crash, an idle
 * stop) leaves a session object whose stdin is closed — and `write()` on it throws asynchronously,
 * which is exactly how a message used to disappear: written nowhere, persisted anyway, answered
 * never. Checked BEFORE anything is recorded.
 */
function canAcceptTurn(session: DriverSession): boolean {
  // `== null` on purpose: a live child reports `exitCode: null`, and a stub/stream that never
  // defines it must read as alive — only an actual exit code means gone.
  const exited = session.child.exitCode != null;
  return !session.closed && !exited && session.child.stdin.writable !== false;
}

/** Push one line into the driver's stdin. Returns false when the pipe refused it. */
function writeToDriver(session: DriverSession, control: DriverControl): boolean {
  try {
    session.child.stdin.write(encodeControl(control));
    return true;
  } catch (err) {
    logger.warn({ card: session.label, detail: (err as Error).message }, "sdk driver stdin refused a control frame");
    return false;
  }
}

/**
 * The card is ALIVE because a person is talking to it — here, not in the terminal.
 *
 * `humanActiveAt` used to be stamped only by keystrokes on the tmux websocket, so a card whose
 * whole conversation happened in the native chat looked untouched to the idle sweep, which
 * hibernated it (killing this very driver) minutes after it was opened. Stamping it here is what
 * makes "estou conversando com esse card" a sign of life the sweep can see (see
 * `lastActivityAt`/`cardsToHibernate` in services/board/workspace.ts).
 */
function noteChatActivity(session: DriverSession): void {
  void registry.markCardHumanActive(session.cardId).catch(() => { /* best effort, never fails a send */ });
}

/**
 * ONE client frame (raw text from a websocket — live or buffered while the route was still setting
 * the connection up) funneled into the card's driver. A user message is a TURN: it goes to the
 * driver's stdin AS a user message (never converted, never wrapped), the turn count and the durable
 * in-flight marker (see ./inflight.ts) both move, and the history gets the line with its sender.
 *
 * Returns the frame's VERDICT so the caller can answer the browser (see `ClientFrameOutcome`): a
 * turn is only ever reported `accepted` when it is both in the driver's stdin and on its way to
 * disk — never because a `write()` did not happen to throw.
 */
export function handleClientFrame(session: DriverSession, raw: string, origin?: MessageOrigin): ClientFrameOutcome {
  const control = parseSdkClientFrame(raw);
  if (!control) return { kind: "ignored" };
  if (control.type === "user" || control.type === "edit_user") {
    // UM RECIBO JÁ EMITIDO NÃO É UMA MENSAGEM NOVA — e vem ANTES de olhar para o driver, porque o
    // recibo fala de DURABILIDADE, não de intenção: a mensagem está gravada, e isso segue verdade
    // com o driver morto. Recusá-la aqui faria a bolha pedir uma terceira cópia de algo que o
    // servidor tem. O "Reenviar" repete o mesmo `cid` de propósito: o que se perdeu foi o recibo.
    const known = control.cid ? session.acceptedCids.get(control.cid) : undefined;
    if (known) return { kind: "accepted", cid: control.cid, persisted: chargeReceipt(session, known) };
    // The driver is GONE: refuse out loud instead of writing into a closed pipe. Nothing is
    // persisted and no turn is counted, so the browser's copy is the only one — it keeps the words
    // and resends onto the successor driver (the socket's close is already on its way).
    if (!canAcceptTurn(session)) {
      logger.warn(
        { audit: true, action: "sdk.send.refused", card: session.label },
        "a chat message arrived for a driver that is no longer running — refused (the browser keeps it)",
      );
      return { kind: "refused", cid: control.cid, reason: "driver-gone" };
    }
  }
  if (control.type === "edit_user") {
    // A SUPERSEDE: the model already read the original, so the edit goes to the driver as one more
    // NORMAL user turn wearing the supersede wrapper (the driver knows no edit_user control). The
    // history gets the truth in two lines — the marker that greys the original out, and the new
    // message with its CLEAN text (`sent` keeps the wrapped words, the transcript dedupe key).
    const wrapped = buildSupersedeText(control.original, control.text);
    // The DRIVER decides between the two shapes of an edit, because only it knows whether a rewind
    // is safe (see `rewindAndSend` in sdk-driver.mjs): `text` is what the model reads when the
    // conversation can be taken back to before the original, `fallback` the supersede used when it
    // cannot. Either way the edit reaches the model — the choice is never "nothing happens".
    if (!writeToDriver(session, { type: "edit_user", original: control.original, text: control.text, fallback: wrapped })) {
      return { kind: "refused", cid: control.cid, reason: "driver-gone" };
    }
    // Which message a `rewound: ok` will cut the log back to, and which words went in its place.
    // Enqueued BEFORE the driver can answer, and in send order — the answers come back in the same
    // order, one per edit.
    session.rewinds.push({ original: control.original, text: control.text });
    session.activeTurns += 1;
    clearIdleTimer(session);
    noteChatActivity(session);
    // The transcript will carry the WRAPPED words — that is what the mirror must not re-emit.
    noteDriverEventFor(session.cardId, { type: "user", text: wrapped });
    const at = Date.now();
    void appendHistory(session.cardId, { type: "message_edited", originalText: control.original, at });
    const line: HistoryEvent = { type: "user", text: control.text, sent: wrapped, at, from: origin };
    const persisted = appendHistoryReported(session.cardId, line);
    // Same durable in-flight promise a plain user turn earns (see #64's boot sweep).
    void writeInflightMarker(session.cardId, { startedAt: at, preview: inflightPreview(control.text), attempts: 0 });
    rememberCid(session, control.cid, { persisted, line });
    void settleOrphanQuestions(session);
    return { kind: "accepted", cid: control.cid, persisted };
  }
  if (control.type === "user") {
    if (!writeToDriver(session, control)) return { kind: "refused", cid: control.cid, reason: "driver-gone" };
    session.activeTurns += 1;
    clearIdleTimer(session);
    noteChatActivity(session);
    noteDriverEventFor(session.cardId, control);
    const line: HistoryEvent = { type: "user", text: control.text, at: Date.now(), from: origin };
    const persisted = appendHistoryReported(session.cardId, line);
    // The durable "turn in flight" record: if a deploy kills the back (and this driver with it)
    // before the result arrives, the boot sweep finds this marker and the turn is not silently
    // lost. attempts: 0 — a person's own turn always earns one automatic resume.
    void writeInflightMarker(session.cardId, { startedAt: Date.now(), preview: inflightPreview(control.text), attempts: 0 });
    rememberCid(session, control.cid, { persisted, line });
    void settleOrphanQuestions(session);
    return { kind: "accepted", cid: control.cid, persisted };
  }
  if (control.type === "question_answer" && !session.ownQuestions.has(control.id)) {
    // ÓRFÃ: este driver nunca fez esta pergunta. Repassá-la devolvia "no pending question with id"
    // e a resposta se perdia — ela vira mensagem (ver `answerOrphanQuestion`).
    void answerOrphanQuestion(session, control);
    return { kind: "ignored" };
  }
  writeToDriver(session, control);
  if (control.type === "interrupt") {
    // Streaming input: every send is already in the CLI, and the interrupt aborts the running
    // turn — at most ONE result is still owed. (A send queued CLI-side in the last instant can
    // survive the interrupt and run; its extra result is absorbed by the floor-at-zero above.)
    // Clamping here keeps an abandoned backlog from pinning the driver past the idle stop forever.
    session.activeTurns = Math.min(session.activeTurns, 1);
    // Only a stop that actually CUT something gets narrated — a stop click with nothing running
    // would otherwise write a note claiming a turn was interrupted when none was.
    if (session.activeTurns > 0) session.pendingInterruptNote = interruptNote(control);
  }
  return { kind: "ignored" };
}

/**
 * O que o histórico ainda mostra como pergunta PENDENTE e que o driver atual não espera — os
 * cartões órfãos, com o texto deles. Lido do disco: depois de um deploy o back novo não tem outra
 * memória deles, e o cartão que a tela redesenha vem exatamente daqui.
 */
async function orphanQuestions(session: DriverSession): Promise<Map<string, UserQuestionItem[]>> {
  const open = new Map<string, UserQuestionItem[]>();
  for (const event of await readHistory(session.cardId, HISTORY_REPLAY_LIMIT, { strict: true })) {
    if (event.type === "user_question") open.set(event.id, event.questions);
    else if (event.type === "question_result") open.delete(event.id);
  }
  for (const id of [...open.keys()]) {
    if (session.ownQuestions.has(id)) open.delete(id);
  }
  return open;
}

/** Encerra um cartão em todas as abas e no histórico (o F5 lê a mesma coisa). */
function settleQuestionCard(session: DriverSession, result: Extract<DriverEvent, { type: "question_result" }>): void {
  broadcast(session, result);
  void appendHistory(session.cardId, { ...result, at: Date.now() });
}

/**
 * FALAR É RESPONDER, também para a órfã. Com o driver vivo, uma mensagem libera o cartão que ele
 * espera (`supersedePendingQuestions` no driver). A órfã não tem driver para isso: ficava pendente
 * no histórico e a bandeja voltava a pedir uma resposta que a pessoa acabara de dar.
 */
async function settleOrphanQuestions(session: DriverSession): Promise<void> {
  if (session.orphansSwept) return;
  session.orphansSwept = true;
  let orphans: Map<string, UserQuestionItem[]>;
  try {
    orphans = await orphanQuestions(session);
  } catch (err) {
    session.orphansSwept = false; // a próxima mensagem tenta de novo
    logger.warn({ card: session.label, detail: (err as Error).message }, "could not sweep orphaned question cards");
    return;
  }
  for (const id of orphans.keys()) {
    if (session.settledOrphans.has(id) || session.answeringOrphans.has(id)) continue;
    session.settledOrphans.add(id);
    settleQuestionCard(session, { type: "question_result", id, superseded: true });
  }
}

/**
 * O CLIQUE NUMA ÓRFÃ (produção, 2026-10-07): o deploy matou o driver com o cartão de pé; o driver
 * novo retomou a conversa sem a chamada de ferramenta que a resposta deveria completar. As escolhas
 * ainda importam — elas vão ao modelo como MENSAGEM, cada pergunta citada ao lado do escolhido, e o
 * cartão se encerra como respondido. É um turno: conta, desarma o ocioso e ganha o marcador.
 */
async function answerOrphanQuestion(session: DriverSession, control: QuestionAnswerControl): Promise<void> {
  // Marcada ANTES de qualquer await: o segundo clique (outra aba, duplo clique) chega no meio da
  // leitura do disco e precisa encontrar a vaga já tomada.
  if (session.answeringOrphans.has(control.id)) return; // a mesma resposta já está a caminho
  if (session.settledOrphans.has(control.id)) {
    // Encerrada aqui mesmo (por mensagem, ou por outra resposta): o veredito de sempre.
    broadcast(session, { type: "error", message: `no pending question with id ${control.id}` });
    return;
  }
  session.answeringOrphans.add(control.id);
  const release = (message: string): void => {
    session.answeringOrphans.delete(control.id);
    broadcast(session, { type: "error", message });
  };
  let orphans: Map<string, UserQuestionItem[]>;
  try {
    orphans = await orphanQuestions(session);
  } catch (err) {
    release(`could not read the question card: ${(err as Error).message}`);
    return;
  }
  const questions = orphans.get(control.id);
  if (!questions) {
    // Não está pendente no disco: já encerrada (aba velha) ou nunca existiu. Nada vai ao modelo —
    // o mesmo veredito que o driver dava antes.
    release(`no pending question with id ${control.id}`);
    return;
  }
  if (!canAcceptTurn(session)) {
    // Sem driver não há a quem entregar: a tela é avisada e o cartão segue pendente para o próximo.
    release("driver exited before the answer reached it — answer again once the chat reconnects");
    return;
  }
  const text = buildOrphanAnswerText(questions, control.answers);
  if (!writeToDriver(session, { type: "user", text })) {
    release("driver exited before the answer reached it — answer again once the chat reconnects");
    return;
  }
  session.activeTurns += 1;
  clearIdleTimer(session);
  noteChatActivity(session);
  noteDriverEventFor(session.cardId, { type: "user", text });
  void writeInflightMarker(session.cardId, { startedAt: Date.now(), preview: inflightPreview(text), attempts: 0 });
  session.answeringOrphans.delete(control.id);
  session.settledOrphans.add(control.id);
  settleQuestionCard(session, { type: "question_result", id: control.id, answers: control.answers, sent: text });
  logger.info(
    { audit: true, action: "sdk.question.orphan", card: session.label },
    "an answer to a question whose driver died was delivered as a message",
  );
}

/**
 * A COBRANÇA DE UM RECIBO (o mesmo `cid` de novo): a promessa que o primeiro envio ganhou — e, se a
 * gravação dele FALHOU, uma nova tentativa de gravar a mesma linha. O driver já leu a mensagem, então
 * ela nunca volta ao stdin; só o histórico estava devendo. Sem a nova tentativa, um disco cheio por
 * um instante deixava a bolha "não entregue" para sempre: cada Reenviar ganhava o mesmo `false`, e
 * Descartar + digitar de novo fazia o modelo executar a instrução duas vezes. A promessa guardada é
 * TROCADA pela nova antes de devolver, então dois reenvios seguidos encadeiam — a linha é gravada
 * uma vez só.
 */
function chargeReceipt(session: DriverSession, sent: AcceptedSend): Promise<boolean> {
  sent.persisted = sent.persisted.then((onDisk) => onDisk || appendHistoryReported(session.cardId, sent.line));
  return sent.persisted;
}

/**
 * A turn injected by the BACKEND itself (the boot-resume after a deploy killed a turn in flight):
 * same stdin path and same turn accounting as a person's message — the driver receives a NORMAL
 * user turn — but the history line carries system provenance (it must never read as the person's
 * own words) and the in-flight marker carries the attempt count that stops a resume loop.
 */
export function injectSystemTurn(session: DriverSession, text: string, origin: MessageOrigin, attempts: number): void {
  try { session.child.stdin.write(encodeControl({ type: "user", text })); } catch { /* driver gone; close will fire */ }
  session.activeTurns += 1;
  clearIdleTimer(session);
  noteDriverEventFor(session.cardId, { type: "user", text });
  void appendHistory(session.cardId, { type: "user", text, at: Date.now(), from: origin });
  void writeInflightMarker(session.cardId, { startedAt: Date.now(), preview: inflightPreview(text), attempts });
}

/**
 * The RECEIPT a frame earns, sent back to the socket that sent it.
 *
 * `user_ack` means the message is in the card's history on disk — the thing an F5 reads back — so
 * the browser may finally forget its own copy. `user_nack` means the back did NOT take it, and is
 * the browser's cue to keep the words and resend them onto the next driver. A frame with no `cid`
 * (an older client) gets no receipt and behaves exactly as before.
 */
export function replyFrameOutcome(socket: WebSocket, outcome: ClientFrameOutcome): void {
  if (outcome.kind === "ignored" || !outcome.cid) return;
  const cid = outcome.cid;
  const send = (frame: object): void => {
    try { socket.send(JSON.stringify(frame)); } catch { /* going away; the browser resends on reconnect */ }
  };
  if (outcome.kind === "refused") {
    send({ type: "user_nack", cid, reason: outcome.reason });
    return;
  }
  // AFTER the append: the ack promises durability, not intention. A write that FAILED (a full
  // disk) is no ack — the driver has the words, the history does not, and an F5 would lose them: the
  // browser keeps its copy. Its resend carries the same `cid`, so it never becomes a second turn: it
  // retries the history write and earns THAT verdict (see `chargeReceipt`).
  void outcome.persisted.then((onDisk) => {
    send(onDisk ? { type: "user_ack", cid } : { type: "user_nack", cid, reason: "history-write-failed" });
  });
}

/**
 * Attach one websocket to the card's live driver: events fan out to it, its controls funnel in.
 * `origin` is who types on THIS socket — stamped on the messages it persists. Detaching (socket
 * close/error) never touches the driver; it only arms the idle stop when nothing else holds it.
 */
export function attachSocket(session: DriverSession, socket: WebSocket, origin?: MessageOrigin): void {
  // A socket that is no longer OPEN already fired (or is about to fire) its `close` — before the
  // listener below exists. Attached, it would never be detached: `sockets` never empties, the idle
  // stop never arms, `isCardChatInUse` vetoes the hibernation forever and the ping interval leaks.
  // The route checks this after its own awaits; this is the manager's own guard on its invariant.
  if (socket.readyState !== WebSocket.OPEN) {
    maybeScheduleIdleStop(session);
    return;
  }
  disableNagle(socket);
  clearIdleTimer(session);
  session.sockets.add(socket);

  // The reconnect case: the driver said `ready` long ago (it only says it at boot). Without a
  // synthesized one the fresh page would never enable its composer. `turnActive` carries the
  // manager's REAL state: a view remounting mid-turn (Terminal↔Chat, reload)
  // reset its own turn flag and nothing re-lit the "Trabalhando…" spinner until much later.
  if (session.ready) {
    try {
      socket.send(JSON.stringify({ type: "ready", resume: session.lastSessionId, turnActive: session.activeTurns > 0 }));
    } catch { /* going away */ }
  }

  // The "/" menu is state, not conversation: it is not in the replayed history, and the driver
  // only announces it once per boot. Without this, a page opened on a card whose driver is already
  // up had no command list until the next turn's `init` — an empty menu on a session full of skills.
  if (session.catalog) {
    try { socket.send(JSON.stringify(session.catalog)); } catch { /* going away */ }
  }

  // A frota do workflow é da mesma natureza do catálogo: estado, não conversa. Ela não está no
  // histórico replayado, e uma aba que abre no meio de uma rodada (ou logo depois dela) precisa
  // desenhar o painel no primeiro quadro — senão a tela volta a dizer, por 4 segundos ou para
  // sempre, que não há nada acontecendo.
  for (const run of lastWorkflowRuns(session.cardId)) {
    try { socket.send(JSON.stringify({ type: "workflow_progress", ...run })); } catch { /* going away */ }
  }

  const keepalive = setInterval(() => {
    try { socket.ping?.(); } catch { /* the close handler cleans up */ }
  }, KEEPALIVE_MS);

  // "ESTÁ DIGITANDO": who types on THIS socket, relayed to the card's OTHER sockets only — the
  // sender knows it is typing. Ephemeral by design: no driver write, no history line, no state
  // beyond these two locals. An unattributed socket has no name to show, so it announces nothing.
  let typingOn = false;
  let typingRelayedAt = 0;
  const relayTyping = (active: boolean): void => {
    if (!origin) return;
    const frame = JSON.stringify({ type: "peer_typing", name: origin.name, active });
    for (const other of session.sockets) {
      if (other === socket) continue;
      try { other.send(frame); } catch { /* that socket is going away */ }
    }
  };
  const noteTyping = (active: boolean): void => {
    if (active) {
      const now = Date.now();
      // The floor holds for EVERY "digitando", not only a repeat: a "parou" in between must not
      // reopen the window, or a true/false loop would fan out every frame it sends.
      if (now - typingRelayedAt < TYPING_RELAY_MIN_MS) return;
      typingOn = true;
      typingRelayedAt = now;
      relayTyping(true);
      return;
    }
    if (!typingOn) return;
    typingOn = false;
    relayTyping(false);
  };

  socket.on("message", (raw: Buffer) => {
    const text = raw.toString();
    const typing = parseTypingFrame(text);
    if (typing !== null) {
      noteTyping(typing);
      return;
    }
    const outcome = handleClientFrame(session, text, origin);
    // The message is out: whoever wrote it stopped typing — even if the front's own "parou" is lost.
    if (outcome.kind === "accepted") noteTyping(false);
    replyFrameOutcome(socket, outcome);
  });

  const detach = (): void => {
    clearInterval(keepalive);
    session.sockets.delete(socket);
    // A tab closed mid-sentence must not leave "Cesar está digitando…" on everyone else's screen.
    noteTyping(false);
    if (session.sockets.size === 0) maybeScheduleIdleStop(session);
  };
  socket.on("close", detach);
  socket.on("error", detach);
}

/**
 * Stop a card's driver NOW (pause, hibernate, restart, delete, model/account switch, idle).
 * stdin first — EOF is the driver's own exit signal (`rl.on("close") → exit 0`), and it reaches
 * across the docker exec — then kill the local client. Best-effort and idempotent.
 */
export function stopCardDriver(cardId: string): void {
  const session = sessions.get(cardId);
  if (!session) return;
  sessions.delete(cardId);
  clearIdleTimer(session);
  session.closed = true;
  try { session.child.stdin.end(); } catch { /* already gone */ }
  try { session.child.kill(); } catch { /* already gone */ }
  // A DELIBERATE stop (pause, hibernate, restart, delete, model switch, idle) abandons the turn on
  // purpose — the marker comes off so the next boot does not "resume" something a person ended.
  void clearInflightMarker(cardId);
  // A sondagem da frota é filha deste driver: sem ele não há a quem publicar nem sessão para ler.
  forgetCardWorkflows(cardId);
  logger.debug({ card: session.label }, "sdk driver stopped");
}

/**
 * Best-effort goodbye on the BACK's own shutdown (SIGTERM from a deploy): end every driver's stdin
 * (EOF is the driver's exit signal, it reaches across the docker exec) and kill the local clients —
 * but KEEP the in-flight markers: they are exactly what tells the next boot which turns this
 * shutdown interrupted (see ./resume.ts). Synchronous and non-blocking — docker stop gives seconds,
 * not promises.
 */
export function shutdownAllDrivers(): void {
  for (const session of sessions.values()) {
    clearIdleTimer(session);
    session.closed = true;
    try { session.child.stdin.end(); } catch { /* already gone */ }
    try { session.child.kill(); } catch { /* already gone */ }
    if (session.activeTurns > 0) {
      logger.warn(
        { audit: true, action: "sdk.driver.shutdown", card: session.label, turnsInFlight: session.activeTurns },
        "sdk driver shut down with a turn in flight — marker kept for the boot resume",
      );
    }
  }
  sessions.clear();
}

// Every path that ends a card's terminal (pause, hibernate, restart, delete, model/account
// switch) goes through killCardSession — the driver dies with it.
onCardSessionKill((cardId) => stopCardDriver(cardId));

// …and the reverse rule: a card whose native chat is IN USE (a page connected, or a turn running)
// must not be hibernated — hibernating is one of those kill paths, and killing the driver under a
// live conversation is precisely how a message got written into a dead pipe and answered by
// nobody. Close the page and the driver idles out on its own; the card is hibernatable again.
onCardInUseProbe((cardId) => isCardChatInUse(cardId));

// …e a terceira: QUEM responde por este card. A sondagem do tmux não enxerga o driver (ele é filho
// do back, não do painel do tmux), então sem isto a visão de sessão lia o card como "Claude saiu" —
// o banner "Claude parou" por cima de uma conversa que estava respondendo.
onCardDriverProbe((cardId) => driverActivity(cardId));
