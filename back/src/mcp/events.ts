import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import type { PublicUser } from "../auth/users.js";
import { getCard } from "../services/board/registry.js";
import {
  canHear, claimReply, eventsAfter, onCardEvent, MESSAGE_TYPES, type CardEvent, type CardEventKind, type MessageType,
} from "../services/events/cardEvents.js";
import { logger } from "../utils/logger.js";

/**
 * MCP EVENTS — push of the board's events to a connected MCP client, per the MCP Events draft
 * (github.com/modelcontextprotocol/experimental-ext-triggers-events), push mode only:
 *
 *   events/list    → the one event type, `card.event`, and its filters;
 *   events/stream  → a request the server keeps OPEN: `notifications/events/active`, then one
 *                    `notifications/events/event` per event as it is recorded, and a heartbeat with
 *                    the cursor while nothing happens. The client closes the request to stop.
 *
 * Push needs the client CONNECTED: a server cannot reach an app that holds no open request. A client
 * that reconnects passes the last `cursor` and gets what it missed (services/events/cardEvents.ts
 * keeps the log). Who hears what is the board's own rule (`canHear`), checked per event, at send.
 * Nothing here ACTS on an event: what a consumer does with it is up to it and its host.
 */

export const CARD_EVENT = "card.event";
/** Contract version of the payload (`data`): bumped only on an incompatible change. */
export const CONTRACT_VERSION = 1;
/** Knobs a test turns. The draft asks for a heartbeat at least every 30s. */
export const STREAM = { heartbeatMs: 25_000, maxPerPrincipal: 10 };

/**
 * Who the stream is for, asked again at every event and heartbeat: the person (as they are NOW —
 * role and shares), `null` for the board itself, `false` once the credential no longer holds
 * (revoked, expired, rotated). A stream never outlives the credential that opened it.
 */
export type Principal = () => Promise<PublicUser | null | false>;

/** Open streams per principal (user id, or "board"). */
const openStreams = new Map<string, number>();

const SUBSCRIPTION_ID = "io.modelcontextprotocol/subscriptionId";
/** Draft error codes (provisional numbering of the MCP Events sketch). */
const NOT_FOUND = -32023;
const FORBIDDEN = -32024;
const RESOURCE_EXHAUSTED = -32025;

const KIND_TYPE: Record<Exclude<CardEventKind, "message">, MessageType> = {
  turn_finished: "info", question: "question", permission: "approval", needs_me: "question", failed: "error", concluded: "done",
};

const filterSchema = z.object({
  projectId: z.string().optional(),
  cardId: z.string().optional(),
  types: z.array(z.enum(MESSAGE_TYPES as unknown as [MessageType, ...MessageType[]])).min(1).optional(),
}).strict();
type Filter = z.infer<typeof filterSchema>;

const DEFINITION = {
  name: CARD_EVENT,
  description:
    "Something happened on a vibehub card: a message its agent sent on purpose (info, question, approval, " +
    "error, done), a turn that ended, a question or permission waiting on someone, a failure, a conclusion. " +
    "`needsAnswer` is true only for a formal question/approval still open; answer it with " +
    "vibehub_send_to_terminal passing `inReplyTo` = the eventId.",
  delivery: ["push"],
  inputSchema: {
    type: "object",
    properties: {
      projectId: { type: "string", description: "only this project's cards" },
      cardId: { type: "string", description: "only this card" },
      types: { type: "array", items: { enum: MESSAGE_TYPES }, description: "only these types" },
    },
    additionalProperties: false,
  },
  payloadSchema: {
    type: "object",
    properties: {
      contractVersion: { const: CONTRACT_VERSION },
      type: { enum: MESSAGE_TYPES },
      kind: { type: "string", description: "where it came from: message, turn_finished, question, permission, needs_me, failed, concluded" },
      severity: { enum: ["info", "warning", "critical"] },
      needsAnswer: { type: "boolean" },
      text: { type: "string", description: "human-readable, ready to show or speak" },
      cardId: { type: "string" }, projectId: { type: "string" }, cardTitle: { type: "string" },
      sessionId: { type: "string" }, correlationId: { type: "string" }, at: { type: "string", format: "date-time" },
      context: { type: "string" }, question: { type: "string" },
      options: { type: "array", items: { type: "object", properties: { label: { type: "string" }, description: { type: "string" } } } },
      recommended: { type: "string" },
    },
    required: ["contractVersion", "type", "kind", "severity", "needsAnswer", "text", "cardId", "projectId", "cardTitle", "correlationId", "at"],
  },
};

const typeOf = (e: CardEvent): MessageType => (e.kind === "message" ? e.messageType ?? "info" : KIND_TYPE[e.kind]);

function matches(filter: Filter, e: CardEvent): boolean {
  return (!filter.projectId || e.projectId === filter.projectId) && (!filter.cardId || e.cardId === filter.cardId)
    && (!filter.types || filter.types.includes(typeOf(e)));
}

/** What a person reads (or hears): one line or two, the card by title. */
function readable(e: CardEvent, question?: string, options?: { label: string; description?: string }[]): string {
  const card = `Card "${e.title}"`;
  const asked = question
    ? [
      `Pergunta: ${question}`,
      options?.length ? `Opções: ${options.map((o) => (o.description ? `${o.label} (${o.description})` : o.label)).join("; ")}` : "",
      e.recommended ? `(recomendado: ${e.recommended})` : "",
    ].filter(Boolean).join("\n")
    : "";
  switch (e.kind) {
    case "message": return [`${card}: ${e.text ?? ""}`, asked].filter(Boolean).join("\n");
    case "turn_finished": return `${card} terminou o turno.${e.summary ? ` ${e.summary}` : ""}`;
    case "question": return `${card} pergunta.\n${asked}`;
    case "permission": return `${card} pede permissão para usar ${e.tool ?? "uma ferramenta"}${e.reason ? `: ${e.reason}` : ""}.`;
    case "needs_me": return `${card} precisa de você${e.summary ? `: ${e.summary}` : ""}.`;
    case "failed": return `${card} falhou: ${e.reason ?? "erro"}.`;
    case "concluded": return `${card} foi concluído.`;
  }
}

/** The event as the MCP Events `EventOccurrence`: stable contract, structured `data` + readable `text`. */
async function occurrenceOf(e: CardEvent) {
  const type = typeOf(e);
  const first = e.questions?.[0];
  const options = first?.options.map((o) => ({ label: o.label, ...(o.description ? { description: o.description } : {}) }));
  const sessionId = (await getCard(e.cardId))?.resumeSessionId;
  return {
    eventId: e.id,
    name: CARD_EVENT,
    timestamp: new Date(e.at).toISOString(),
    cursor: String(e.seq),
    data: {
      contractVersion: CONTRACT_VERSION, type, kind: e.kind,
      severity: e.severity ?? (type === "question" || type === "approval" || type === "error" ? "warning" : "info"),
      needsAnswer: (type === "question" || type === "approval") && !e.resolvedAt,
      text: readable(e, first?.question, options),
      cardId: e.cardId, projectId: e.projectId, cardTitle: e.title, correlationId: e.id, at: new Date(e.at).toISOString(),
      ...(sessionId ? { sessionId } : {}),
      ...(e.context ? { context: e.context } : {}),
      ...(first ? { question: first.question, options } : {}),
      ...(e.recommended ? { recommended: e.recommended } : {}),
      ...(e.state ? { state: e.state } : {}), ...(e.summary ? { summary: e.summary } : {}),
      ...(e.tool ? { tool: e.tool } : {}), ...(e.reason ? { reason: e.reason } : {}),
    },
  };
}

const invalid = (message: string) => new McpError(ErrorCode.InvalidParams, message);

/** `null` = start from now; a decimal string = the `seq` after which to replay. */
function parseCursor(cursor: unknown): number | null {
  if (cursor === undefined || cursor === null) return null;
  if (typeof cursor !== "string" || !/^\d{1,15}$/.test(cursor)) throw invalid("cursor must be a cursor this server returned, or null");
  return Number(cursor);
}

const listRequest = z.object({ method: z.literal("events/list"), params: z.object({}).passthrough().optional() });
const streamRequest = z.object({ method: z.literal("events/stream"), params: z.object({}).passthrough() });

/**
 * Adds the events methods to one server. `user` = the person an external client acts for; `null` =
 * the board itself (a card's service token), which hears every card. `principal` re-checks the
 * credential while a stream is open (default: it never changes — only for tests and in-process use).
 */
export function registerEvents(server: McpServer, user: PublicUser | null, principal: Principal = async () => user): void {
  const key = user?.id ?? "board";
  server.server.registerCapabilities({ events: {} } as never);
  server.server.setRequestHandler(listRequest, () => ({ events: [DEFINITION] }));
  server.server.setRequestHandler(streamRequest, async (request, extra) => {
    const params = request.params as { name?: unknown; arguments?: unknown; cursor?: unknown; maxAgeMs?: unknown };
    if (params.name !== CARD_EVENT) throw new McpError(NOT_FOUND, `unknown event '${String(params.name)}'`, { kind: "event" });
    const parsed = filterSchema.safeParse(params.arguments ?? {});
    if (!parsed.success) throw invalid(`invalid arguments: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
    const filter = parsed.data;
    const from = parseCursor(params.cursor);
    const maxAgeMs = typeof params.maxAgeMs === "number" && params.maxAgeMs > 0 ? params.maxAgeMs : undefined;
    if ((openStreams.get(key) ?? 0) >= STREAM.maxPerPrincipal) {
      throw new McpError(RESOURCE_EXHAUSTED, "too many open event streams", { limit: "streams", max: STREAM.maxPerPrincipal });
    }

    const meta = { [SUBSCRIPTION_ID]: extra.requestId };
    const notify = (method: string, body: object) => extra.sendNotification({ method, params: { ...body, _meta: meta } } as never);
    // ONE chain per stream: frames leave in the order they were queued, whatever each one awaits.
    let chain: Promise<unknown> = Promise.resolve();
    const queue = (work: () => Promise<unknown>) => {
      chain = chain.then(work).catch((err: unknown) => logger.warn({ detail: (err as Error).message }, "MCP events stream: a frame failed"));
    };
    /** The highest `seq` looked at: an event at or below it was already sent or skipped. */
    let checked = 0;
    let end!: () => void;
    const ended = new Promise<void>((resolve) => { end = resolve; });
    extra.signal.addEventListener("abort", () => end(), { once: true });
    let over = extra.signal.aborted;
    if (over) end(); // closed before the handler ran: the listener above will never fire
    /** The principal as it is now; when the credential is gone, the stream says so and ends. */
    const who = async () => {
      const now = over ? false : await principal();
      if (now === false && !over) {
        over = true;
        await notify("notifications/events/terminated", { error: { code: FORBIDDEN, message: "Forbidden: the credential no longer holds" } });
        end();
      }
      return now;
    };
    const offer = (e: CardEvent) => queue(async () => {
      if (e.seq <= checked) return;
      checked = e.seq;
      if (!matches(filter, e) || (maxAgeMs && e.at < Date.now() - maxAgeMs)) return;
      const now = await who();
      if (now === false || !(await canHear(now, e))) return;
      await notify("notifications/events/event", await occurrenceOf(e));
    });

    // Listen BEFORE reading the log, holding what arrives meanwhile: nothing falls in between, and
    // `checked` drops what the replay already covered.
    const held: CardEvent[] = [];
    let live = false;
    const off = onCardEvent((e) => (live ? offer(e) : held.push(e)));
    const beat = setInterval(() => queue(async () => {
      if ((await who()) !== false) await notify("notifications/events/heartbeat", { cursor: String(checked) });
    }), STREAM.heartbeatMs);
    beat.unref();
    openStreams.set(key, (openStreams.get(key) ?? 0) + 1);
    try {
      const log = await eventsAfter(from ?? Number.MAX_SAFE_INTEGER);
      const replay = from === null ? [] : log.events;
      checked = from ?? log.head;
      const tooOld = maxAgeMs ? replay.some((e) => e.at < Date.now() - maxAgeMs) : false;
      queue(() => notify("notifications/events/active", { cursor: String(checked), truncated: from !== null && (log.truncated || tooOld) }));
      for (const e of replay) offer(e);
      for (const e of held) offer(e);
      live = true;
      await ended;
      await chain; // the terminated frame, if that is why it ended, goes out before the result
    } finally {
      off();
      clearInterval(beat);
      const left = (openStreams.get(key) ?? 1) - 1;
      if (left > 0) openStreams.set(key, left);
      else openStreams.delete(key);
    }
    return { _meta: {} };
  });
}

/**
 * Sends `text` to a card — as the answer to the event `inReplyTo` names, when given: the card is told
 * which question it settles, and the event is claimed BEFORE the send (two answers at once: one goes
 * out, the other is refused) and reopened if the send fails.
 */
export async function sendAnswer<T>(cardId: string, inReplyTo: string | undefined, text: string, send: (text: string) => Promise<T>): Promise<T> {
  if (!inReplyTo) return send(text);
  const { event, settle } = await claimReply(cardId, inReplyTo);
  const asked = event.questions?.[0]?.question ?? event.summary ?? event.text;
  let delivered = false;
  try {
    const sent = await send(`[resposta a ${event.id}${asked ? ` — "${asked}"` : ""}]\n${text}`);
    delivered = true;
    return sent;
  } finally {
    await settle(delivered);
  }
}
