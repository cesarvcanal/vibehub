/**
 * THE QUEUE — what you wrote while Claude was still working.
 *
 * Before, a message sent in the middle of a turn went STRAIGHT to the CLI, which folded it into the
 * running turn (the driver's `turn_absorbed`): the bubble rose into the conversation right away, with
 * the label "entrou no turno em andamento", and from then on the message belonged to the model — you
 * could not fix a word, could not give up on it, and what you wrote became an addendum in the middle
 * of a line of reasoning that was already under way.
 *
 * Now it WAITS, outside the conversation, right above the text field — where Claude Code and Cursor
 * put it. While it is here it is still yours: you can edit it (it goes back to the field) and you can
 * remove it. It only RISES into the chat at the instant it is actually delivered, when the previous
 * turn ends — and then it becomes a bubble like any other, with the outbox receipt (see
 * ./sdkOutbox.ts) guaranteeing that the server stored it.
 *
 * It lives in localStorage for the same reason as the outbox: an F5 in the middle of a long turn must
 * not erase what you had already written.
 *
 * Everything here is pure or trivially fakeable — the rules are tests, not screenshots.
 */

import { originRole, parseOrigin, type MessageOrigin } from "@/features/board/lib/chat";
import type { OutboxMessage } from "@/features/board/lib/sdkOutbox";

/** A written message, not yet delivered, still editable. */
export interface QueuedMessage {
  /** Local identity of this wait — gone once the message is dispatched. */
  id: string;
  /** The text as the person wrote it. */
  text: string;
  /** When it entered the queue (epoch ms) — the order is the order of entry. */
  at: number;
  /**
   * It is IN THE FIELD, being rewritten — and therefore cannot be delivered.
   *
   * It stays in the queue, in its place: that is what keeps the durability promise (an F5 in the
   * middle of the correction gives back the original text instead of losing it) and the order
   * (cancelling the edit does not send the message to the end of the queue). Dispatch simply skips
   * whoever is here.
   */
  editing?: boolean;
  /**
   * WHO wrote it. The queue lives in the browser, not in the account: without this, a wait from the
   * previous account went out over the new account's connection after an account switch — and the
   * server stored it under the wrong name (see `foreignToOutbox`).
   */
  from?: MessageOrigin;
  /**
   * The receipt of a send that ALREADY went out and came back here (see `outboxToQueue`). Dispatched
   * with it, the message the server had after all is just the claim of the receipt (`acceptedCids` on
   * the back), never a second turn. Gone when the text is rewritten: then it is another message.
   */
  cid?: string;
}

const QUEUE_PREFIX = "vibehub.sdkQueue.";

/** One id per wait. `rand` is injectable so the test is deterministic. PURE. */
export function newQueueId(now: number = Date.now(), rand: () => number = Math.random): string {
  return `q${now.toString(36)}-${Math.floor(rand() * 1e9).toString(36)}`;
}

/** Never throws: a blocked localStorage just means "no durability in this session". */
export function readQueue(cardId: string): QueuedMessage[] {
  try {
    const raw = localStorage.getItem(QUEUE_PREFIX + cardId);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (m): m is QueuedMessage =>
          Boolean(m) &&
          typeof (m as QueuedMessage).id === "string" &&
          typeof (m as QueuedMessage).text === "string",
      )
      .map((m) => ({
        ...m,
        at: typeof m.at === "number" ? m.at : Date.now(),
        // localStorage is untrusted input: a malformed author becomes "no author", never garbage.
        from: parseOrigin(m.from),
        cid: typeof m.cid === "string" ? m.cid : undefined,
      }));
  } catch {
    return [];
  }
}

export function writeQueue(cardId: string, messages: readonly QueuedMessage[]): void {
  try {
    if (messages.length === 0) localStorage.removeItem(QUEUE_PREFIX + cardId);
    else localStorage.setItem(QUEUE_PREFIX + cardId, JSON.stringify(messages));
  } catch {
    /* the queue still holds for this screen */
  }
}

/**
 * Enters at the END of the queue — the delivery order is the order in which you wrote.
 *
 * A message coming back from an edit also enters here: it left the queue when the pencil was
 * clicked (it was in the field, being rewritten) and the one coming back is another, with the new
 * text. PURE.
 */
export function enqueue(messages: readonly QueuedMessage[], message: QueuedMessage): QueuedMessage[] {
  return [...messages.filter((m) => m.id !== message.id), message];
}

/** Takes one out of the queue — dispatched, edited (went back to the field) or discarded. PURE. */
export function dequeue(messages: readonly QueuedMessage[], id: string): QueuedMessage[] {
  return messages.filter((m) => m.id !== id);
}

/** The next to go: the first one that is not being rewritten. PURE. */
export function headOfQueue(messages: readonly QueuedMessage[]): QueuedMessage | null {
  return messages.find((m) => m.editing !== true) ?? null;
}

/** The last one you wrote — the one the up arrow opens for editing. PURE. */
export function lastQueued(messages: readonly QueuedMessage[]): QueuedMessage | null {
  const open = messages.filter((m) => m.editing !== true);
  return open.length === 0 ? null : open[open.length - 1]!;
}

/**
 * Puts ONE message in the field (and takes any other out of it): there is only one text field.
 *
 * Clicking the pencil of a second message returns the first to the queue, in its place, with the
 * text it had — what was being typed into it is lost, but the message is not. PURE.
 */
export function markEditing(messages: readonly QueuedMessage[], id: string): QueuedMessage[] {
  return messages.map((m) => {
    const editing = m.id === id;
    if ((m.editing === true) === editing) return m;
    return editing ? { ...m, editing: true } : { ...m, editing: false };
  });
}

/** Nobody is in the field: whatever was being rewritten becomes deliverable again, where it was. PURE. */
export function releaseEditing(messages: readonly QueuedMessage[]): QueuedMessage[] {
  return messages.some((m) => m.editing === true)
    ? messages.map((m) => (m.editing === true ? { ...m, editing: false } : m))
    : (messages as QueuedMessage[]);
}

/**
 * Finished rewriting: the new text takes the PLACE of the old one — same position in the queue,
 * because a correction is not a new message and cannot jump ahead of whoever came after.
 *
 * A message that is no longer in the queue (the person discarded it while editing) enters as new,
 * at the end: an Enter can never make words disappear. PURE.
 */
export function updateQueued(
  messages: readonly QueuedMessage[],
  id: string,
  text: string,
  at: number,
): QueuedMessage[] {
  if (!messages.some((m) => m.id === id)) return [...messages, { id, text, at }];
  return messages.map((m) => (m.id === id ? { ...m, text, at, editing: false, cid: undefined } : m));
}

/**
 * THE ACCOUNT SWITCH with messages waiting: what belongs to ANOTHER account cannot go out over this
 * connection (the server stamps the author from the connection, and the message would end up under
 * the name of someone who did not write it). It becomes an "undelivered" copy in the outbox — it
 * stays on screen, with the name of whoever wrote it, and can be discarded; only the account that
 * owns it can resend it. And it goes out marked `unsent`: it was never sent, so no reconciliation can
 * consider it delivered just because the same text is in the conversation — without the mark, the
 * next F5 matched it against any "ok" from the replay and it vanished.
 *
 * Without an author (stored before this version) it stays with whoever is in the tab, as it always
 * did; with no known viewer yet (`/auth/me` in flight) nothing is separated — no deciding in the
 * dark. PURE.
 */
export function foreignToOutbox(
  messages: readonly QueuedMessage[],
  viewer: string | undefined,
): { own: QueuedMessage[]; foreign: OutboxMessage[] } {
  if (viewer === undefined) return { own: [...messages], foreign: [] };
  const own: QueuedMessage[] = [];
  const foreign: OutboxMessage[] = [];
  for (const m of messages) {
    if (m.from && m.from.name !== viewer) {
      foreign.push({ cid: m.id, text: m.text, at: m.at, from: m.from, undelivered: true, unsent: true });
    } else {
      own.push(m);
    }
  }
  return { own, foreign };
}

/** Until when a lost message with no verdict goes back to the queue on its own (see `outboxToQueue`). */
export const REQUEUE_MAX_AGE_MS = 10 * 60_000;

/**
 * THE WAY BACK: a message the server does NOT have (the reconnect reconciliation reported it as
 * `missing`) and that never received a verdict goes back to the QUEUE — and dispatch delivers it when
 * the chat finishes loading, like any other wait.
 *
 * The bug this closes (production, 2026-10-20): the chat was reloading (reconnection, driver setup)
 * and the person sent a message. The frame stayed in the back's buffer, the F5 closed the socket in
 * the middle of setup and the back discarded it ("closed during setup — nothing attached"). On
 * reload it came back "não entregue ao servidor", asking for a Resend for something that only needed
 * to WAIT.
 *
 * Left out, as an "undelivered" bubble with resend/discard:
 * - one that already got a verdict (`undelivered`: refusal from the back or deadline expired on a
 *   connection that could answer) — the server failed it, and what sends it again is the automatic
 *   resend, spaced out and bounded (`planAutoResend` in ./sdkOutbox.ts), never the queue in a loop;
 * - one that never left this browser (`unsent`) or belongs to ANOTHER account — going out over this
 *   connection would store it under the wrong name. With no known viewer yet (`/auth/me` in flight)
 *   it DOES go to the queue: it is the queue that separates the ones from another account when the
 *   viewer arrives (`foreignToOutbox`), and the reconciliation runs only once — deciding "not mine"
 *   in the dark condemned it forever;
 * - the correction of an already-sent message (`original`): it is not a loose text, it is a supersede;
 * - the OLD one (`REQUEUE_MAX_AGE_MS`): it comes back marked, and what sends it is the automatic
 *   resend, only within its age ceiling (`AUTO_RESEND_MAX_AGE_MS`) — a "sobe pra prod" from three
 *   days ago, from a tab closed before the receipt, does not become a turn on its own when the card
 *   is opened: the person decides.
 * PURE.
 */
export function outboxToQueue(
  missing: readonly OutboxMessage[],
  viewer: string | undefined,
  now: number,
): { queued: QueuedMessage[]; kept: OutboxMessage[] } {
  const queued: QueuedMessage[] = [];
  const kept: OutboxMessage[] = [];
  for (const m of missing) {
    const own = viewer === undefined || originRole(m.from, viewer) === "self";
    const fresh = now - m.at < REQUEUE_MAX_AGE_MS;
    if (own && fresh && !m.undelivered && !m.unsent && m.original === undefined) {
      queued.push({ id: m.cid, cid: m.cid, text: m.text, at: m.at, ...(m.from ? { from: m.from } : {}) });
    } else {
      kept.push(m);
    }
  }
  return { queued, kept };
}
