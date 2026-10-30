import { randomUUID } from "node:crypto";
import { JsonStore } from "../../store/jsonStore.js";
import { dataPath } from "../../config/env.js";
import { visibleCards } from "../../auth/access.js";
import type { PublicUser } from "../../auth/users.js";
import { getCard, listAllCards, onCardConcluded, type Card, type CardStatus, type DeclaredState } from "../board/registry.js";
import type { DriverEvent, UserQuestionItem } from "../sdk/protocol.js";
import { logger } from "../../utils/logger.js";

/**
 * CARD EVENTS — the moments a person AWAY from the board must hear about: a card finished its turn,
 * asked them a question, waits for a permission, or declared it needs them.
 *
 * The board shows all of that on screen; an assistant driving the cards from outside (ChatGPT, often
 * by voice) only learns it when a tool answers. So the moments are recorded here, once each, on disk,
 * and read back per person — the inbox (`inboxFor`) and the "what is new since you last heard"
 * handover (`takeUndelivered`). Nothing here PUSHES by itself: an MCP server cannot start a turn of
 * an app that is not connected. The sink that does push (mcp/events.ts — a live MCP Events stream)
 * hears each new event through `onCardEvent` and replays the log with `eventsAfter`.
 *
 * Rules:
 *  - IDEMPOTENT by `id`: the caller derives it from the moment (the question's id, the permission's
 *    id), so a duplicate report is one event.
 *  - An event is OPEN until what it announced is over: the question was answered, the permission
 *    decided, the card started another turn. A newer "needs me" replaces the previous one.
 *  - WHO hears it is decided when READING, with the board's own rules (auth/access.ts), so a share
 *    taken away also takes the events away. A card someone is working (its actor) is heard only by
 *    them; a concluded or paused card by nobody.
 */

export type CardEventKind = "turn_finished" | "question" | "permission" | "needs_me" | "failed" | "concluded" | "message";

/**
 * What a MESSAGE is for. Only `question` and `approval` ask for an answer — set explicitly by the
 * agent that sends it (vibehub_notify), never guessed from the text (a "?" in an info is not a question).
 */
export type MessageType = "info" | "question" | "approval" | "error" | "done";
export const MESSAGE_TYPES: readonly MessageType[] = ["info", "question", "approval", "error", "done"];
export type Severity = "info" | "warning" | "critical";
export const SEVERITIES: readonly Severity[] = ["info", "warning", "critical"];

export interface CardEvent {
  /** Monotonic position in the log — the cursor a reader passes back as `since`. */
  seq: number;
  id: string;
  cardId: string;
  /** The card's project when it happened — what a subscription by project filters on. */
  projectId: string;
  kind: CardEventKind;
  at: number;
  /** The card's title when it happened (what the person is told; ids are not for speaking). */
  title: string;
  /** The question's or permission's own id: what resolves it. */
  refId?: string;
  questions?: UserQuestionItem[];
  tool?: string;
  reason?: string;
  /** needs_me: the declared state and its one-line summary (also on turn_finished, when declared). */
  state?: DeclaredState;
  summary?: string;
  /** message: what it is for, how urgent, the readable text and what led to it. */
  messageType?: MessageType;
  severity?: Severity;
  text?: string;
  context?: string;
  /** message: the option label the sender recommends (one of `questions[0].options`). */
  recommended?: string;
  resolvedAt?: number;
  /** An answer in flight (`claimReply`): resolved by it, reopened only by the same claim. */
  claim?: string;
}

export type CardEventInput = Omit<CardEvent, "seq" | "at" | "title" | "projectId" | "resolvedAt" | "claim"> & {
  at?: number;
  /** Recorded already resolved: news to push, nothing left open to answer (a conclusion). */
  resolved?: boolean;
};

interface EventsDoc {
  seq: number;
  /** The highest `seq` retention ever dropped: a replay from before it may have lost events. */
  prunedSeq: number;
  events: CardEvent[];
  /** Per user id: the highest `seq` already handed to them by `takeUndelivered`. */
  delivered: Record<string, number>;
}

/** Most events the log keeps (oldest go first). */
export const MAX_EVENTS = 500;
/** How long a RESOLVED event stays in the log; an open one stays until resolved or capped. */
export const RESOLVED_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

const store = new JsonStore<EventsDoc>(
  dataPath("card-events.json"),
  () => ({ seq: 0, prunedSeq: 0, events: [], delivered: {} }),
  (raw) => {
    const doc = (raw ?? {}) as Partial<EventsDoc>;
    return {
      seq: typeof doc.seq === "number" ? doc.seq : 0,
      prunedSeq: typeof doc.prunedSeq === "number" ? doc.prunedSeq : 0,
      events: Array.isArray(doc.events) ? doc.events : [],
      delivered: doc.delivered && typeof doc.delivered === "object" ? doc.delivered : {},
    };
  },
);

/** The log after retention: resolved events past RESOLVED_RETENTION_MS go, then the newest MAX_EVENTS stay. PURE. */
export function pruneCardEvents(events: readonly CardEvent[], now: number): CardEvent[] {
  const kept = events.filter((e) => !e.resolvedAt || now - e.resolvedAt <= RESOLVED_RETENTION_MS);
  if (kept.length <= MAX_EVENTS) return kept;
  // Past the cap the oldest RESOLVED go first: an open question is never evicted for a closed one.
  let excess = kept.length - MAX_EVENTS;
  const pruned = kept.filter((e) => !(e.resolvedAt && excess > 0 && excess-- > 0));
  return pruned.slice(-MAX_EVENTS);
}

/* ------------------------------------------------------------------ the push feed */

export type CardEventListener = (event: CardEvent) => void;
const listeners = new Set<CardEventListener>();

/**
 * Hears every NEW event, once, right after it is on disk — so a sink that replays from the log
 * (`eventsAfter`) and then listens never misses one in between. Returns the unsubscribe. A listener
 * must not throw (one that does is logged and costs nobody else the event) and must not block: it
 * runs inside the recording path.
 */
export function onCardEvent(listener: CardEventListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** How many listeners are attached — what proves a closed stream left nothing behind. */
export function cardEventListenerCount(): number {
  return listeners.size;
}

function emit(event: CardEvent): void {
  for (const listener of listeners) {
    try {
      listener(event);
    } catch (err) {
      logger.warn({ card: event.cardId, detail: (err as Error).message }, "a card event listener failed");
    }
  }
}

/**
 * The log past `cursor`, oldest first, resolved events included (a replay tells what HAPPENED).
 * `head` = the newest `seq`; `truncated` = retention already dropped something after `cursor`.
 */
export async function eventsAfter(cursor: number): Promise<{ events: CardEvent[]; head: number; truncated: boolean }> {
  const doc = await store.load();
  return { events: doc.events.filter((e) => e.seq > cursor), head: doc.seq, truncated: cursor < doc.prunedSeq };
}

/**
 * Whether `user` hears about `event` — `null` is the board itself (a card's service token, which
 * reaches every card). The board's own rules (auth/access.ts), decided NOW, so a share taken away
 * also takes away what was not delivered yet; a card someone is working is heard only by them.
 */
export async function canHear(user: PublicUser | null, event: CardEvent): Promise<boolean> {
  if (!user) return true;
  const card = await getCard(event.cardId);
  if (!card || (card.actorUserId && card.actorUserId !== user.id)) return false;
  return (await visibleCards(user, [card])).length > 0;
}

/* ------------------------------------------------------------------ recording */

/** Records one moment. `null` = already recorded (same id) or the card does not exist. */
export async function recordCardEvent(input: CardEventInput): Promise<CardEvent | null> {
  const card = await getCard(input.cardId);
  if (!card) return null;
  const event = await store.mutate((doc) => {
    if (doc.events.some((e) => e.id === input.id)) return null;
    const now = Date.now();
    const open = (kind: CardEventKind) => doc.events.filter((e) => e.cardId === input.cardId && e.kind === kind && !e.resolvedAt);
    // One end of turn per turn: two hooks reporting the same end (the CLI's and the driver's) are one.
    if (input.kind === "turn_finished" && open("turn_finished").length > 0) return null;
    // The newest "I need you" is the one that stands; the same one reported again is no news.
    if (input.kind === "needs_me") {
      const standing = open("needs_me");
      if (standing.some((e) => e.state === input.state && e.summary === input.summary)) return null;
      for (const e of standing) e.resolvedAt = now;
    }
    const { resolved, ...fields } = input;
    const event: CardEvent = { ...fields, seq: ++doc.seq, at: input.at ?? now, title: card.title, projectId: card.projectId };
    if (resolved) event.resolvedAt = now;
    const kept = pruneCardEvents([...doc.events, event], now);
    const keptIds = new Set(kept.map((e) => e.seq));
    for (const e of doc.events) if (!keptIds.has(e.seq)) doc.prunedSeq = Math.max(doc.prunedSeq, e.seq);
    doc.events = kept;
    return event;
  });
  if (event) emit(event);
  return event;
}

/** Resolves a card's open events — only the one with `id`, answering `refId` / of `kind` when given. Returns how many. */
export async function resolveCardEvents(cardId: string, opts: { id?: string; refId?: string; kind?: CardEventKind } = {}): Promise<number> {
  // An event under an answer in flight counts as open here: this resolution is the real one, and
  // taking the claim away keeps a failed send from reopening it afterwards.
  const matches = (e: CardEvent) => e.cardId === cardId && (!e.resolvedAt || e.claim !== undefined) && (opts.id === undefined || e.id === opts.id)
    && (opts.refId === undefined || e.refId === opts.refId) && (opts.kind === undefined || e.kind === opts.kind);
  return store.mutate((doc) => {
    const now = Date.now();
    const open = doc.events.filter(matches);
    for (const e of open) {
      e.resolvedAt = now;
      e.claim = undefined;
    }
    return open.length;
  });
}

/**
 * The open events this person hears about, oldest first, newer than `since` when given: the cards
 * they may see (auth/access.ts), minus concluded and paused ones and cards someone else is working.
 */
async function openFor(user: PublicUser, events: readonly CardEvent[], since = 0): Promise<CardEvent[]> {
  const pending = events.filter((e) => !e.resolvedAt && e.seq > since);
  if (pending.length === 0) return [];
  const ids = new Set(pending.map((e) => e.cardId));
  const cards = (await listAllCards())
    .filter((c) => ids.has(c.id) && c.column !== "done" && c.column !== "paused" && !c.pausedAt)
    .filter((c) => !c.actorUserId || c.actorUserId === user.id);
  const heard = new Map((await visibleCards(user, cards)).map((c) => [c.id, c.parkedAt ?? 0]));
  // An event from before the card was last parked is over, however the card came back.
  return pending.filter((e) => heard.has(e.cardId) && e.at > heard.get(e.cardId)!);
}

/** The person's inbox: open events, oldest first. `cursor` = the newest `seq` in the log. */
export async function inboxFor(user: PublicUser, opts: { since?: number } = {}): Promise<{ events: CardEvent[]; cursor: number }> {
  const doc = await store.load();
  return { events: await openFor(user, doc.events, opts.since ?? 0), cursor: doc.seq };
}

/**
 * The open events this person was not handed yet — and marks them handed. What a tool answer
 * carries along so the person hears each moment once, whichever tool they happened to call.
 */
export async function takeUndelivered(user: PublicUser): Promise<CardEvent[]> {
  const doc = await store.load();
  const delivered = doc.delivered[user.id] ?? 0;
  if (doc.seq <= delivered) return []; // the common case: every answer of a quiet board
  const fresh = await openFor(user, doc.events, delivered);
  if (fresh.length === 0) return [];
  // Two answers at the same time read the same cursor: the one that advances it first keeps the
  // events, the other drops what it no longer owns — inside the queued mutation, where it is exact.
  const before = await markDelivered(user, fresh[fresh.length - 1]!.seq);
  return fresh.filter((e) => e.seq > before);
}

/** Counts everything up to `upTo` as heard by this person. Returns the position it had before. */
export async function markDelivered(user: PublicUser, upTo: number): Promise<number> {
  const known = (await store.load()).delivered[user.id] ?? 0;
  if (known >= upTo) return known;
  return store.mutate((d) => {
    const before = d.delivered[user.id] ?? 0;
    d.delivered[user.id] = Math.max(before, upTo);
    return before;
  });
}

/* ------------------------------------------------------------------ observers */

/**
 * The observers run ONE AT A TIME, in the order they were called. Their callers fire and forget, and
 * a question's result can arrive right behind the question: run concurrently, the resolve could land
 * before the record and leave an answered question open. They NEVER reject: a log that fails is
 * logged here and costs a notice, never the hook, the chat or the report that fed it.
 */
let observing: Promise<void> = Promise.resolve();
function inOrder(cardId: string, work: () => Promise<unknown>): Promise<void> {
  observing = observing.then(work).then(
    () => undefined,
    (err: unknown) => logger.warn({ card: cardId, detail: (err as Error).message }, "could not record the card event"),
  );
  return observing;
}

/**
 * Resolves once every observer queued so far has run — and written. Their callers fire and forget
 * (a card entering `done` is told on a microtask), so a write can land after the caller is long gone:
 * whoever tears the data dir down (a test's cleanup) waits on this first, or the late
 * `card-events.json` makes the `rm` fail with ENOTEMPTY.
 */
export function cardEventsSettled(): Promise<void> {
  return observing;
}

/**
 * A card's status report, seen against the status it had: a turn that ENDS (working → waiting) is a
 * turn_finished, with what the agent declared about it; a turn that STARTS resolves everything the
 * card had open (whoever answered, the card moved on).
 */
export function observeCardStatus(
  cardId: string, was: CardStatus | null | undefined, now: CardStatus,
  /** What the agent had declared WHEN the turn ended — read by the caller, before a new turn clears it. */
  declared?: { state?: DeclaredState; summary?: string },
): Promise<void> {
  if (now === "working" && was !== "working") return inOrder(cardId, () => resolveCardEvents(cardId));
  if (now !== "waiting" || was !== "working") return Promise.resolve();
  return inOrder(cardId, async () => {
    const card = declared ? undefined : await getCard(cardId);
    const { state, summary } = declared ?? { state: card?.declaredState, summary: card?.declaredSummary };
    await recordCardEvent({ id: `turn:${randomUUID()}`, cardId, kind: "turn_finished", state, summary });
  });
}

/** The native chat's stream: its question and permission cards open an event; their outcome resolves it. */
export function observeDriverEvent(cardId: string, event: DriverEvent): Promise<void> {
  switch (event.type) {
    case "user_question":
      return inOrder(cardId, () => recordCardEvent({
        id: `question:${event.id}`, cardId, kind: "question", refId: event.id, questions: event.questions,
      }));
    case "permission_request":
      return inOrder(cardId, () => recordCardEvent({
        id: `permission:${event.id}`, cardId, kind: "permission", refId: event.id, tool: event.tool, reason: event.reason,
      }));
    case "result":
      // A turn that ENDED in error (the driver already tells an abort apart: it is not one).
      if (!event.isError) return Promise.resolve();
      return inOrder(cardId, () => recordCardEvent({
        id: `failed:${randomUUID()}`, cardId, kind: "failed",
        reason: [event.subtype, event.result?.slice(0, 300)].filter(Boolean).join(": ") || "error",
      }));
    case "question_result":
    case "permission": {
      const refId = event.id; // a permission with no id was never asked: nothing to resolve
      return refId ? inOrder(cardId, () => resolveCardEvents(cardId, { refId })) : Promise.resolve();
    }
    default:
      return Promise.resolve(); // the rest of the stream (text, tools, thinking) is not news
  }
}

/**
 * The agent's declared state: needs_me / blocked is "I need you"; anything declared after it means
 * the card moved on, and the previous "I need you" closes.
 */
export function observeDeclaredState(cardId: string, state: DeclaredState, summary: string | undefined): Promise<void> {
  if (state !== "needs_me" && state !== "blocked") {
    return inOrder(cardId, () => resolveCardEvents(cardId, { kind: "needs_me" }));
  }
  return inOrder(cardId, () => recordCardEvent({ id: `state:${randomUUID()}`, cardId, kind: "needs_me", state, summary }));
}

onCardConcluded((cardId) => void observeCardConcluded(cardId));

/** A card entered `done`: announced once per conclusion (a card revived and concluded again is news). */
export function observeCardConcluded(cardId: string): Promise<void> {
  return inOrder(cardId, async () => {
    const card = await getCard(cardId);
    if (card?.column !== "done") return; // brought back before this ran: it is not concluded
    await recordCardEvent({ id: `concluded:${cardId}:${card.parkedAt ?? card.doneAt ?? 0}`, cardId, kind: "concluded", resolved: true });
  });
}

/* ------------------------------------------------------------------ messages */

export interface MessageInput {
  cardId: string;
  type: MessageType;
  text: string;
  severity?: Severity;
  context?: string;
  /** Required for `question` and `approval`: what exactly is being asked. */
  question?: string;
  options?: { label: string; description?: string }[];
  recommended?: string;
  /** Same key from the same card = the same message (a retried call is announced once). */
  idempotencyKey?: string;
}

/**
 * A message the card's agent sends on purpose — the semantic counterpart of the moments above. A
 * question/approval stays OPEN until answered (`inReplyTo`) or the card moves on; anything else is
 * news only, recorded resolved. Throws on a malformed one. Returns the event (the existing one when
 * the idempotency key was seen).
 */
export async function recordMessage(input: MessageInput): Promise<CardEvent> {
  const asks = input.type === "question" || input.type === "approval";
  const question = input.question?.trim();
  if (asks && !question) throw new Error(`a ${input.type} needs the question itself (\`question\`)`);
  if (input.type === "question" && (input.options?.length ?? 0) < 2) throw new Error("a question needs at least two options");
  const labels = (input.options ?? []).map((o) => o.label);
  if (input.recommended !== undefined && !labels.includes(input.recommended)) {
    throw new Error(`recommended must be one of the options (${labels.join(", ") || "none given"})`);
  }
  const id = input.idempotencyKey ? `message:${input.cardId}:${input.idempotencyKey}` : `message:${randomUUID()}`;
  const recorded = await recordCardEvent({
    id, cardId: input.cardId, kind: "message", resolved: !asks,
    messageType: input.type, severity: input.severity ?? (asks ? "warning" : "info"), text: input.text,
    context: input.context, recommended: input.recommended,
    questions: question ? [{ question, options: input.options ?? [] }] : undefined,
  });
  const event = recorded ?? (await store.load()).events.find((e) => e.id === id);
  if (!event) throw new Error("card not found");
  return event;
}

/** The kinds an `inReplyTo` may answer: what asked someone for something. */
const ANSWERABLE = new Set<CardEventKind>(["question", "permission", "needs_me", "message"]);

/**
 * CLAIMS the answer to the open event of this card that `eventId` names: resolved here, atomically,
 * so of two answers at the same time only one goes out — the other throws. `settle` ends the claim:
 * delivered keeps it resolved; not delivered reopens it — unless something else resolved it
 * meanwhile (the card moved on), which took the claim away.
 */
export async function claimReply(cardId: string, eventId: string): Promise<{ event: CardEvent; settle: (delivered: boolean) => Promise<unknown> }> {
  const claim = randomUUID();
  const event = await store.mutate((doc) => {
    const found = doc.events.find((e) => e.id === eventId && e.cardId === cardId);
    if (!found || found.resolvedAt || !ANSWERABLE.has(found.kind)) {
      throw new Error(`event '${eventId}' of this card is not waiting on an answer`);
    }
    found.resolvedAt = Date.now();
    found.claim = claim;
    return { ...found };
  });
  const settle = (delivered: boolean) => store.mutate((doc) => {
    const found = doc.events.find((e) => e.id === eventId);
    if (found?.claim !== claim) return;
    found.claim = undefined;
    if (!delivered) found.resolvedAt = undefined;
  });
  return { event, settle };
}
