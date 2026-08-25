import { randomUUID } from "node:crypto";
import { JsonStore } from "../../store/jsonStore.js";
import { config, dataPath } from "../../config/env.js";
import { hostExecutor } from "../../runtime/host.js";
import { getCard, type Card } from "./registry.js";
import { buildSendKeysScript } from "../maestro/maestro.js";
import { cardAgentState, type AgentState } from "./agentState.js";
import { logger } from "../../utils/logger.js";

// The agent probe used to live here; it moved to ./agentState.js so the session view can consult it
// too without a cycle. Re-exported so existing importers (and tests) keep their old entry point.
export { buildAgentProbeScript, classifyAgentState, cardAgentState, type AgentState } from "./agentState.js";
export { looksLikeInteractiveMenu, buildMenuProbeScript, cardAwaitingChoice } from "./agentState.js";

/**
 * THE OUTBOX — what you typed reaches the agent, or it waits until it can.
 *
 * A card's terminal is `claude; exec bash`: when Claude exits (a crash, a `/exit`, a session the
 * runner restarted out from under it) the pane is still there, still attached, still accepting
 * keystrokes — and every one of them lands in a SHELL. A composed message sent into that moment is
 * not delayed, it is GONE: executed as a command, or swallowed by a session that does not exist
 * yet because the card was never opened.
 *
 * So a message is not "typed into a socket" any more. It is HANDED OVER here, and this file owns
 * one promise: it is delivered to a running Claude, or it is still in the queue. Nothing in
 * between, and nothing lost.
 *
 * Three parts:
 *
 *  1. **The probe.** `tmux list-panes -F '#{pane_current_command}'` on the card's session says what
 *     the pane is really running right now. A shell (or nothing at all) means the agent is not
 *     there — whatever the board's columns say. This is the only honest source: the board records
 *     that a card was opened, not that Claude is alive inside it.
 *  2. **The queue.** One JSON document, per card, in order. It outlives the browser tab, the page
 *     reload and a vibehub restart, because "it is in the buffer" has to survive all three or it is
 *     just a variable in a component.
 *  3. **The flush.** Attempted on every enqueue, whenever a terminal attaches, when a status hook
 *     reports the agent went idle, and on a slow ticker as the backstop. Delivery is `send-keys`,
 *     the same path the maestro uses — so a queued message arrives whether or not anyone is looking
 *     at that card.
 *
 * DELIVER-THEN-REMOVE, deliberately: a crash between the two re-delivers a message. A duplicate
 * instruction is visible and annoying; a swallowed one is the bug this exists to kill.
 */

export interface OutboxMessage {
  id: string;
  /** Exactly what the person composed. Never trimmed of meaning, only of surrounding whitespace. */
  text: string;
  createdAt: number;
  /** Delivery attempts that did not land — surfaced so a stuck queue is not a silent one. */
  attempts: number;
  lastError?: string;
}

interface OutboxDoc {
  /** cardId -> messages, oldest first. A card with nothing pending is absent, not an empty array. */
  byCard: Record<string, OutboxMessage[]>;
}

const store = new JsonStore<OutboxDoc>(
  dataPath("outbox.json"),
  () => ({ byCard: {} }),
  (raw) => {
    const doc = raw as Partial<OutboxDoc> | null;
    const byCard: Record<string, OutboxMessage[]> = {};
    const source = doc?.byCard && typeof doc.byCard === "object" ? doc.byCard : {};
    for (const [cardId, list] of Object.entries(source)) {
      if (!Array.isArray(list)) continue;
      const messages = list.filter(
        (m): m is OutboxMessage => Boolean(m) && typeof (m as OutboxMessage).text === "string",
      );
      if (messages.length > 0) byCard[cardId] = messages;
    }
    return { byCard };
  },
);

/** Pending messages for a card, oldest first. */
export async function pendingMessages(cardId: string): Promise<OutboxMessage[]> {
  const doc = await store.load();
  return [...(doc.byCard[cardId] ?? [])];
}

/** Drops one queued message (the composer's ✕ on a pending chip). true = it was there. */
export async function cancelMessage(cardId: string, messageId: string): Promise<boolean> {
  return await store.mutate((doc) => {
    const list = doc.byCard[cardId];
    if (!list) return false;
    const next = list.filter((m) => m.id !== messageId);
    if (next.length === list.length) return false;
    if (next.length === 0) delete doc.byCard[cardId];
    else doc.byCard[cardId] = next;
    return true;
  });
}

/** Every card that has something waiting. The ticker's work list — usually empty, and then cheap. */
export async function cardsWithPending(): Promise<string[]> {
  const doc = await store.load();
  return Object.keys(doc.byCard).filter((id) => (doc.byCard[id]?.length ?? 0) > 0);
}

async function appendMessage(cardId: string, text: string): Promise<OutboxMessage> {
  const message: OutboxMessage = { id: randomUUID(), text, createdAt: Date.now(), attempts: 0 };
  await store.mutate((doc) => {
    doc.byCard[cardId] = [...(doc.byCard[cardId] ?? []), message];
  });
  return message;
}

async function removeMessage(cardId: string, messageId: string): Promise<void> {
  await store.mutate((doc) => {
    const list = doc.byCard[cardId];
    if (!list) return;
    const next = list.filter((m) => m.id !== messageId);
    if (next.length === 0) delete doc.byCard[cardId];
    else doc.byCard[cardId] = next;
  });
}

async function markAttempt(cardId: string, messageId: string, detail: string): Promise<void> {
  await store.mutate((doc) => {
    const message = doc.byCard[cardId]?.find((m) => m.id === messageId);
    if (!message) return;
    message.attempts += 1;
    message.lastError = detail;
  });
}

export interface FlushResult {
  /** How many messages actually landed in the agent's prompt. */
  delivered: number;
  /** What the pane turned out to be running — the reason the rest (if any) is still queued. */
  agent: AgentState;
}

/**
 * One flush per card at a time. The POST that enqueues, the ticker and the status hook can all
 * arrive within the same second, and two of them delivering the same queue would type the message
 * twice into the same prompt. A caller that arrives mid-flush WAITS for it and reads its result,
 * which is also what keeps the enqueue path down to a single probe.
 */
const flushLocks = new Map<string, Promise<FlushResult>>();

/**
 * Delivers everything queued for a card, in order, IF the agent is really running. Never throws:
 * this is called from fire-and-forget paths (a websocket attach, a status hook, a ticker) where an
 * exception has nowhere to go.
 */
export async function flushCard(cardId: string): Promise<FlushResult> {
  const running = flushLocks.get(cardId);
  if (running) return await running;
  const attempt = flushOnce(cardId).finally(() => {
    if (flushLocks.get(cardId) === attempt) flushLocks.delete(cardId);
  });
  flushLocks.set(cardId, attempt);
  return await attempt;
}

async function flushOnce(cardId: string): Promise<FlushResult> {
  let delivered = 0;
  let agent: AgentState = "none";
  try {
    const queued = await pendingMessages(cardId);
    if (queued.length === 0) return { delivered, agent: "running" };
    const card = await getCard(cardId);
    if (!card) {
      // The card is gone (deleted while something was queued): so is the queue.
      await store.mutate((doc) => {
        delete doc.byCard[cardId];
      });
      return { delivered, agent: "none" };
    }
    agent = await cardAgentState(card);
    if (agent !== "running") return { delivered, agent };

    for (const message of queued) {
      try {
        await hostExecutor().runScript(
          buildSendKeysScript(config.runner.container, card.tmuxSession, message.text),
          { timeoutMs: 30_000 },
        );
        await removeMessage(cardId, message.id);
        delivered += 1;
        logger.info(
          {
            audit: true, action: "card.message.delivered", card: card.worktreeSlug,
            session: card.tmuxSession, bytes: Buffer.byteLength(message.text),
          },
          "queued message delivered to the card terminal",
        );
      } catch (err) {
        const detail = (err as Error).message;
        await markAttempt(cardId, message.id, detail);
        logger.warn(
          { card: card.worktreeSlug, detail },
          "queued message could not be delivered — it stays in the outbox",
        );
        // Order matters in a conversation: stop at the first failure rather than delivering the
        // messages behind it out of sequence.
        break;
      }
    }
  } catch (err) {
    logger.warn({ card: cardId, detail: (err as Error).message }, "outbox flush failed (best-effort)");
  }
  return { delivered, agent };
}

export interface QueueResult {
  /** true = it went straight to the agent; false = it is waiting in the queue below. */
  delivered: boolean;
  pending: OutboxMessage[];
  agent: AgentState;
}

/**
 * Hands a composed message over. It is written to the queue FIRST and only then delivered, so the
 * window where it exists nowhere is zero — a vibehub that dies mid-call still has the message.
 */
export async function queueMessage(cardId: string, text: string, by?: string): Promise<QueueResult> {
  const body = String(text ?? "").trim();
  if (!body) throw new Error("empty text: there is nothing to send to the terminal");
  const card = await getCard(cardId);
  if (!card) throw new Error("card not found");

  const message = await appendMessage(cardId, body);
  logger.info(
    {
      audit: true, action: "card.message.queued", card: card.worktreeSlug,
      bytes: Buffer.byteLength(body), by,
    },
    "message accepted for the card terminal",
  );
  // The flush's own probe is the only one this call makes: asking the runner twice what it is
  // running, for one Enter, is a docker exec nobody needs.
  const { agent } = await flushCard(cardId);
  const pending = await pendingMessages(cardId);
  return { delivered: !pending.some((m) => m.id === message.id), pending, agent };
}

/** Everything the composer needs to render the queue under the field. */
export async function outboxStatus(cardId: string): Promise<{ pending: OutboxMessage[]; agent: AgentState }> {
  const card = await getCard(cardId);
  if (!card) throw new Error("card not found");
  const pending = await pendingMessages(cardId);
  // The probe costs a docker exec: only worth paying for when something is actually waiting on it.
  return { pending, agent: pending.length > 0 ? await cardAgentState(card) : "running" };
}

/** How often the backstop looks for work. Slow on purpose — the real triggers are event-driven. */
export const OUTBOX_TICK_MS = 8_000;

let ticker: ReturnType<typeof setInterval> | null = null;

/**
 * The backstop. Every other trigger is an event (enqueue, terminal attach, status hook); this one
 * exists for the case none of them fires — a Claude that came back up on its own inside a session
 * nobody is watching.
 */
export function startOutboxFlusher(intervalMs = OUTBOX_TICK_MS): void {
  if (ticker) return;
  ticker = setInterval(() => {
    void (async () => {
      try {
        for (const cardId of await cardsWithPending()) await flushCard(cardId);
      } catch {
        /* best-effort: the next tick tries again */
      }
    })();
  }, intervalMs);
  // Never hold the process open for a queue that is empty most of the time.
  ticker.unref?.();
}

export function stopOutboxFlusher(): void {
  if (!ticker) return;
  clearInterval(ticker);
  ticker = null;
}

/** Tests only. */
export function resetOutboxForTesting(): void {
  store.resetForTesting();
  flushLocks.clear();
}
