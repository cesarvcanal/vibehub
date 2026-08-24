/**
 * The chat view's state rules, kept out of the component so they can be reasoned about (and tested)
 * without a websocket or a DOM.
 *
 * The stream is not a queue of new things: it REPLAYS. Every connect opens with the last turns, a
 * reconnect after a blip replays them again, and a new session file replays from its start. So the
 * client's job is idempotent merge by id, not append — which is also what lets an optimistic bubble
 * disappear the moment the real message lands.
 */

export type ChatEventKind = "user" | "assistant" | "tool";

export interface ChatEvent {
  id: string;
  kind: ChatEventKind;
  /** Epoch ms, 0 when the transcript line carried no timestamp. */
  at: number;
  text: string;
  /** Tool name, on `tool` events only. */
  tool?: string;
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
  if (e.kind !== "user" && e.kind !== "assistant" && e.kind !== "tool") return null;
  return { id: e.id, kind: e.kind, at: typeof e.at === "number" ? e.at : 0, text: e.text, tool: e.tool };
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
