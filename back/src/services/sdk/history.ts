import { appendFile, mkdir, open, readdir, readFile, rm, type FileHandle } from "node:fs/promises";
import { EventEmitter } from "node:events";
import { basename, dirname, join } from "node:path";
import { dataPath } from "../../config/env.js";
import { NOTE_TURN_INTERRUPTED, NOTE_TURN_INTERRUPTED_EDIT, type DriverEvent } from "./protocol.js";
import type { AgentTaskEvent, ToolResultEvent } from "./toolResult.js";
import type { MessageOrigin } from "../chat/provenance.js";
import { logger } from "../../utils/logger.js";
import { isAtomicWriteTmp, writeFileAtomic } from "../../store/atomicWrite.js";
import { CARD_ID_RE } from "../board/cardId.js";

/**
 * SDK CHAT HISTORY — the per-card event log that makes the native chat's conversation SURVIVE.
 *
 * The `--resume` session id preserves the conversation FOR THE MODEL, but the UI used to hold its
 * rows only in React state: switching to the terminal tab and back, reopening the card, or a page
 * reload remounted the view and the whole conversation vanished from the screen (the production
 * bug on the "teste chat nativo sdk" card — the message was delivered, the transcript proves it,
 * and the screen forgot it anyway). This is the same promise the OLD chat already keeps via the
 * tmux transcript: what was said is on disk, and every connect REPLAYS it.
 *
 * One NDJSON file per card under `<dataDir>/sdk-history/`, append-only on the hot path. Only the
 * events worth re-drawing are kept (see `replayableHistoryEvent`): the consolidated text, never the
 * deltas; the request AND the decision of a permission, so a replayed card shows its outcome. A
 * tool call's input is kept with its long texts capped (`capToolInput`): the log is the screen's
 * memory, the whole input lives in the transcript.
 */

/** Where the logs live, under the data dir (survives container restarts like board.json does). */
export const SDK_HISTORY_DIR = "sdk-history";

/** How many events one connect replays. Enough for several long turns without a mega-frame burst. */
export const HISTORY_REPLAY_LIMIT = 500;

/** Compaction threshold: when a file holds this many times the replay limit, it is rewritten. */
export const HISTORY_COMPACT_FACTOR = 4;

/**
 * Size threshold (characters of the file): past it, a log is compacted even below the count one.
 * Counting events alone let a few dozen huge lines (inputs written before `capToolInput`) grow to
 * tens of megabytes that every read parses in one go, blocking the event loop for everyone.
 */
export const HISTORY_COMPACT_SIZE = 4_000_000;

/**
 * What the log stores: driver events, plus the user's own messages (they come from stdin, not
 * stdout). `from` is the message's PROVENANCE — who put it into this card: another person's chat
 * send, or another card's agent (`vibehub_send_to_terminal`). Absent on the card owner's own
 * messages and on everything written before this field existed; the replay carries it verbatim, so
 * the native chat's attribution is exact, never matched.
 */
export type HistoryEvent = (
  | DriverEvent
  | {
      type: "user";
      text: string;
      /**
       * On an EDITED message's new version: the text as it was EXPECTED to go to the driver's
       * stdin (the supersede wrapper, see protocol.ts `buildSupersedeText`). `text` stays the
       * CLEAN version — what the screen draws — while `sent` is what the transcript will carry, so
       * the replay dedupe (`replayDedupeKey`) matches the transcript line instead of drawing it
       * twice. Written before the driver chooses between the two shapes of an edit: when it
       * REWINDS, the clean text is what went, and `rewindHistory` deletes this field.
       */
      sent?: string;
    }
  /** The user edited a sent message: the row whose text matches `originalText` is drawn "editada". */
  | { type: "message_edited"; originalText: string; /** The FIRST copy was edited, not the newest. */ first?: boolean }
  | {
      type: "system_note";
      text: string;
      /**
       * Na nota de um reinício que deixou um cartão de pergunta aberto: o que rodava em segundo plano
       * e morreu junto. Vai ao modelo com a resposta do cartão (`buildOrphanAnswerText`).
       */
      lostBackground?: string[];
    }
  /**
   * One turn of a VOICE call held inside this chat (see services/voice/turns.ts): what the person
   * said, or what the voice assistant answered, already settled into a whole turn by the browser.
   * `vid` is the browser's id for the turn — the idempotency key (a retried save never doubles it).
   */
  | { type: "voice_turn"; vid: string; role: "user" | "assistant"; text: string }
  | ToolResultEvent
  | AgentTaskEvent
) & {
  at?: number;
  from?: MessageOrigin;
  /** The event was MIRRORED from the card's terminal (TUI) transcript, not spoken by the driver. */
  source?: "terminal";
  /** The transcript event id a mirrored event came from — the exact dedupe key on replay. */
  tid?: string;
};

function historyFile(cardId: string): string {
  if (!CARD_ID_RE.test(cardId)) throw new Error(`invalid card id for sdk history: '${cardId}'`);
  return dataPath(SDK_HISTORY_DIR, `${cardId}.ndjson`);
}

/**
 * Which events are worth writing down and replaying. Deltas are not (the consolidated
 * `assistant_text` replaces them), and neither is the connection's own chatter (ready/session) nor
 * transient errors — a replayed "driver exited" from last week would just be a lie. `permission`
 * only when it carries the id that pairs it with a request, so the replay can settle the card. PURE.
 */
export function replayableHistoryEvent(event: HistoryEvent): boolean {
  switch (event.type) {
    case "user":
    case "assistant_text":
    case "tool_use":
    case "permission_request":
    // The panel's own voice in the conversation ("o turno foi interrompido por uma atualização…"):
    // written by the backend, never by the driver — and worth re-drawing on every replay.
    case "system_note":
    case "user_question":
    case "question_result":
    // The edit marker: without it a replay would draw the superseded message as if it still stood.
    case "message_edited":
    // A spoken turn of a voice call held in this chat: the call ends, the conversation stays.
    case "voice_turn":
      return true;
    // O /btw: a resposta carrega a pergunta — é a ÚNICA linha dele no log (a pergunta não entra
    // como `user`, nem aqui nem no contexto do modelo). Só a que RESPONDEU: uma falha passageira
    // (fila cheia, prazo) redesenhada em todo F5 seria um aviso eterno de algo que já passou.
    case "btw_answer":
      return typeof (event as { text?: unknown }).text === "string";
    // A compactação: o DESFECHO é o divisor da conversa ("antes disto, só o resumo") e vale em todo
    // F5. O início não — uma barra replayada de semana passada rodaria para sempre; a compactação
    // em andamento chega a quem conecta pelo estado da sessão (ver `connect` em ./manager.ts).
    case "compaction":
      return (event as { phase?: unknown }).phase === "done" || (event as { phase?: unknown }).phase === "failed";
    // O resumo do resultado (a linha "7 linhas" / "erro: …"): só do agente PRINCIPAL. O dos
    // subagentes é muito (centenas por frota) e empurraria a conversa para fora da janela do
    // replay — a linha do tempo de um subagente vem do transcript (./detail.ts).
    case "tool_result":
      return !(event as { parentToolUseId?: unknown }).parentToolUseId && "toolResult" in event;
    // O FIM de um subagente (concluído, falhou, parado), para o card dele assentar depois do F5.
    case "agent_task":
      return (event as { status?: unknown }).status !== "running";
    case "permission":
      return typeof (event as { id?: unknown }).id === "string";
    default:
      return false;
  }
}

/**
 * Ceiling of each TEXT inside a stored `tool_use` input. The tool_result was already capped, but the
 * call went in whole — the `content` of every Write, both sides of every Edit — and twenty 500 KB
 * Writes made a 10 MB log that every turn's end re-parsed. 20k characters keeps what the screen
 * draws from it intact: the Workflow plan is read from the script's first 20k, a diff card shows at
 * most 200 lines, a Write its first 40. The whole input stays in the transcript (./detail.ts).
 */
export const TOOL_INPUT_TEXT_MAX = 20_000;

/** Room kept under the ceiling for the marker, so a capped text is never capped again. */
const TRUNCATION_MARK_ROOM = 40;

/**
 * The input with every string longer than `TOOL_INPUT_TEXT_MAX` cut, ending in a visible
 * "… [+N chars]" with what was left out. Only string LEAVES: keys, arrays, numbers and booleans stay
 * as they were, so whoever reads a field (file_path, todos, the question's options) finds it where
 * it was. Idempotent — a capped text fits under the ceiling. PURE.
 */
export function capToolInput(input: unknown): unknown {
  if (typeof input === "string") {
    if (input.length <= TOOL_INPUT_TEXT_MAX) return input;
    let cut = TOOL_INPUT_TEXT_MAX - TRUNCATION_MARK_ROOM;
    // A cut between the two halves of a surrogate pair leaves a broken character behind it.
    const code = input.charCodeAt(cut - 1);
    if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
    return `${input.slice(0, cut)}\n… [+${input.length - cut} chars]`;
  }
  if (Array.isArray(input)) return input.map(capToolInput);
  if (input && typeof input === "object") {
    return Object.fromEntries(Object.entries(input).map(([key, value]) => [key, capToolInput(value)]));
  }
  return input;
}

/** The event as the log keeps it: a `tool_use` with its input capped, anything else as it came. PURE. */
function storedEvent(event: HistoryEvent): HistoryEvent {
  return event.type === "tool_use" ? { ...event, input: capToolInput(event.input) } : event;
}

/**
 * Appends are SERIALIZED per card: the bridge fires them without awaiting (an event stream must not
 * block on the disk), and two interleaved appendFile calls could still interleave their lines.
 */
const chains = new Map<string, Promise<void>>();

/**
 * Append one event to a card's log and REPORT whether it reached the disk: `true` once the line is
 * written, `false` when the write failed (logged here). Never rejects, so it is as fire-and-forget
 * safe as `appendHistory` — but a RECEIPT has to be built on this form: `user_ack` promises the
 * message is ON DISK, and a full disk used to earn an ack anyway. The browser dropped its own copy,
 * and the message was gone on the next F5.
 */
export function appendHistoryReported(cardId: string, event: HistoryEvent): Promise<boolean> {
  let written = false;
  const prev = chains.get(cardId) ?? Promise.resolve();
  const next = prev
    .then(async () => {
      const file = historyFile(cardId);
      await mkdir(join(file, ".."), { recursive: true });
      await appendFile(file, `${JSON.stringify(storedEvent(event))}\n`, "utf8");
      written = true;
    })
    .catch((err: unknown) => {
      logger.warn({ card: cardId, detail: (err as Error).message }, "could not append sdk chat history");
    })
    .finally(() => {
      if (chains.get(cardId) === next) chains.delete(cardId);
    });
  chains.set(cardId, next);
  return next.then(() => written);
}

/**
 * Resolves once every append queued so far for this card has landed (or failed) — what a read that
 * must SEE the latest lines waits on. Never rejects: the chain swallows its own failures.
 */
export function historySettled(cardId: string): Promise<void> {
  return (chains.get(cardId) ?? Promise.resolve()).then(() => undefined);
}

/** Append one event to a card's log. Fire-and-forget safe: never throws, never blocks the stream. */
export function appendHistory(cardId: string, event: HistoryEvent): Promise<void> {
  return appendHistoryReported(cardId, event).then(() => undefined);
}

/**
 * The replay window of a card, oldest first — what a fresh connect sends to the browser before the
 * driver says `ready`: the last `limit` events of the MAIN agent plus the subagents' lines among
 * them (see `replayWindow`). Reading is also when the file is COMPACTED: a log that has grown past
 * several times the replay limit, or past `HISTORY_COMPACT_SIZE`, is rewritten to just that window,
 * so the hot append path never pays for a rewrite. Never throws — no file simply means no history yet.
 *
 * `strict`: a read that FAILS (EBUSY, EMFILE…) throws instead of reading as "no history". For a
 * caller that decides something once from the answer (the orphan-question sweep), an empty list
 * born of a passing error is a wrong verdict, not a missing file.
 */
export async function readHistory(
  cardId: string,
  limit: number = HISTORY_REPLAY_LIMIT,
  opts: { strict?: boolean } = {},
): Promise<HistoryEvent[]> {
  let raw: string;
  const file = historyFile(cardId);
  try {
    raw = await readFile(file, "utf8");
  } catch (err) {
    if (opts.strict && (err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    return [];
  }
  const events = parseHistory(raw);
  const compactAbove = limit * HISTORY_COMPACT_FACTOR;
  if (events.length > compactAbove || raw.length > HISTORY_COMPACT_SIZE) {
    // Chained like an append so a compaction never races one; best-effort like everything here.
    // The rewrite RE-READS the file inside the chain: the read above ran outside it, and whatever
    // was queued in between (an answer landing while someone opens the card, a rewind already
    // applied) would be overwritten by a tail computed before it existed.
    await appendHistoryBarrier(cardId, async () => {
      const currentRaw = await readFile(file, "utf8");
      const current = parseHistory(currentRaw);
      const kept = replayWindow(current, limit).map((e) => JSON.stringify(storedEvent(e))).join("\n") + "\n";
      const tooMany = current.length > compactAbove; // false once a rewind already shrank it
      // By size, only a rewrite that shrinks the file several times over: a window that is big on
      // its own would otherwise be rewritten, whole, on every read.
      const tooBig = currentRaw.length > HISTORY_COMPACT_SIZE && kept.length * HISTORY_COMPACT_FACTOR <= currentRaw.length;
      if (!tooMany && !tooBig) return;
      await writeFileAtomic(file, kept);
    }).catch((err: unknown) => {
      // The replay below does not depend on it: a compaction that failed is retried on the next read.
      logger.warn({ card: cardId, detail: (err as Error).message }, "could not compact sdk chat history");
    });
  }
  // A log written before the input ceiling replays capped too, not as a multi-megabyte frame.
  return replayWindow(events, limit).map(storedEvent);
}

/**
 * The events a replay draws: the last `limit` of the MAIN agent and, from the first of those on, the
 * last `limit` of the subagents (the rows under each Agent card — its action count, its last action).
 *
 * Two budgets, because one shared window was the bug: a fleet writes hundreds of subagent lines in a
 * few minutes, and counted together with the conversation they pushed every message out of the
 * replay — the F5 came back with the subagents' activity and not a word of the person's. A subagent
 * line older than the main window has nothing on screen to hang under, so it goes with it. PURE.
 */
function replayWindow(events: HistoryEvent[], limit: number): HistoryEvent[] {
  const kept: HistoryEvent[] = [];
  let main = 0;
  let sub = 0;
  for (let i = events.length - 1; i >= 0 && main < limit; i -= 1) {
    const event = events[i] as HistoryEvent;
    if ((event as { parentToolUseId?: unknown }).parentToolUseId) {
      if (sub >= limit) continue;
      sub += 1;
    } else {
      main += 1;
    }
    kept.push(event);
  }
  return kept.reverse();
}

/**
 * The events in the last `bytes` of a card's log, oldest first, for a caller that only needs the END
 * of the conversation (the question a turn closed on) — `readHistory` parses the whole file. `whole`
 * says the read reached the start of the file; when it did not, finding nothing is not an answer and
 * the caller asks for more. No compaction (a read, not upkeep); a failed read throws, except the
 * missing file, which is an empty log.
 */
export async function readHistoryTail(cardId: string, bytes: number): Promise<{ events: HistoryEvent[]; whole: boolean }> {
  let handle: FileHandle;
  try {
    handle = await open(historyFile(cardId), "r");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { events: [], whole: true };
    throw err;
  }
  try {
    const { size } = await handle.stat();
    const start = Math.max(0, size - bytes);
    const { bytesRead, buffer } = await handle.read(Buffer.alloc(size - start), 0, size - start, start);
    const chunk = buffer.subarray(0, bytesRead);
    // Mid-file, the chunk opens on a piece of a line: it goes, up to the first newline. A newline
    // byte never occurs inside a multi-byte UTF-8 character, so the cut never splits one either.
    const newline = start === 0 ? -1 : chunk.indexOf(0x0a);
    const from = start === 0 ? 0 : newline === -1 ? chunk.length : newline + 1;
    return { events: parseHistory(chunk.subarray(from).toString("utf8")), whole: start === 0 };
  } finally {
    await handle.close();
  }
}

/** The log's lines as events. A torn line (a crash mid-append) is skipped, the rest kept. PURE. */
function parseHistory(raw: string): HistoryEvent[] {
  const events: HistoryEvent[] = [];
  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const parsed = JSON.parse(line) as HistoryEvent;
      if (parsed && typeof parsed === "object" && typeof parsed.type === "string") events.push(parsed);
    } catch { /* a torn line from a crash mid-append: skip it, keep the rest */ }
  }
  return events;
}

/**
 * Rewrite a card's log to match a conversation that was REWOUND.
 *
 * When an edit rewinds the session (`resumeSessionAt`), the model loses the original message, the
 * half answer it was writing and every tool that ran in between. The log has to lose them too:
 * otherwise a reload replays a conversation the model does not have, and the screen and the model
 * disagree about what was said — which is the bug the rewind existed to fix, wearing a different
 * hat.
 *
 * What is cut is exactly the middle: from the ORIGINAL message (inclusive) to the `message_edited`
 * marker (inclusive). Everything before survives untouched — it is the kept turn — and everything
 * after survives too, because that is the edit's own new message, already written by the time the
 * driver reports back.
 *
 * Conservative on purpose: if either end is missing (a compaction already dropped the original, a
 * marker that never landed) nothing is CUT. A log with a stale row is a cosmetic problem; a log
 * missing rows it should have kept is a lost conversation.
 *
 * `replacementText` is the edit's new message, and the second half of this repair: that line was
 * written with `sent` = the supersede wrapper, because when it was written nobody yet knew which
 * shape the edit would take. A rewind means the model read the CLEAN words, so the wrapper never
 * existed — and leaving it there makes `replayDedupeKey` look for words no transcript contains, so
 * the next connect replays the corrected message TWICE (once from the log, once from the
 * transcript). The repair is ANCHORED to the cut, and happens only when the cut could be placed:
 * the edit's own line is the one right after the marker, and an unanchored search would walk back
 * into an OLDER edit whose wrapper was correct — stripping it there recreates the duplicate bubble
 * on a message nobody touched.
 *
 * `first`: the edit was of the conversation's FIRST message (see `EditUserControl.first`).
 *
 * Returns how many events were dropped — 0 meaning "nothing cut". REJECTS when the log could not be
 * read or rewritten: the screen has already cut those rows, and a rewind reported as done while the
 * file kept them brought the edited-away conversation back on the next F5.
 */
export function rewindHistory(
  cardId: string,
  originalText: string,
  replacementText?: string,
  opts: { first?: boolean } = {},
): Promise<number> {
  return appendHistoryBarrier(cardId, async () => {
    const file = historyFile(cardId);
    const raw = await readLogIfAny(file);
    if (raw === null) return 0; // no log yet: nothing to rewind
    const events = parseHistory(raw);
    // The LAST occurrence of each end, because the same words can be said twice in a conversation
    // and it is the most recent pair that was just edited — unless the edit says it was the FIRST
    // message: then the cut starts at the first copy (a message re-sent after an error has the same
    // words, and the newest copy is the wrong one).
    let start = -1;
    let mark = -1;
    for (let i = 0; i < events.length; i += 1) {
      const e = events[i] as HistoryEvent;
      if (e.type === "user" && e.text === originalText && !(opts.first && start !== -1)) start = i;
      if (e.type === "message_edited" && e.originalText === originalText) mark = i;
    }
    // One end missing, or an order that cannot be: NOTHING is rewritten — not the cut, not the
    // repair. The old rule, and still the right one; the file keeps even its torn lines.
    if (start === -1 || mark === -1 || mark < start) return 0;
    const tail = dropOrphanInterruptNotes(events.slice(mark + 1));
    const unwrapped = clearSupersedeWrapper(tail, replacementText);
    const kept = [...events.slice(0, start), ...tail];
    const dropped = events.length - kept.length;
    if (dropped === 0 && !unwrapped) return 0; // a cut that removes nothing and nothing to repair
    await writeFileAtomic(file, kept.map((e) => JSON.stringify(e)).join("\n") + (kept.length ? "\n" : ""));
    return dropped;
  });
}

/**
 * The edit went to the model with its CLEAN words but nothing was rewound — the original never
 * reached the model (the driver's `not-delivered`). Nothing is cut: every row in the log still
 * happened. Only the wrapper goes, from the edit's own line: the first user line with those words
 * right after the MOST RECENT marker for `originalText`, so an older edit's correct wrapper stays.
 * Same reason as the repair in `rewindHistory` — `replayDedupeKey` matches the transcript by
 * `sent`, and a wrapper the model never got made the next connect draw the message twice.
 *
 * Returns whether the line was changed; rejects, like `rewindHistory`, when the log could not be read
 * or rewritten.
 */
export function unwrapEditedMessage(cardId: string, originalText: string, replacementText: string): Promise<boolean> {
  return appendHistoryBarrier(cardId, async () => {
    const file = historyFile(cardId);
    const raw = await readLogIfAny(file);
    if (raw === null) return false;
    const events = parseHistory(raw);
    let mark = -1;
    for (let i = 0; i < events.length; i += 1) {
      const e = events[i] as HistoryEvent;
      if (e.type === "message_edited" && e.originalText === originalText) mark = i;
    }
    if (mark === -1) return false;
    const at = events.findIndex((e, i) => i > mark && e.type === "user" && e.text === replacementText);
    const line = events[at] as (HistoryEvent & { sent?: string }) | undefined;
    if (!line || line.sent === undefined) return false;
    const { sent: _dropped, ...rest } = line;
    events[at] = rest as HistoryEvent;
    await writeFileAtomic(file, events.map((e) => JSON.stringify(e)).join("\n") + "\n");
    return true;
  });
}

/** The log's text, or null when the card has none yet. Any other read failure throws. */
async function readLogIfAny(file: string): Promise<string | null> {
  try {
    return await readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/**
 * Drops the "turno interrompido" notes left STRANDED after the cut.
 *
 * The note narrates a half answer ("a resposta acima ficou pela metade") that the rewind has just
 * erased. On the ordinary path it sits between the original and the edit's marker, so the cut
 * above already takes it. On the GRACE path it does not: when the old turn refuses to close, the
 * screen sends the edit anyway (`EDIT_INTERRUPT_GRACE_MS`), the marker and the new message are
 * written first, and only then does the aborted turn report back — the driver's own teardown
 * guarantees that order, because `endStream` WAITS for the dying stream's `result` before
 * `rewindAndSend` announces the rewind. The note therefore lands after the marker, outside the
 * cut, and a reload brought it back hanging under the corrected message with a COMPLETE answer
 * above it.
 *
 * Only these two codes, and only in the tail: everything after the marker is newer than the edit,
 * so a stop narrated there can only be the stop the rewind just undid. PURE.
 */
function dropOrphanInterruptNotes(tail: HistoryEvent[]): HistoryEvent[] {
  return tail.filter(
    (event) => !(event.type === "system_note"
      && (event.text === NOTE_TURN_INTERRUPTED || event.text === NOTE_TURN_INTERRUPTED_EDIT)),
  );
}

/**
 * Drops the `sent` wrapper from the edit's new message, in place, searching only the TAIL the cut
 * kept (everything after the marker) — the edit's own line is there, and nothing older is. The
 * LAST matching line of that tail, because the same words can be said more than once. Returns
 * whether anything changed. MUTATES the array it is given (the caller's own freshly built tail).
 */
function clearSupersedeWrapper(tail: HistoryEvent[], replacementText?: string): boolean {
  if (replacementText === undefined || replacementText === "") return false;
  for (let i = tail.length - 1; i >= 0; i -= 1) {
    const event = tail[i] as HistoryEvent & { sent?: string };
    if (event.type !== "user" || event.text !== replacementText || event.sent === undefined) continue;
    const { sent: _dropped, ...rest } = event;
    tail[i] = rest as HistoryEvent;
    return true;
  }
  return false;
}

/* -------------------------------------------------------- external events */

/**
 * Events that enter a card's conversation from OUTSIDE its own websocket — today, an agent's
 * `vibehub_send_to_terminal`. The bridge records driver/browser traffic itself, so this bus exists
 * for the one case it cannot see: the text was typed into the card's terminal by the backend, and a
 * native chat that happens to be open should draw it NOW, not on the next reconnect.
 */
const externalBus = new EventEmitter();
externalBus.setMaxListeners(0); // one listener per open native chat — not a leak, a fan-out

/** Appends an external message to the card's log AND announces it to any open native chat. */
export function publishExternalMessage(cardId: string, event: HistoryEvent): Promise<void> {
  const done = appendHistory(cardId, event);
  externalBus.emit(cardId, event);
  return done;
}

/**
 * The same, reporting whether the line reached the disk — for a caller that answers "saved" to the
 * browser (the voice turns). Announced only once written: a chat must not draw what a reload loses.
 */
export async function publishExternalMessageReported(cardId: string, event: HistoryEvent): Promise<boolean> {
  const written = await appendHistoryReported(cardId, event);
  if (written) externalBus.emit(cardId, event);
  return written;
}

/** Subscribe to a card's external messages. Returns the unsubscribe. */
export function onExternalMessage(cardId: string, listener: (event: HistoryEvent) => void): () => void {
  externalBus.on(cardId, listener);
  return () => externalBus.off(cardId, listener);
}

/**
 * Runs `work` inside the card's append chain (a rewrite must not interleave with an append) and
 * hands its outcome to the caller — a failure included, because each rewrite means something
 * different when it fails (a compaction is retried on the next read; a rewind left the screen and
 * the file disagreeing). The CHAIN itself only waits for it to settle: the appends queued behind a
 * failed rewrite still run.
 */
function appendHistoryBarrier<T>(cardId: string, work: () => Promise<T>): Promise<T> {
  const prev = chains.get(cardId) ?? Promise.resolve();
  const outcome = prev.then(work);
  const next = outcome
    .then(() => undefined, () => undefined)
    .finally(() => {
      if (chains.get(cardId) === next) chains.delete(cardId);
    });
  chains.set(cardId, next);
  return outcome;
}

/**
 * O CORTE DO /clear: apaga do log tudo o que veio ANTES da última mensagem "/clear" e mantém ela e
 * o que veio depois.
 *
 * Por que não apagar o arquivo inteiro: o /clear pode ter entrado na FILA do CLI no meio de um turno
 * longo, e a pessoa ter mandado mais coisa depois dele — mensagens que já estão no log e que o CLI
 * vai rodar na sessão nova. Apagá-las fazia a resposta aparecer sem a pergunta, e no F5 a pergunta
 * voltava atribuída ao terminal. Manter a própria linha "/clear" também é o que deixa o replay casá-la
 * com o `<command-name>/clear` que o CLI grava no transcript novo (uma bolha só, não duas).
 *
 * Sem linha "/clear" no log (o comando veio da aba Terminal, por exemplo), não há fronteira: a
 * conversa inteira é da sessão apagada e sai toda. Na mesma fila dos appends — o "/clear" ainda
 * enfileirado é escrito antes do corte. Rejeita quando o log não pôde ser lido ou reescrito.
 */
export function clearHistoryBeforeLastClear(cardId: string): Promise<void> {
  return appendHistoryBarrier(cardId, async () => {
    const file = historyFile(cardId);
    const raw = await readLogIfAny(file);
    if (raw === null) return; // no log yet: nothing to clear
    const events = parseHistory(raw);
    let from = -1;
    for (let i = 0; i < events.length; i += 1) {
      const e = events[i] as HistoryEvent;
      if (e.type === "user" && typeof e.text === "string" && isClearCommand(e.text)) from = i;
    }
    const kept = from === -1 ? [] : events.slice(from);
    if (kept.length === events.length) return;
    await writeFileAtomic(file, kept.map((e) => JSON.stringify(e)).join("\n") + (kept.length ? "\n" : ""));
  });
}

/** A mensagem É o comando /clear (não uma frase que o menciona). PURE. */
export function isClearCommand(text: string): boolean {
  return text.trim() === "/clear";
}

/**
 * DELETES a card's log — the card itself is being erased, and its conversation goes with it.
 *
 * Chained like an append (a delete must not race a line being written) and best-effort: no file is
 * the desired end state, so "already gone" is success. The in-memory chain entry is dropped with
 * it, so nothing keeps the card alive in this module.
 */
export function removeHistory(cardId: string): Promise<void> {
  return appendHistoryBarrier(cardId, async () => {
    const file = historyFile(cardId);
    await rm(file, { force: true });
    // A rewrite the deploy SIGKILLed mid-way leaves its tmp — the whole conversation — behind.
    const name = basename(file);
    const leftovers = await readdir(dirname(file)).catch(() => [] as string[]);
    for (const other of leftovers) {
      if (isAtomicWriteTmp(other, name)) await rm(join(dirname(file), other), { force: true });
    }
  });
}
