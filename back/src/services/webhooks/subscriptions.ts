import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { Webhook } from "standardwebhooks";
import { JsonStore } from "../../store/jsonStore.js";
import { dataPath } from "../../config/env.js";
import { canAccessProject, cardLevel } from "../../auth/access.js";
import { userForAccessTokenHash } from "../../auth/oauth.js";
import type { PublicUser } from "../../auth/users.js";
import { runnerToken } from "../../runtime/runner.js";
import { openSecret, sealSecret } from "../../secrets/vault.js";
import { getCard } from "../board/registry.js";
import { canHear, eventsAfter, onCardEvent, type CardEvent } from "../events/cardEvents.js";
import { CARD_EVENT, filterSchema, matches, occurrenceOf, type Filter } from "../../mcp/events.js";
import { CallbackError, CallbackUrlError, assertCallbackUrl, postWebhook, type CallbackReason } from "./net.js";
import { logger } from "../../utils/logger.js";

/**
 * MCP EVENTS — WEBHOOK DELIVERY. A client (ChatGPT in a Work chat, or any MCP 2026-07-28 client)
 * calls `events/subscribe` with a callback URL and a signing secret it generated; from then on the
 * board's events (services/events/cardEvents.ts) that match the subscription are POSTed there, one
 * per request, signed per Standard Webhooks. Spec followed:
 * developers.openai.com/plugins/build/mcp-events and the MCP Events design sketch it links.
 *
 * What holds it together:
 *  - IDENTITY: (principal, url, name, canonical arguments) → a deterministic `sub_` id, so a
 *    subscribe is an idempotent upsert and a refresh is the same call again. The principal is the
 *    account (`user:<id>`) or the board; another principal's unsubscribe never finds it.
 *  - CONSENT: before the first delivery to a URL, a signed `verification` with a single-use challenge
 *    the endpoint must echo (constant-time compare). Cached per (principal, url), persisted.
 *  - THE GRANT IS RE-CHECKED: the credential that subscribed is kept as its hash and re-validated at
 *    every delivery (revoked or expired → the subscription is dropped), and who may hear each event
 *    is the board's own rule (`canHear`), decided at send time.
 *  - DURABLE: subscriptions, the verification cache and every pending delivery live in one JSON file;
 *    the per-subscription `checkedSeq` means an event recorded right before a crash is still sent.
 *  - RETRIES: transient failures back off exponentially up to `maxAttempts`, same eventId, fresh
 *    signature; 410/413 and other definitive 4xx are not retried.
 *  - The signing secret is stored encrypted with the vault key; logs carry the subscription id and
 *    the host, never the secret, the full URL or the credential.
 */

/**
 * JSON-RPC error codes. OpenAI documents `-32015` for CallbackEndpointError, which is the numbering
 * of the draft revision ChatGPT implements (`-32011`..`-32015`, see the sketch's "Code allocation"
 * note); the other four follow that same revision's order. The current draft renumbers them to
 * `-32023`..`-32027` (what the push stream in mcp/events.ts uses) — ChatGPT is the target here.
 */
export const ERR = {
  INVALID_PARAMS: -32602, NOT_FOUND: -32011, FORBIDDEN: -32012, RESOURCE_EXHAUSTED: -32013, UNSUPPORTED: -32014, CALLBACK_ENDPOINT: -32015,
} as const;

export class EventsError extends Error {
  constructor(readonly code: number, message: string, readonly data?: Record<string, unknown>) {
    super(message);
  }
}

/** The knobs. Tests turn them; the defaults follow the draft's "Recommended grants". */
export const WEBHOOKS = {
  defaultTtlMs: 24 * 60 * 60_000,
  /** Floor of a grant (no refresh storms). */
  minTtlMs: 5 * 60_000,
  /** Ceiling — also what `ttlMs: null` (no expiry) is answered with: this server never grants forever. */
  maxTtlMs: 7 * 24 * 60 * 60_000,
  /** How long a passed challenge covers a (principal, url). */
  verificationTtlMs: 7 * 24 * 60 * 60_000,
  maxPerPrincipal: 25,
  maxAttempts: 5,
  /** First retry at most this long after; doubles per attempt (≤10s, 20s, 40s, 80s), each with jitter down to half. */
  retryBaseMs: 10_000,
  /** Deliveries in flight at once, across every subscription… */
  concurrency: 4,
  /** …and per account (so one account's stuck callbacks leave the others room). */
  maxInFlightPerPrincipal: 2,
  /** After a secret rotation, deliveries carry both signatures this long. */
  rotationGraceMs: 5 * 60_000,
  /** The whole body, bytes (OpenAI: 256 KiB). */
  maxBodyBytes: 256 * 1024,
  /** Challenges per account and destination host per minute. */
  verificationsPerHostPerMinute: 10,
  /** The dispatcher's backstop tick (retries come due, subscriptions lapse). */
  tickMs: 5_000,
};

/** Who subscribes: the canonical principal, the person (null = the board), the hash of the credential. */
export interface WebhookPrincipal {
  key: string;
  user: PublicUser | null;
  credential: string;
}

interface StoredSubscription {
  id: string;
  key: string;
  credential: string;
  name: string;
  arguments: Filter;
  url: string;
  /** Sealed with the vault key (secrets/vault.ts). */
  secret: string;
  oldSecret?: string;
  oldSecretUntil?: number;
  createdAt: number;
  expiresAt: number;
  /** The highest event `seq` already looked at for this subscription. */
  checkedSeq: number;
  lastDeliveryAt?: number;
  lastError?: string;
  failedSince?: number;
}

interface PendingDelivery {
  subId: string;
  eventId: string;
  seq: number;
  attempts: number;
  nextAt: number;
}

interface WebhookDoc {
  subscriptions: StoredSubscription[];
  /** sha256(principal + url) → when the challenge passed. */
  verified: Record<string, number>;
  pending: PendingDelivery[];
}

const store = new JsonStore<WebhookDoc>(
  dataPath("webhook-subscriptions.json"),
  () => ({ subscriptions: [], verified: {}, pending: [] }),
  (raw) => {
    const doc = (raw ?? {}) as Partial<WebhookDoc>;
    return {
      subscriptions: Array.isArray(doc.subscriptions) ? doc.subscriptions : [],
      verified: doc.verified && typeof doc.verified === "object" ? doc.verified : {},
      pending: Array.isArray(doc.pending) ? doc.pending : [],
    };
  },
);

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const invalid = (message: string) => new EventsError(ERR.INVALID_PARAMS, message);
const forbidden = (message: string) => new EventsError(ERR.FORBIDDEN, message);

/** JSON with object keys sorted, recursively: what makes `{a,b}` and `{b,a}` the same subscription. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

const subscriptionId = (key: string, url: string, name: string, args: Filter) =>
  `sub_${sha256(canonicalJson([key, url, name, args])).slice(0, 32)}`;
const verifiedKey = (key: string, url: string) => sha256(`${key}\n${url}`);

/** Standard Webhooks symmetric secret: `whsec_` + base64 of 24–64 bytes. */
function assertSecret(secret: unknown): string {
  const match = typeof secret === "string" ? /^whsec_([A-Za-z0-9+/]+={0,2})$/.exec(secret) : null;
  const bytes = match ? Buffer.from(match[1]!, "base64") : null;
  if (!bytes || bytes.toString("base64") !== match![1] || bytes.length < 24 || bytes.length > 64) {
    throw invalid("delivery.secret must be whsec_ followed by base64 of 24 to 64 bytes");
  }
  return secret as string;
}

/** The principal as it is NOW: the person, `null` for the board, `false` when the credential no longer holds. */
async function holder(p: { key: string; credential: string }): Promise<PublicUser | null | false> {
  if (p.key === "board") {
    const token = await runnerToken();
    if (!token) return false;
    const now = Buffer.from(sha256(token));
    const kept = Buffer.from(p.credential);
    return now.length === kept.length && timingSafeEqual(now, kept) ? null : false;
  }
  const user = await userForAccessTokenHash(p.credential);
  return user && `user:${user.id}` === p.key ? user : false;
}

/** Subscribe-time ACL on the filters: a member may only name a card or project they can see. */
async function assertMayFilter(user: PublicUser | null, args: Filter): Promise<void> {
  if (args.cardId && !(user ? await cardLevel(user, args.cardId) : await getCard(args.cardId))) {
    throw forbidden("not allowed to subscribe to this card");
  }
  if (args.projectId && user && !(await canAccessProject(user, args.projectId))) {
    throw forbidden("not allowed to subscribe to this project");
  }
}

function grantTtl(ttlMs: unknown): number {
  if (ttlMs === undefined) return WEBHOOKS.defaultTtlMs;
  if (ttlMs === null) return WEBHOOKS.maxTtlMs;
  if (typeof ttlMs !== "number" || !Number.isFinite(ttlMs) || ttlMs < 0) throw invalid("ttlMs must be a non-negative number or null");
  return Math.min(Math.max(ttlMs, WEBHOOKS.minTtlMs), WEBHOOKS.maxTtlMs);
}

function parseCursor(cursor: unknown, head: number): number | null {
  if (cursor === undefined || cursor === null) return null;
  if (typeof cursor !== "string" || !/^\d{1,15}$/.test(cursor) || Number(cursor) > head) {
    throw invalid("cursor must be a cursor this server returned, or null");
  }
  return Number(cursor);
}

/** The draft's wire categories: a refused address reads as a refused connection. */
const category = (reason: CallbackReason): string => (reason === "blocked_address" ? "connection_refused" : reason);

/* ------------------------------------------------------------------ signing */

function sign(secrets: string[], msgId: string, at: Date, body: string): string {
  return secrets.map((s) => new Webhook(s).sign(msgId, at, body)).join(" ");
}

function headers(msgId: string, subId: string, secrets: string[], body: string): Record<string, string> {
  const at = new Date();
  return {
    "content-type": "application/json",
    "webhook-id": msgId,
    "webhook-timestamp": String(Math.floor(at.getTime() / 1000)),
    "webhook-signature": sign(secrets, msgId, at, body),
    "x-mcp-subscription-id": subId,
  };
}

/**
 * Challenges sent in the last minute, per (principal, host): one account cannot spend the budget of a
 * callback host every account shares (ChatGPT's), nor make vibehub flood a host it does not own.
 */
const recentChallenges = new Map<string, number[]>();

/** The consent handshake: a signed single-use challenge the endpoint must echo in a 2xx. */
async function verifyCallback(principalKey: string, subId: string, url: string, secret: string): Promise<void> {
  const host = new URL(url).host;
  const now = Date.now();
  for (const [k, times] of recentChallenges) if (times.every((t) => now - t >= 60_000)) recentChallenges.delete(k);
  const budget = `${principalKey}\n${host}`;
  const recent = recentChallenges.get(budget) ?? [];
  if (recent.length >= WEBHOOKS.verificationsPerHostPerMinute) {
    throw new EventsError(ERR.RESOURCE_EXHAUSTED, "too many verifications for this host", { limit: "verifications", max: WEBHOOKS.verificationsPerHostPerMinute });
  }
  recentChallenges.set(budget, [...recent.filter((t) => now - t < 60_000), now]);
  const challenge = randomBytes(32).toString("base64url");
  const body = JSON.stringify({ type: "verification", challenge });
  let reply: { status: number; body: string };
  try {
    reply = await postWebhook(url, headers(`msg_verification_${randomBytes(12).toString("hex")}`, subId, [secret], body), body);
  } catch (err) {
    const reason = err instanceof CallbackError ? category(err.reason) : "connection_refused";
    logger.info({ subscription: subId, host, reason }, "MCP events: callback verification could not reach the endpoint");
    throw new EventsError(ERR.CALLBACK_ENDPOINT, "callback verification failed", { reason });
  }
  let echoed: unknown;
  try {
    echoed = (JSON.parse(reply.body) as { challenge?: unknown }).challenge;
  } catch { /* not JSON: not an echo */ }
  const ok = reply.status >= 200 && reply.status < 300 && typeof echoed === "string"
    && echoed.length === challenge.length && timingSafeEqual(Buffer.from(echoed), Buffer.from(challenge));
  if (!ok) {
    logger.info({ subscription: subId, host, status: reply.status }, "MCP events: callback verification failed");
    throw new EventsError(ERR.CALLBACK_ENDPOINT, "callback verification failed", { reason: "challenge_failed" });
  }
}

/* ------------------------------------------------------------------ subscribe / unsubscribe */

export interface SubscribeResult {
  id: string;
  refreshBefore: string | null;
  cursor: string | null;
  truncated: boolean;
  deliveryStatus?: { active: boolean; lastDeliveryAt: string | null; lastError: string | null; failedSince?: string };
}

interface Target { name: string; args: Filter; url: string }

/** What subscribe and unsubscribe both read the same way: the event, its arguments, the URL. */
function parseTarget(params: Record<string, unknown>): Target {
  if (params.name !== CARD_EVENT) throw new EventsError(ERR.NOT_FOUND, `unknown event '${String(params.name)}'`, { kind: "event" });
  const parsed = filterSchema.safeParse(params.arguments ?? {});
  if (!parsed.success) throw invalid(`invalid arguments: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
  const delivery = (params.delivery ?? {}) as Record<string, unknown>;
  if (delivery.mode !== undefined && delivery.mode !== "webhook") {
    throw new EventsError(ERR.UNSUPPORTED, "this event is delivered by webhook only", { feature: "deliveryMode", value: delivery.mode });
  }
  if (typeof delivery.url !== "string") throw invalid("delivery.url is required");
  try {
    assertCallbackUrl(delivery.url);
  } catch (err) {
    if (err instanceof CallbackUrlError) throw invalid(err.message);
    throw err;
  }
  return { name: params.name, args: parsed.data, url: delivery.url };
}

/** The safe-to-persist cursor: nothing at or before it is still waiting to be delivered. */
function watermark(doc: WebhookDoc, sub: StoredSubscription): string {
  const waiting = doc.pending.filter((p) => p.subId === sub.id).map((p) => p.seq);
  return String(waiting.length ? Math.min(...waiting) - 1 : sub.checkedSeq);
}

/** `events/subscribe`, webhook mode: validate, authorize, verify the callback once, upsert. */
export async function subscribeWebhook(principal: WebhookPrincipal | null, raw: unknown, now: number = Date.now()): Promise<SubscribeResult> {
  if (!principal) throw forbidden("webhook subscriptions need an authenticated principal");
  const params = (raw ?? {}) as Record<string, unknown>;
  const target = parseTarget(params);
  const secret = assertSecret(((params.delivery ?? {}) as Record<string, unknown>).secret);
  const ttl = grantTtl(params.ttlMs);
  const log = await eventsAfter(Number.MAX_SAFE_INTEGER);
  const cursor = parseCursor(params.cursor, log.head);
  const maxAgeMs = typeof params.maxAgeMs === "number" && params.maxAgeMs > 0 ? params.maxAgeMs : undefined;

  const who = await holder(principal);
  if (who === false || (principal.user?.id ?? null) !== (who?.id ?? null)) throw forbidden("the credential no longer holds");
  await assertMayFilter(who, target.args);

  const id = subscriptionId(principal.key, target.url, target.name, target.args);
  const before = await store.load();
  const existing = before.subscriptions.find((s) => s.id === id && s.expiresAt > now);
  if (!existing && before.subscriptions.filter((s) => s.key === principal.key && s.expiresAt > now).length >= WEBHOOKS.maxPerPrincipal) {
    throw new EventsError(ERR.RESOURCE_EXHAUSTED, "too many webhook subscriptions", { limit: "subscriptions", max: WEBHOOKS.maxPerPrincipal });
  }
  const vKey = verifiedKey(principal.key, target.url);
  const verifiedAt = before.verified[vKey];
  if (verifiedAt === undefined || now - verifiedAt > WEBHOOKS.verificationTtlMs) await verifyCallback(principal.key, id, target.url, secret);

  // Where a NEW (or lapsed) subscription starts: now, or replay from the client's cursor — bounded
  // by maxAgeMs and by what retention still has (`truncated` when either skipped something).
  let start = cursor ?? log.head;
  let truncated = cursor !== null && (await eventsAfter(cursor)).truncated;
  if (cursor !== null && maxAgeMs) {
    const old = (await eventsAfter(cursor)).events.filter((e) => e.at < now - maxAgeMs);
    if (old.length) {
      start = Math.max(start, ...old.map((e) => e.seq));
      truncated = true;
    }
  }
  const sealed = await sealSecret(secret);
  // The sealed form differs on every call (random IV): a rotation is a different PLAINTEXT.
  const kept = existing ? Buffer.from(await openSecret(existing.secret)) : null;
  const rotated = kept !== null && !(kept.length === Buffer.byteLength(secret) && timingSafeEqual(kept, Buffer.from(secret)));
  return await store.mutate((doc) => {
    let sub = doc.subscriptions.find((s) => s.id === id);
    const live = sub !== undefined && sub.expiresAt > now;
    // The cap again, inside the queue: parallel subscribes all passed the early check before verifying.
    if (!live && doc.subscriptions.filter((s) => s.key === principal.key && s.expiresAt > now && s.id !== id).length >= WEBHOOKS.maxPerPrincipal) {
      throw new EventsError(ERR.RESOURCE_EXHAUSTED, "too many webhook subscriptions", { limit: "subscriptions", max: WEBHOOKS.maxPerPrincipal });
    }
    doc.verified[vKey] = verifiedAt !== undefined && now - verifiedAt <= WEBHOOKS.verificationTtlMs ? verifiedAt : now;
    if (!sub || !live) {
      doc.subscriptions = doc.subscriptions.filter((s) => s.id !== id);
      doc.pending = doc.pending.filter((p) => p.subId !== id);
      sub = {
        id, key: principal.key, credential: principal.credential, name: target.name, arguments: target.args, url: target.url,
        secret: sealed, createdAt: now, expiresAt: now + ttl, checkedSeq: start,
      };
      doc.subscriptions.push(sub);
      return { id, refreshBefore: new Date(sub.expiresAt).toISOString(), cursor: watermark(doc, sub), truncated };
    }
    // A refresh: same identity; the TTL is re-granted, the credential and the secret are the latest.
    sub.expiresAt = now + ttl;
    sub.credential = principal.credential;
    if (rotated) {
      sub.oldSecret = sub.secret;
      sub.oldSecretUntil = now + WEBHOOKS.rotationGraceMs;
      sub.secret = sealed;
    }
    return {
      id, refreshBefore: new Date(sub.expiresAt).toISOString(), cursor: watermark(doc, sub), truncated: false,
      deliveryStatus: {
        active: true,
        lastDeliveryAt: sub.lastDeliveryAt ? new Date(sub.lastDeliveryAt).toISOString() : null,
        lastError: sub.lastError ?? null,
        ...(sub.failedSince ? { failedSince: new Date(sub.failedSince).toISOString() } : {}),
      },
    };
  });
}

/** `events/unsubscribe`: stops the principal's matching subscription. Idempotent; `{}` either way. */
export async function unsubscribeWebhook(principal: WebhookPrincipal | null, raw: unknown): Promise<Record<string, never>> {
  if (!principal) throw forbidden("webhook subscriptions need an authenticated principal");
  if ((await holder(principal)) === false) throw forbidden("the credential no longer holds");
  const target = parseTarget((raw ?? {}) as Record<string, unknown>);
  const id = subscriptionId(principal.key, target.url, target.name, target.args);
  await store.mutate((doc) => {
    doc.subscriptions = doc.subscriptions.filter((s) => s.id !== id);
    doc.pending = doc.pending.filter((p) => p.subId !== id);
  });
  return {};
}

/* ------------------------------------------------------------------ delivery */

/** Free text an event may carry at length: what a summary cuts first. */
const LONG_FIELDS = ["context", "text", "summary", "reason", "question"] as const;
const SUMMARY_CHARS = 4_000;

/**
 * The body, serialized ONCE (what is signed is what is sent). Past the size limit the long free-text
 * fields are cut and `data.truncated` set — a summary still wakes the agent, which can read the full
 * record with a tool; null when even that does not fit.
 */
function fitted(occurrence: { data: Record<string, unknown> }): string | null {
  const body = JSON.stringify(occurrence);
  if (Buffer.byteLength(body, "utf8") <= WEBHOOKS.maxBodyBytes) return body;
  const data: Record<string, unknown> = { ...occurrence.data, truncated: true };
  for (const field of LONG_FIELDS) {
    const value = data[field];
    if (typeof value === "string" && value.length > SUMMARY_CHARS) data[field] = `${value.slice(0, SUMMARY_CHARS)}…`;
  }
  const summary = JSON.stringify({ ...occurrence, data });
  return Buffer.byteLength(summary, "utf8") <= WEBHOOKS.maxBodyBytes ? summary : null;
}

type Outcome = { kind: "done" } | { kind: "drop"; error?: string } | { kind: "retry"; error: string } | { kind: "revoked" };

async function attempt(p: PendingDelivery, now: number): Promise<Outcome> {
  const doc = await store.load();
  const sub = doc.subscriptions.find((s) => s.id === p.subId);
  if (!sub || sub.expiresAt <= now) return { kind: "drop" };
  const who = await holder(sub);
  if (who === false) return { kind: "revoked" };
  const event: CardEvent | undefined = (await eventsAfter(p.seq - 1)).events.find((e) => e.seq === p.seq);
  if (!event || !(await canHear(who, event))) return { kind: "drop" };
  const body = fitted(await occurrenceOf(event, watermark(doc, sub)));
  if (!body) {
    logger.warn({ subscription: sub.id, event: event.id }, "MCP events: event over 256 KiB even summarized, not delivered");
    return { kind: "drop" };
  }
  const secrets = [await openSecret(sub.secret)];
  if (sub.oldSecret && (sub.oldSecretUntil ?? 0) > now) secrets.push(await openSecret(sub.oldSecret));
  try {
    const { status } = await postWebhook(sub.url, headers(event.id, sub.id, secrets, body), body);
    if (status >= 200 && status < 300) return { kind: "done" };
    const error = status >= 500 ? "http_5xx" : "http_4xx";
    // 408/425/429 say "later"; any other 4xx (410 and 413 above all) is final for this event.
    return status >= 500 || status === 408 || status === 425 || status === 429 || status < 400 ? { kind: "retry", error } : { kind: "drop", error };
  } catch (err) {
    return { kind: "retry", error: err instanceof CallbackError ? category(err.reason) : "connection_refused" };
  }
}

/** Reclaims lapsed subscriptions and queues every new matching event (by `checkedSeq`, so none slips). */
async function enqueue(now: number): Promise<void> {
  const log = await eventsAfter(0);
  await store.mutate((doc) => {
    const lapsed = new Set(doc.subscriptions.filter((s) => s.expiresAt <= now).map((s) => s.id));
    if (lapsed.size) {
      doc.subscriptions = doc.subscriptions.filter((s) => !lapsed.has(s.id));
      doc.pending = doc.pending.filter((p) => !lapsed.has(p.subId));
    }
    for (const [k, at] of Object.entries(doc.verified)) if (now - at > WEBHOOKS.verificationTtlMs) delete doc.verified[k];
    for (const sub of doc.subscriptions) {
      if (sub.oldSecret && (sub.oldSecretUntil ?? 0) <= now) {
        delete sub.oldSecret;
        delete sub.oldSecretUntil;
      }
      if (sub.checkedSeq >= log.head) continue;
      for (const e of log.events) {
        if (e.seq <= sub.checkedSeq || e.seq > log.head || !matches(sub.arguments, e)) continue;
        if (!doc.pending.some((p) => p.subId === sub.id && p.eventId === e.id)) {
          doc.pending.push({ subId: sub.id, eventId: e.id, seq: e.seq, attempts: 0, nextAt: now });
        }
      }
      sub.checkedSeq = log.head;
    }
  });
}

/** Records how one attempt went: acked, dropped, rescheduled with backoff, or the subscription gone. */
function settle(p: PendingDelivery, outcome: Outcome, now: number): Promise<void> {
  return store.mutate((doc) => {
    const same = (q: PendingDelivery) => q.subId === p.subId && q.eventId === p.eventId;
    const sub = doc.subscriptions.find((s) => s.id === p.subId);
    if (outcome.kind === "revoked") {
      logger.info({ subscription: p.subId }, "MCP events: the subscription's credential no longer holds — subscription dropped");
      doc.subscriptions = doc.subscriptions.filter((s) => s.id !== p.subId);
      doc.pending = doc.pending.filter((q) => q.subId !== p.subId);
      return;
    }
    const pending = doc.pending.find(same);
    if (outcome.kind === "done") {
      doc.pending = doc.pending.filter((q) => !same(q));
      if (sub) Object.assign(sub, { lastDeliveryAt: now, lastError: undefined, failedSince: undefined });
      return;
    }
    if (sub && outcome.error) Object.assign(sub, { lastError: outcome.error, failedSince: sub.failedSince ?? now });
    if (outcome.kind === "drop" || !pending || pending.attempts + 1 >= WEBHOOKS.maxAttempts) {
      doc.pending = doc.pending.filter((q) => !same(q));
      return;
    }
    pending.attempts += 1;
    pending.nextAt = now + Math.round(WEBHOOKS.retryBaseMs * 2 ** (pending.attempts - 1) * (0.5 + Math.random() / 2));
  });
}

/**
 * Delivers what is due through a pool of `concurrency` slots: the next delivery starts as soon as one
 * ends, and no account holds more than `maxInFlightPerPrincipal` of them — a callback that hangs costs
 * its own account a slot, not everybody's deliveries.
 */
async function pumpOnce(now: number): Promise<void> {
  await enqueue(now);
  const doc = await store.load();
  const owner = new Map(doc.subscriptions.map((s) => [s.id, s.key]));
  const queue = doc.pending.filter((p) => p.nextAt <= now).sort((a, b) => a.seq - b.seq).map((p) => ({ ...p }));
  const busy = new Map<string, number>();
  const running = new Set<Promise<void>>();
  while (queue.length || running.size) {
    const next = running.size < WEBHOOKS.concurrency
      ? queue.findIndex((p) => (busy.get(owner.get(p.subId) ?? "") ?? 0) < WEBHOOKS.maxInFlightPerPrincipal)
      : -1;
    if (next < 0) {
      await Promise.race(running);
      continue;
    }
    const [p] = queue.splice(next, 1) as [PendingDelivery];
    const key = owner.get(p.subId) ?? "";
    busy.set(key, (busy.get(key) ?? 0) + 1);
    const job: Promise<void> = attempt(p, now)
      .catch((err: unknown): Outcome => {
        logger.warn({ subscription: p.subId, detail: (err as Error).message }, "MCP events: delivery attempt failed");
        return { kind: "retry", error: "connection_refused" };
      })
      .then((outcome) => settle(p, outcome, now))
      .catch((err: unknown) => logger.warn({ subscription: p.subId, detail: (err as Error).message }, "MCP events: could not record a delivery"))
      .finally(() => {
        busy.set(key, (busy.get(key) ?? 1) - 1);
        running.delete(job);
      });
    running.add(job);
  }
}

let pumping: Promise<void> = Promise.resolve();

/** One pass: reclaim, queue, deliver what is due. Passes run one after another, never two at once. */
export function pumpWebhooks(now?: number): Promise<void> {
  const run = () => pumpOnce(now ?? Date.now()).catch((err: unknown) => {
    logger.warn({ detail: (err as Error).message }, "MCP events: webhook pass failed");
  });
  pumping = pumping.then(run, run);
  return pumping;
}

/** Runs the deliveries: a pass right after every new board event, and a backstop tick. Returns the stop. */
export function startWebhookDispatcher(): () => void {
  let queued = false;
  const soon = () => {
    if (queued) return;
    queued = true;
    setImmediate(() => {
      queued = false;
      void pumpWebhooks();
    });
  };
  const off = onCardEvent(soon);
  const timer = setInterval(soon, WEBHOOKS.tickMs);
  timer.unref?.();
  soon();
  return () => {
    off();
    clearInterval(timer);
  };
}

/* ------------------------------------------------------------------ tests */

export async function listSubscriptionsForTesting(): Promise<StoredSubscription[]> {
  return (await store.load()).subscriptions;
}

export async function verifiedForTesting(): Promise<Record<string, number>> {
  return (await store.load()).verified;
}

export async function pendingForTesting(): Promise<PendingDelivery[]> {
  return (await store.load()).pending;
}
