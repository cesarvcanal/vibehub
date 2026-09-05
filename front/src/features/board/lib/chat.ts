/**
 * The chat view's state rules, kept out of the component so they can be reasoned about (and tested)
 * without a websocket or a DOM.
 *
 * The stream is not a queue of new things: it REPLAYS. Every connect opens with the last turns, a
 * reconnect after a blip replays them again, and a new session file replays from its start. So the
 * client's job is idempotent merge by id, not append — which is also what lets an optimistic bubble
 * disappear the moment the real message lands.
 */

export type ChatEventKind = "user" | "assistant" | "tool" | "system";

/**
 * WHO put a message into this card — the server-recorded provenance (see
 * back/src/services/chat/provenance.ts). `agent` = another card's AI (the green robot bubble,
 * linked back to its card); `owner`/`user` = a person, by username. Absent = unattributed, drawn
 * as the reader's own message (the pre-provenance behaviour).
 */
export interface MessageOrigin {
  kind: "owner" | "user" | "agent" | "system";
  name: string;
  sourceCardId?: string;
  sourceProjectId?: string;
}

/** Validates a frame's `from` field. Anything malformed reads as "no provenance", never as junk. PURE. */
export function parseOrigin(value: unknown): MessageOrigin | undefined {
  if (!value || typeof value !== "object") return undefined;
  const o = value as Partial<MessageOrigin>;
  if (o.kind !== "owner" && o.kind !== "user" && o.kind !== "agent" && o.kind !== "system") return undefined;
  if (typeof o.name !== "string") return undefined;
  return {
    kind: o.kind,
    name: o.name,
    sourceCardId: typeof o.sourceCardId === "string" ? o.sourceCardId : undefined,
    sourceProjectId: typeof o.sourceProjectId === "string" ? o.sourceProjectId : undefined,
  };
}

/**
 * How a message bubble should read for THIS viewer: their own (unlabelled, as always), another
 * card's agent (robot + card name), or another person (name, no robot). A person's own messages
 * are "self" wherever they typed them; an unattributed message defaults to "self" because that is
 * what every message was before provenance existed. PURE.
 */
export function originRole(from: MessageOrigin | undefined, viewer: string | undefined): "self" | "agent" | "user" | "system" {
  if (!from) return "self";
  if (from.kind === "agent") return "agent";
  // The panel's own injected turn (the boot-resume continuation): NEVER "self", whatever the
  // viewer's name is — it must not read as something the person typed.
  if (from.kind === "system") return "system";
  return viewer !== undefined && from.name === viewer ? "self" : "user";
}

export interface ChatEvent {
  id: string;
  kind: ChatEventKind;
  /** Epoch ms, 0 when the transcript line carried no timestamp. */
  at: number;
  text: string;
  /** Tool name, on `tool` events only. */
  tool?: string;
  /** Message provenance, on `user` events the server could attribute. */
  from?: MessageOrigin;
}

/** One frame from the chat socket, or null when it is not an event (the heartbeat, junk). PURE. */
export function parseChatFrame(raw: string): ChatEvent | null {
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== "object") return null;
  const e = obj as Partial<ChatEvent>;
  if (typeof e.id !== "string" || typeof e.text !== "string") return null;
  if (e.kind !== "user" && e.kind !== "assistant" && e.kind !== "tool" && e.kind !== "system") return null;
  return {
    id: e.id,
    kind: e.kind,
    at: typeof e.at === "number" ? e.at : 0,
    text: e.text,
    tool: e.tool,
    from: parseOrigin(e.from),
  };
}

/**
 * Merges an event into the list: new ones append, known ones are ignored.
 *
 * The list is NOT re-sorted by timestamp. The transcript is already in order, and re-sorting would
 * shuffle the several events that share one millisecond (a message and its two tool calls) on every
 * single frame. PURE — it returns the same array when nothing changed, so React can skip the render.
 */
export function mergeEvent(events: ChatEvent[], event: ChatEvent): ChatEvent[] {
  if (events.some((e) => e.id === event.id)) return events;
  return [...events, event];
}

/* --------------------------------------------------------------- grouping */

/** One thing the chat draws: a message, or a run of tool calls folded into one block. */
export type ChatRow =
  | { kind: "event"; id: string; event: ChatEvent }
  | { kind: "tools"; id: string; events: ChatEvent[] };

/**
 * How many consecutive tool calls it takes before they are worth folding.
 *
 * Two is not a wall of noise; three is where a turn starts to read as a build log. Below the
 * threshold the calls stay as plain lines, because a fold that hides one `Read` is a click that
 * buys nothing.
 */
export const TOOL_FOLD_MIN = 3;

/**
 * Turns the event list into ROWS, folding runs of consecutive tool calls.
 *
 * An agent's turn is mostly tools — a dozen `Read`s, a `Grep`, four `Edit`s — and rendered one line
 * each they push the thing you actually came to read (what it SAID) off the screen. Folding them
 * keeps the conversation legible without hiding anything: the block says how many and expands in
 * place.
 *
 * The block's id is the id of its FIRST call, so a group that grows while the turn runs keeps its
 * identity — and stays open if you opened it. PURE.
 */
export function groupChatRows(events: readonly ChatEvent[], min: number = TOOL_FOLD_MIN): ChatRow[] {
  const rows: ChatRow[] = [];
  let run: ChatEvent[] = [];

  const flush = (): void => {
    if (run.length === 0) return;
    if (run.length >= Math.max(2, min)) {
      rows.push({ kind: "tools", id: run[0]!.id, events: run });
    } else {
      for (const e of run) rows.push({ kind: "event", id: e.id, event: e });
    }
    run = [];
  };

  for (const event of events) {
    if (event.kind === "tool") {
      run.push(event);
      continue;
    }
    flush();
    rows.push({ kind: "event", id: event.id, event });
  }
  flush();
  return rows;
}

/** Which pane the card opens in. */
export type CardViewMode = "terminal" | "chat";

const MODE_PREFIX = "vibehub.cardMode.";

/**
 * The choice is stored PER CARD and PER DEVICE (localStorage is already both), which is the point:
 * a phone can live in chat while the desktop stays on the terminal, and neither has to be told
 * about the other.
 *
 * A card nobody has switched opens in CHAT. That is the reading view — one event per message
 * instead of a repainting screen — and it is what opening a card is usually for: seeing what the
 * agent said and answering it. The terminal is one click away and takes over the moment you need
 * what only it can do (a permission prompt, plan approval, `/login`), and that choice is then
 * remembered for this card.
 */
export function readCardMode(cardId: string, fallback: CardViewMode = "chat"): CardViewMode {
  try {
    const raw = localStorage.getItem(MODE_PREFIX + cardId);
    return raw === "chat" || raw === "terminal" ? raw : fallback;
  } catch {
    return fallback; // private mode, or storage disabled
  }
}

export function writeCardMode(cardId: string, mode: CardViewMode): void {
  try {
    localStorage.setItem(MODE_PREFIX + cardId, mode);
  } catch {
    /* the choice still holds for this screen */
  }
}

/** One message the person sent that has not yet come back in the transcript. */
export interface PendingMessage {
  id: string;
  text: string;
  /** When it was sent — what tells a moment's "enviando" apart from a bubble stuck forever. */
  at: number;
}

/**
 * After this long with no transcript echo the bubble stops claiming "enviando" and says so —
 * offering resend/discard instead of spinning forever. Long enough for a busy Claude to drain its
 * input queue in the common case; the message is NOT dropped at the deadline, only re-labelled.
 */
export const PENDING_TIMEOUT_MS = 2 * 60_000;

/** What a pending bubble is: still plausibly on its way, or overdue and owed an honest label. PURE. */
export function pendingPhase(pending: Pick<PendingMessage, "at">, now: number): "sending" | "unconfirmed" {
  return now - pending.at >= PENDING_TIMEOUT_MS ? "unconfirmed" : "sending";
}

/**
 * The transcript's echo is matched by TEXT (it carries no client id), and the echo is not always
 * byte-identical — Claude Code may re-flow whitespace. Comparing the collapsed form keeps a
 * delivered message from haunting the screen as a forever-pending bubble. PURE.
 */
export function normalizeMessage(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

const PENDING_PREFIX = "vibehub.chatPending.";

/**
 * Messages you sent that have not appeared in the transcript yet — kept PER CARD in localStorage so
 * they SURVIVE the thing that used to lose them: a tab switch (terminal↔chat), a pane remount, a
 * reload. Send a message while Claude is busy and Claude Code queues it internally (not in the
 * transcript yet); the optimistic bubble used to be React state, so leaving the chat erased it and
 * the message "vanished" even though it was safe in the queue. Now it stays on screen until it comes
 * back for real. Never throws — a blocked/absent store just means no persistence this session.
 */
export function readPending(cardId: string): PendingMessage[] {
  try {
    const raw = localStorage.getItem(PENDING_PREFIX + cardId);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (p): p is PendingMessage =>
          Boolean(p) && typeof (p as PendingMessage).id === "string" && typeof (p as PendingMessage).text === "string",
      )
      // Entries written before `at` existed start their clock NOW: they become "unconfirmed" after
      // one timeout instead of spinning as "enviando" until the end of time.
      .map((p) => (typeof p.at === "number" ? p : { ...p, at: Date.now() }));
  } catch {
    return [];
  }
}

export function writePending(cardId: string, pending: PendingMessage[]): void {
  try {
    if (pending.length === 0) localStorage.removeItem(PENDING_PREFIX + cardId);
    else localStorage.setItem(PENDING_PREFIX + cardId, JSON.stringify(pending));
  } catch {
    /* the bubbles still hold for this screen */
  }
}
