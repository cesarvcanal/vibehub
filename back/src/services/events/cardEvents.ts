import { randomUUID } from "node:crypto";
import { JsonStore } from "../../store/jsonStore.js";
import { dataPath } from "../../config/env.js";
import { cardLevel } from "../../auth/access.js";
import type { PublicUser } from "../../auth/users.js";
import { getCard, type Card, type CardStatus, type DeclaredState } from "../board/registry.js";
import type { DriverEvent, UserQuestionItem } from "../sdk/protocol.js";

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
  return kept.slice(-MAX_EVENTS);
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
    // The newest "I need you" is the one that stands.
    if (input.kind === "needs_me") for (const e of open("needs_me")) e.resolvedAt = now;
    const event: CardEvent = { ...input, seq: ++doc.seq, at: input.at ?? now, title: card.title };
    doc.events = pruneCardEvents([...doc.events, event], now);
    return event;
  });
}

/** Resolves a card's open events — only those answering `refId` / of `kind` when given. Returns how many. */
export async function resolveCardEvents(cardId: string, opts: { refId?: string; kind?: CardEventKind } = {}): Promise<number> {
  return store.mutate((doc) => {
    const now = Date.now();
    let n = 0;
    for (const e of doc.events) {
      if (e.cardId !== cardId || e.resolvedAt) continue;
      if (opts.refId !== undefined && e.refId !== opts.refId) continue;
      if (opts.kind !== undefined && e.kind !== opts.kind) continue;
      e.resolvedAt = now;
      n++;
    }
    return n;
  });
}

/** Does this person hear about this card's events right now? */
async function hears(user: PublicUser, card: Card | undefined): Promise<boolean> {
  if (!card || card.column === "done" || card.column === "paused" || card.pausedAt) return false;
  if (card.actorUserId && card.actorUserId !== user.id) return false;
  return (await cardLevel(user, card.id)) !== null;
}

/** The open events this person hears about, oldest first, newer than `since` when given. */
async function openFor(user: PublicUser, events: readonly CardEvent[], since = 0): Promise<CardEvent[]> {
  const verdicts = new Map<string, boolean>();
  const out: CardEvent[] = [];
  for (const e of events) {
    if (e.resolvedAt || e.seq <= since) continue;
    let ok = verdicts.get(e.cardId);
    if (ok === undefined) {
      ok = await hears(user, await getCard(e.cardId));
      verdicts.set(e.cardId, ok);
    }
    if (ok) out.push(e);
  }
  return out;
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
  const fresh = await openFor(user, doc.events, doc.delivered[user.id] ?? 0);
  if (fresh.length === 0) return [];
  // Two answers at the same time read the same cursor: the one that advances it first keeps the
  // events, the other drops what it no longer owns — inside the queued mutation, where it is exact.
  const before = await markDelivered(user, fresh[fresh.length - 1]!.seq);
  return fresh.filter((e) => e.seq > before);
}

/** Counts everything up to `upTo` as heard by this person. Returns the position it had before. */
export async function markDelivered(user: PublicUser, upTo: number): Promise<number> {
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
 * before the record and leave an answered question open. A failure stays with its own call.
 */
let observing: Promise<unknown> = Promise.resolve();
function inOrder(work: () => Promise<void>): Promise<void> {
  const next = observing.then(work);
  observing = next.catch(() => undefined);
  return next;
}

/**
 * A card's status report, seen against the status it had: a turn that ENDS (working → waiting) is a
 * turn_finished, with what the agent declared about it; a turn that STARTS resolves everything the
 * card had open (whoever answered, the card moved on).
 */
export function observeCardStatus(cardId: string, was: CardStatus | null | undefined, now: CardStatus): Promise<void> {
  return inOrder(async () => {
    if (now === "working" && was !== "working") {
      await resolveCardEvents(cardId);
      return;
    }
    if (now !== "waiting" || was !== "working") return;
    const card = await getCard(cardId);
    if (!card) return;
    await recordCardEvent({
      id: `turn:${randomUUID()}`,
      cardId,
      kind: "turn_finished",
      ...(card.declaredState ? { state: card.declaredState } : {}),
      ...(card.declaredSummary ? { summary: card.declaredSummary } : {}),
    });
  });
}

/** The native chat's stream: its question and permission cards open an event; their outcome resolves it. */
export function observeDriverEvent(cardId: string, event: DriverEvent): Promise<void> {
  switch (event.type) {
    case "user_question":
      return inOrder(async () => {
        await recordCardEvent({ id: `question:${event.id}`, cardId, kind: "question", refId: event.id, questions: event.questions });
      });
    case "permission_request":
      return inOrder(async () => {
        await recordCardEvent({
          id: `permission:${event.id}`, cardId, kind: "permission", refId: event.id, tool: event.tool,
          ...(event.reason ? { reason: event.reason } : {}),
        });
      });
    case "question_result":
      return inOrder(async () => {
        await resolveCardEvents(cardId, { refId: event.id });
      });
    case "permission": {
      const id = event.id;
      return id ? inOrder(async () => { await resolveCardEvents(cardId, { refId: id }); }) : Promise.resolve();
    }
    default:
      return Promise.resolve();
  }
}

/**
 * The agent's declared state: needs_me / blocked is "I need you"; anything declared after it means
 * the card moved on, and the previous "I need you" closes.
 */
export function observeDeclaredState(cardId: string, state: DeclaredState, summary: string | undefined): Promise<void> {
  return inOrder(async () => {
    if (state !== "needs_me" && state !== "blocked") {
      await resolveCardEvents(cardId, { kind: "needs_me" });
      return;
    }
    await recordCardEvent({ id: `state:${randomUUID()}`, cardId, kind: "needs_me", state, ...(summary ? { summary } : {}) });
  });
}
