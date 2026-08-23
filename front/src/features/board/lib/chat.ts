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

/** Which pane the card opens in. */
export type CardViewMode = "terminal" | "chat";

const MODE_PREFIX = "vibehub.cardMode.";

/**
 * The choice is stored PER CARD and PER DEVICE (localStorage is already both), which is the point:
 * a phone can live in chat while the desktop stays on the terminal, and neither has to be told
 * about the other. A card nobody has switched opens on the terminal — the mode that can do
 * everything, including the interactive prompts the transcript cannot show.
 */
export function readCardMode(cardId: string, fallback: CardViewMode = "terminal"): CardViewMode {
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
