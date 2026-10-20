import { randomUUID } from "node:crypto";
import { JsonStore } from "../../store/jsonStore.js";
import { dataPath } from "../../config/env.js";
import { visibleCards } from "../../auth/access.js";
import type { PublicUser } from "../../auth/users.js";
import { getCard, listAllCards, type Card, type CardStatus, type DeclaredState } from "../board/registry.js";
import type { DriverEvent, UserQuestionItem } from "../sdk/protocol.js";
import { logger } from "../../utils/logger.js";

/**
 * CARD EVENTS — the moments a person AWAY from the board must hear about: a card finished its turn,
 * asked them a question, waits for a permission, or declared it needs them.
 *
 * The board shows all of that on screen; an assistant driving the cards from outside (ChatGPT, often
 * by voice) only learns it when a tool answers. So the moments are recorded here, once each, on disk,
 * and read back per person — the inbox (`inboxFor`) and the "what is new since you last heard"
 * handover (`takeUndelivered`). Nothing here PUSHES: an MCP server cannot start a turn of the app on
 * the other end. Sinks that do (webhooks, notifications) read from this same log.
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

export type CardEventKind = "turn_finished" | "question" | "permission" | "needs_me";

export interface CardEvent {
  /** Monotonic position in the log — the cursor a reader passes back as `since`. */
  seq: number;
  id: string;
  cardId: string;
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
  resolvedAt?: number;
}

export type CardEventInput = Omit<CardEvent, "seq" | "at" | "title" | "resolvedAt"> & { at?: number };

interface EventsDoc {
  seq: number;
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
  () => ({ seq: 0, events: [], delivered: {} }),
  (raw) => {
    const doc = (raw ?? {}) as Partial<EventsDoc>;
    return {
      seq: typeof doc.seq === "number" ? doc.seq : 0,
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

/** Records one moment. `null` = already recorded (same id) or the card does not exist. */
export async function recordCardEvent(input: CardEventInput): Promise<CardEvent | null> {
  const card = await getCard(input.cardId);
  if (!card) return null;
  return store.mutate((doc) => {
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
    const event: CardEvent = { ...input, seq: ++doc.seq, at: input.at ?? now, title: card.title };
    doc.events = pruneCardEvents([...doc.events, event], now);
    return event;
  });
}

/** Resolves a card's open events — only those answering `refId` / of `kind` when given. Returns how many. */
export async function resolveCardEvents(cardId: string, opts: { refId?: string; kind?: CardEventKind } = {}): Promise<number> {
  const matches = (e: CardEvent) => e.cardId === cardId && !e.resolvedAt
    && (opts.refId === undefined || e.refId === opts.refId) && (opts.kind === undefined || e.kind === opts.kind);
  return store.mutate((doc) => {
    const now = Date.now();
    const open = doc.events.filter(matches);
    for (const e of open) e.resolvedAt = now;
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
