/**
 * THE OUTBOX — the messages this browser sent and the server has not confirmed yet.
 *
 * The bug this closes (production, 2026-09-17): the native chat drew the message as "sent"
 * because `socket.send()` did not complain. But `readyState === OPEN` is not delivery: a
 * half-open socket (the connection died without FIN — VPN dropping, proxy letting go, the back
 * restarting) accepts `send()` and throws the bytes into the void, and the browser only notices
 * minutes or hours later. The screen kept spinning "Pensando…" forever and, on F5, the message
 * simply did not exist — the server never saw it, and its only copy was the React state the F5
 * wiped.
 *
 * Now every message is born here, on disk (localStorage, per card), BEFORE going to the socket, and
 * only leaves when the back answers `user_ack` — which the back only sends after storing it in the
 * history. A `user_nack` (the back refused: the card's driver had died; or the driver received it
 * but the history write failed, `reason: "history-write-failed"` — an F5 would lose it, so the copy
 * stays, and the resend with the same `cid` and the same driver up only redoes the write and gets
 * its `user_ack`, never a second turn) or a silence that lasts too long (`OUTBOX_ACK_TIMEOUT_MS`)
 * leave the bubble marked as UNDELIVERED, with resend/discard — and the
 * text stays on screen, recoverable, even after reloading the page or switching machines
 * (in that case, the machine that sent it is the one keeping the draft). And the screen does not
 * wait for the click: it resends on its own, spaced out and bounded (`planAutoResend`).
 *
 * Everything here is pure or trivially fakeable: the rules are tests, not screenshots.
 */

import { normalizeMessage, parseOrigin, type MessageOrigin } from "@/features/board/lib/chat";

/** A message sent by this browser and still without a receipt from the server. */
export interface OutboxMessage {
  /** The receipt id (`cid` in the protocol) — what `user_ack`/`user_nack` quotes back. */
  cid: string;
  /** The text as the person wrote it (what the bubble shows and the resend repeats). */
  text: string;
  /** When it left here (epoch ms) — the clock of the receipt timeout. */
  at: number;
  /** A correction of an already-sent message carries the original (the back's supersede). */
  original?: string;
  /** …and says whether it was the FIRST message of the conversation (see `EditUserControl.first` on the back). */
  first?: boolean;
  /**
   * It has already been declared UNDELIVERED (the back refused, or the receipt deadline expired).
   *
   * The entry stays in the queue — it is the recoverable copy the "resend/discard" bubble uses — but
   * the verdict has already been given ONCE: without this mark, the message would stay overdue
   * forever and the watchdog would drop the socket on every tick, second after second (the
   * "Iniciando o agente…" loop of 2026-09-17). A resend clears the mark and the clock runs again.
   */
  undelivered?: boolean;
  /**
   * WHO wrote it. The copy lives in the browser, not in the account: if the tab switches accounts
   * before the receipt, the bubble redrawn on reconnect still belongs to whoever wrote it — without
   * this it showed up as "mine" for the new account (the F5 bug, 2026-10-06).
   */
  from?: MessageOrigin;
  /**
   * How many messages with THIS text the server already had stored AFTER `since` when this one
   * left (without `since`: in the whole conversation) — see `sendMark`.
   *
   * The reconciliation matches by text against the replay, and the replay brings the whole
   * conversation that fits in the window — a "sim" from yesterday counted today's "sim" (lost in a
   * half-open socket) as delivered, and it vanished silently. With the count, only an occurrence
   * BEYOND the ones that already existed proves delivery. Entries stored before this field do not
   * have it and match as before (against any occurrence).
   */
  seenBefore?: number;
  /**
   * The ANCHOR of the count: the `at` (SERVER clock) of the newest message the screen knew when this
   * one left. Only occurrences stored after it count, on both sides — see `sendMark`.
   */
  since?: number;
  /**
   * It NEVER left this browser (a wait from another account's queue, see `foreignToOutbox`): there is
   * no delivery to recognize, and the same text in the replay is from another person or another
   * moment. Only a real Reenviar (`retryOutbox`) turns it into a send.
   */
  unsent?: boolean;
  /**
   * How many AUTOMATIC resends this message has already used up (see `planAutoResend`). Goes to disk
   * with it: an F5 in the middle of the plan does not give the attempts back, or every reload would
   * restart the count.
   */
  autoRetries?: number;
  /**
   * When the person wrote it (or resent it by hand) — the clock of the automatic resend's age
   * ceiling. `at` does not work: every resend rearms it. Without the field (stored before it, or
   * still on the first send), `at` applies, which until the first resend is the same time.
   */
  writtenAt?: number;
  /**
   * The PERSON ASKED for the Reenviar at a moment when there was no wire to carry it (the doomed
   * socket still closing, the reconnection in backoff, the server in setup). The request does not
   * become an error: the message goes out at the dispatch's first open gate, without waiting for an
   * interval or looking at the automatic plan — whoever asked was a human (see `askResend`).
   */
  asked?: boolean;
  /**
   * When the request was made — the clock of its age ceiling. A field of its own because `writtenAt`
   * is the ORDER of the conversation: rewriting it sent the older requested one after the newer one.
   */
  askedAt?: number;
}

/**
 * A message the server HAS, as the reconciliation reads it: the text and when IT stored it.
 *
 * `at` is the history timestamp the replay carries. It is missing on a send from this connection
 * confirmed by `user_ack` (the receipt carries no time) and in history stored before the timestamp
 * existed.
 */
export interface ServerText {
  text: string;
  at?: number;
}

/** What a send carries with it so the reconciliation can recognize it later. */
export type SendMark = Pick<OutboxMessage, "since" | "seenBefore">;

/**
 * How long a message can go without a receipt before the screen admits it does not know.
 *
 * Generous enough for a slow disk write and a bad network, short enough that the person does not
 * waste minutes staring at a lying spinner. Once the deadline passes the message is NOT discarded:
 * it is relabeled, and the socket is reconnected (that is the way to find out it died).
 */
export const OUTBOX_ACK_TIMEOUT_MS = 12_000;

const OUTBOX_PREFIX = "vibehub.sdkOutbox.";

/** One receipt id per send. `rand` is injectable so the test is deterministic. PURE. */
export function newCid(now: number = Date.now(), rand: () => number = Math.random): string {
  return `${now.toString(36)}-${Math.floor(rand() * 1e9).toString(36)}`;
}

/** Never throws: a blocked localStorage just means "no durability in this session". */
export function readOutbox(cardId: string): OutboxMessage[] {
  try {
    const raw = localStorage.getItem(OUTBOX_PREFIX + cardId);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (m): m is OutboxMessage =>
        Boolean(m) &&
        typeof (m as OutboxMessage).cid === "string" &&
        typeof (m as OutboxMessage).text === "string",
    ).map((m) => ({
      ...m,
      at: typeof m.at === "number" ? m.at : Date.now(),
      // localStorage is untrusted input: a malformed author becomes "no author", never garbage.
      from: parseOrigin(m.from),
      seenBefore: typeof m.seenBefore === "number" && m.seenBefore >= 0 ? m.seenBefore : undefined,
      first: m.first === true ? true : undefined,
      since: typeof m.since === "number" && Number.isFinite(m.since) ? m.since : undefined,
      unsent: m.unsent === true ? true : undefined,
      autoRetries: Number.isInteger(m.autoRetries) && (m.autoRetries as number) >= 0 ? m.autoRetries : undefined,
      writtenAt: typeof m.writtenAt === "number" && Number.isFinite(m.writtenAt) ? m.writtenAt : undefined,
      asked: m.asked === true ? true : undefined,
      askedAt: typeof m.askedAt === "number" && Number.isFinite(m.askedAt) ? m.askedAt : undefined,
    }));
  } catch {
    return [];
  }
}

export function writeOutbox(cardId: string, messages: readonly OutboxMessage[]): void {
  try {
    if (messages.length === 0) localStorage.removeItem(OUTBOX_PREFIX + cardId);
    else localStorage.setItem(OUTBOX_PREFIX + cardId, JSON.stringify(messages));
  } catch {
    /* the bubble still holds for this screen */
  }
}

/** Appends (or replaces, on a resend with the same cid) a message. PURE. */
export function addToOutbox(messages: readonly OutboxMessage[], message: OutboxMessage): OutboxMessage[] {
  return [...messages.filter((m) => m.cid !== message.cid), message];
}

/** Takes a message out of the outbox — it is stored on the server (or the person discarded it). PURE. */
export function dropFromOutbox(messages: readonly OutboxMessage[], cid: string): OutboxMessage[] {
  return messages.filter((m) => m.cid !== cid);
}

/**
 * The messages whose receipt did not arrive within the deadline AND that have not been claimed yet.
 *
 * `undelivered` is what makes the claim UNIQUE: the overdue message does not leave the queue (the
 * person can still resend it), so without the mark it would stay overdue on every tick — and the
 * watchdog drops the socket on every claim. That was the "chat → Iniciando o agente… → whole
 * history → chat" loop every second.
 *
 * `answerableSince` is the clock's FLOOR: the instant the connection became able to answer (the
 * server's `ready`). The deadline is an accusation — "I sent it and nobody answered" — and it only
 * holds if someone was in a position to answer. The browser's `onopen` fires on the websocket
 * handshake, but the back only starts SERVING frames after a setup of several seconds (driver
 * install over SSH+docker, transcript probe with a 15s timeout — alone longer than this deadline
 * —, history replay, driver spawn); until then the frame waits buffered and is delivered AFTERWARDS.
 * Counting that time against the message is what marked as "não entregue" what the server received,
 * and made the "Reenviar" send the second copy (production, 2026-09-28). PURE.
 */
export function overdueMessages(
  messages: readonly OutboxMessage[],
  now: number,
  timeoutMs: number = OUTBOX_ACK_TIMEOUT_MS,
  answerableSince: number = 0,
): OutboxMessage[] {
  return messages.filter((m) => !m.undelivered && now - Math.max(m.at, answerableSince) >= timeoutMs);
}

/** Declares the given messages undelivered — the verdict is out, it is not claimed again. PURE. */
export function markUndelivered(
  messages: readonly OutboxMessage[],
  cids: readonly string[],
): OutboxMessage[] {
  const wanted = new Set(cids);
  let changed = false;
  const next = messages.map((m) => {
    if (!wanted.has(m.cid) || m.undelivered === true) return m;
    changed = true;
    return { ...m, undelivered: true };
  });
  return changed ? next : (messages as OutboxMessage[]);
}

/**
 * A resend: same words, same receipt, clock reset and the previous verdict erased.
 *
 * And the MARK redone against the current screen (`mark`, see `sendMark`): this is the send the next
 * reconciliation needs to recognize, and the conversation has moved on since the first — including
 * the case of a wait from another account (`unsent`), which only now actually goes out.
 *
 * `auto` says WHO resent. The automatic one uses up an attempt of the plan and keeps the time the
 * message was written (the age ceiling keeps counting from it). The click is the person saying again
 * "I want this": it resets the attempts and the age, and if this send also fails the plan restarts. PURE.
 */
export function retryOutbox(
  messages: readonly OutboxMessage[],
  entry: OutboxMessage,
  now: number,
  mark: SendMark,
  auto = false,
): OutboxMessage[] {
  const { unsent: _neverSent, autoRetries, writtenAt, asked: _asked, askedAt: _askedAt, ...sent } = entry;
  const plan = auto
    ? { autoRetries: (autoRetries ?? 0) + 1, writtenAt: writtenAt ?? entry.at }
    : { writtenAt: now };
  return addToOutbox(messages, { ...sent, ...mark, ...plan, at: now, undelivered: false });
}

/**
 * The Reenviar clicked WITHOUT A WIRE (production, 2026-11-06): before, it tried the socket right
 * away, got the "Sem conexão — a mensagem não foi enviada. Ela fica no campo." (false: it is in the
 * bubble) and the message stayed stuck until the automatic plan. Now the click is noted on the entry
 * itself and dispatch sends it as soon as the chat comes back, within the same age ceiling as the
 * automatic plan counted from the click (`askedAt`: the tab reopened the next day does not fire
 * yesterday's request). A new click renews the request. The ORDER does not change: `writtenAt` is
 * still when it was written. It only applies to entries still without a favorable verdict
 * (`undelivered`); an entry that no longer exists changes nothing. PURE.
 */
export function askResend(messages: readonly OutboxMessage[], cid: string, now: number): OutboxMessage[] {
  let changed = false;
  const next = messages.map((m) => {
    if (m.cid !== cid || m.undelivered !== true) return m;
    changed = true;
    return { ...m, asked: true, askedAt: now };
  });
  return changed ? next : (messages as OutboxMessage[]);
}

/**
 * The automatic resend intervals, one per attempt: the N-th resend goes out `[N]` ms after the
 * previous send. They grow on purpose — the first failure is usually a wire that came back within
 * seconds (deploy, VPN flickering, the driver restarting), and whatever fails again and again is a
 * problem hammering does not solve. Added up they give ~23 minutes of attempts over a live
 * connection; once the list runs out, the bubble goes back to being just the Reenviar.
 */
export const AUTO_RESEND_DELAYS_MS: readonly number[] = [5_000, 15_000, 45_000, 2 * 60_000, 5 * 60_000, 15 * 60_000];

/**
 * The maximum age of a message for it to go out ON ITS OWN (counted from when it was written). It
 * covers the person who sent and left with the wire down for a while; it does not cover the closed
 * tab reopened the next day — an order from yesterday ("sobe pra prod") does not become a turn
 * without the person seeing it.
 */
export const AUTO_RESEND_MAX_AGE_MS = 2 * 60 * 60_000;

/** What the automatic resend has to do now, and when to look again. */
export interface AutoResendPlan {
  /** The ones whose interval has already elapsed — they go out now, in the order they were written. */
  due: OutboxMessage[];
  /** The ones that will still go out on their own (due or not): their bubble says it will try again. */
  pending: Set<string>;
  /** The next instant the plan changes (an interval elapses, a message ages out). */
  wakeAt: number | null;
}

/**
 * THE AUTOMATIC RESEND PLAN — the Reenviar the person does not need to be there to click.
 *
 * The bug this closes (production, 2026-10-27): the message failed, the bubble stayed "não entregue"
 * with the Reenviar, and the person — who had already left — only found it the next day. The good
 * connection had come back within moments; all that was missing was someone to click.
 *
 * A message enters the plan if it has already received the verdict (`undelivered`) and left this
 * browser (`unsent` is a wait from another account: only the person decides). Each one has two
 * fences, and neither depends on the connection being good — that is what prevents the loop that
 * the single verdict (`markUndelivered`) exists to prevent:
 * - counted ATTEMPTS (`AUTO_RESEND_DELAYS_MS`), spaced further and further apart;
 * - AGE (`AUTO_RESEND_MAX_AGE_MS`), from when it was written.
 * The interval counts from the previous send (`at`). Whether it can be sent NOW (wire up, server
 * ready, turn with room, message from whoever is in the tab) is decided by the screen; here only the
 * when. PURE.
 */
export function planAutoResend(messages: readonly OutboxMessage[], now: number): AutoResendPlan {
  const due: OutboxMessage[] = [];
  const pending = new Set<string>();
  let wakeAt: number | null = null;
  const wake = (t: number): void => {
    if (t > now && (wakeAt === null || t < wakeAt)) wakeAt = t;
  };
  for (const m of messages) {
    if (m.undelivered !== true) continue;
    // The person's request: goes out now, with no interval or attempt ceiling (see `askResend`).
    if (m.asked === true) {
      const expires = (m.askedAt ?? m.writtenAt ?? m.at) + AUTO_RESEND_MAX_AGE_MS;
      if (now >= expires) continue;
      pending.add(m.cid);
      due.push(m);
      wake(expires);
      continue;
    }
    if (m.unsent === true) continue;
    const delay = AUTO_RESEND_DELAYS_MS[m.autoRetries ?? 0];
    if (delay === undefined) continue;
    const expires = (m.writtenAt ?? m.at) + AUTO_RESEND_MAX_AGE_MS;
    if (now >= expires) continue;
    pending.add(m.cid);
    const at = m.at + delay;
    if (at <= now) due.push(m);
    else wake(at);
    wake(expires);
  }
  due.sort((a, b) => (a.writtenAt ?? a.at) - (b.writtenAt ?? b.at));
  return { due, pending, wakeAt };
}

/**
 * The MARK of a send: what the server already had with these words, at the instant they go out.
 *
 * The replay is a WINDOW (the end of the history, `HISTORY_REPLAY_LIMIT` events on the back) and it
 * moves: counting the occurrences on the whole screen gave 6 "ok" on the send against 3 in the
 * reconnect replay — the old ones had left the window — and the delivered message came back "não
 * entregue", with a Reenviar that duplicated the turn. So the count is ANCHORED on the server clock:
 * `since` is the newest `at` the screen knew, and `seenBefore` counts only what comes after it —
 * what, in the next replay, will have `at > since`. The window always discards the OLDEST, so this
 * survives it (unless it moves more than the whole window between the send and the reconnect: then
 * the delivery comes out as "não entregue", on screen with resend — the error on the side that does
 * not lose words).
 *
 * After the anchor, on screen, there can only be sends from this connection already confirmed
 * (`user_ack` carries no time): they count, because they come back in the replay stamped after it.
 * With no `at` on screen (old history, or empty conversation) there is no anchor, and everything is
 * counted, as it always was. PURE.
 */
export function sendMark(known: readonly ServerText[], text: string): SendMark {
  let since: number | undefined;
  let anchor = -1;
  known.forEach((m, i) => {
    if (typeof m.at === "number" && (since === undefined || m.at >= since)) {
      since = m.at;
      anchor = i;
    }
  });
  const key = normalizeMessage(text);
  const seenBefore = known.reduce(
    (n, m, i) => (i > anchor && m.at === undefined && normalizeMessage(m.text) === key ? n + 1 : n),
    0,
  );
  return { since, seenBefore };
}

/**
 * RECONCILIATION on reconnect: the server's replay is the truth about what was stored.
 *
 * Each outbox entry falls on one of two sides: `delivered` (the replay has a message with the same
 * text — it was the receipt that got lost, not the message) or `missing` (the server does not have
 * it: it is a message that died on the way and the person needs to see it marked, with the text
 * intact).
 *
 * The matching is by TEXT because that is what the replay carries: the `cid` is a connection
 * receipt, not a message id, and a stored message comes back from disk without it. Each replay line
 * matches at most one entry, so sending the same text twice does not "deliver" both for free.
 *
 * And the entry only matches an occurrence LATER than the ones that already existed when it left
 * (the mark from `sendMark`): of the occurrences stored after `since` — all of them, with no anchor
 * —, the first `seenBefore` already existed, and only one beyond them can be this message. An entry
 * that never left this browser (`unsent`) matches nothing: it is always `missing`. PURE.
 */
export function reconcileOutbox(
  sent: readonly ServerText[],
  messages: readonly OutboxMessage[],
): { delivered: OutboxMessage[]; missing: OutboxMessage[] } {
  const keys = sent.map((m) => normalizeMessage(m.text));
  /** The replay lines that have already matched some entry (each one proves ONE delivery). */
  const claimed = new Set<number>();
  const delivered: OutboxMessage[] = [];
  const missing: OutboxMessage[] = [];
  for (const message of messages) {
    const match = message.unsent === true ? -1 : deliveryOf(message, sent, keys, claimed);
    if (match < 0) {
      missing.push(message);
      continue;
    }
    claimed.add(match);
    delivered.push(message);
  }
  return { delivered, missing };
}

/** The replay line that proves the delivery of `message`, or -1 — see `reconcileOutbox`. PURE. */
function deliveryOf(
  message: OutboxMessage,
  sent: readonly ServerText[],
  keys: readonly string[],
  claimed: ReadonlySet<number>,
): number {
  const key = normalizeMessage(message.text);
  if (key === "") return -1;
  const { since } = message;
  let before = message.seenBefore ?? 0;
  for (let i = 0; i < sent.length; i += 1) {
    if (keys[i] !== key) continue;
    // With an anchor, only what the server stored after it — what the window never discards first.
    const at = sent[i]!.at;
    if (since !== undefined && !(at !== undefined && at > since)) continue;
    if (before > 0) {
      before -= 1; // already existed when the message left: it is not this one
      continue;
    }
    if (!claimed.has(i)) return i;
  }
  return -1;
}
