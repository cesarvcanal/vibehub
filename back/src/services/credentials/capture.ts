import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { config } from "../../config/env.js";
import { hostExecutor } from "../../runtime/host.js";
import { cardBrowserPorts } from "../browser/ports.js";
import { markBrowserBusy } from "../browser/activity.js";
import { logger } from "../../utils/logger.js";
import { buildCdpHostScript, type FillResult } from "./fill.js";
import { createCredential, suggestCredentialName, type Credential } from "./credentials.js";

/**
 * CHROME-STYLE CAPTURE — watches a card's live Chromium for a login being submitted (by the person
 * driving, or by the agent), and offers to save it to the Cofre.
 *
 * A lightweight observer is injected into the page over CDP; on a form submit with a password field
 * it reports `{ url, username, password }` through a `Runtime.addBinding` channel. That report lands
 * on the CDP program's OWN stdout, which THIS module reads — it NEVER passes through the model, the
 * chat, the transcript or a log. The captured value is held server-side keyed by an opaque id; the
 * front only ever sees `{ id, host, suggestedName, username }` and, on "Save", the back turns the
 * held value into a named credential. The password never reaches the front either.
 */

interface PendingCapture {
  id: string;
  cardId: string;
  host: string;
  suggestedName: string;
  username: string;
  /** Held server-side only — never serialized to the front or a log. */
  password: string;
  at: number;
}

interface Listener {
  child: ChildProcessWithoutNullStreams;
  buffer: string;
}

/** At most this many un-actioned captures per card (newest win); keeps memory bounded. */
const MAX_PENDING_PER_CARD = 5;

const listeners = new Map<string, Listener>();
const pending = new Map<string, PendingCapture>();

/** Host in a form a person recognises ("erp.multi", "space") — drives the suggested name. PURE. */
export function hostFromUrl(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return String(url ?? "").replace(/^https?:\/\//i, "").split("/")[0] || "login";
  }
}

/** The public view of a pending capture — NEVER the password. PURE. */
export function publicCapture(c: PendingCapture): { id: string; host: string; suggestedName: string; username: string; at: number } {
  return { id: c.id, host: c.host, suggestedName: c.suggestedName, username: c.username, at: c.at };
}

/** Records one capture reported by the observer. Dedupes on host+username within a card. */
export function recordCapture(cardId: string, report: { url: string; username?: string; password?: string }): void {
  if (!report.password) return;
  const host = hostFromUrl(report.url);
  const username = String(report.username ?? "");
  // Drop an older pending for the same host+username on this card — the newest login is the truth.
  for (const [id, c] of pending) {
    if (c.cardId === cardId && c.host === host && c.username === username) pending.delete(id);
  }
  const entry: PendingCapture = {
    id: randomUUID().replace(/-/g, "").slice(0, 12),
    cardId,
    host,
    suggestedName: suggestCredentialName(host),
    username,
    password: report.password,
    at: Date.now(),
  };
  pending.set(entry.id, entry);
  // Trim to the cap for this card (oldest first).
  const mine = [...pending.values()].filter((c) => c.cardId === cardId).sort((a, b) => a.at - b.at);
  while (mine.length > MAX_PENDING_PER_CARD) {
    const drop = mine.shift();
    if (drop) pending.delete(drop.id);
  }
  logger.info(
    { audit: true, action: "credential.capture", card: cardId, host, hasUser: Boolean(username) },
    "login captured from a card browser (pending save)",
  );
}

/** The pending captures for a card, sanitized (no password). */
export function listCaptures(cardId: string): ReturnType<typeof publicCapture>[] {
  return [...pending.values()]
    .filter((c) => c.cardId === cardId)
    .sort((a, b) => b.at - a.at)
    .map(publicCapture);
}

/** Discards a pending capture without saving it. Returns whether it existed. */
export function dismissCapture(id: string): boolean {
  return pending.delete(id);
}

/**
 * Saves a pending capture as a named credential. The value comes from the server-held pending
 * record — it was never sent to the front. A capture with a username becomes a userpass credential;
 * one without becomes a token.
 */
export async function saveCapture(id: string, name: string | undefined, by?: string): Promise<Credential> {
  const c = pending.get(id);
  if (!c) throw new Error("this capture is no longer available");
  const finalName = (name?.trim() || c.suggestedName);
  const credential = c.username
    ? await createCredential({ name: finalName, type: "userpass", username: c.username, password: c.password }, by)
    : await createCredential({ name: finalName, type: "token", value: c.password }, by);
  pending.delete(id);
  return credential;
}

/** Parses NDJSON lines from the capture program's stdout, feeding each capture into the store. */
function consumeLines(cardId: string, listener: Listener, chunk: string): void {
  listener.buffer += chunk;
  let nl: number;
  while ((nl = listener.buffer.indexOf("\n")) >= 0) {
    const line = listener.buffer.slice(0, nl).trim();
    listener.buffer = listener.buffer.slice(nl + 1);
    if (!line) continue;
    let msg: { type?: string; url?: string; username?: string; password?: string; error?: string };
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (msg.type === "capture" && msg.url) {
      recordCapture(cardId, { url: msg.url, username: msg.username, password: msg.password });
    } else if (msg.type === "activity") {
      // Someone is clicking/typing in that browser right now — the card bar turns this into a lit
      // "Navegador" chip, which is the only way a browser session is visible from outside the pane.
      markBrowserBusy(cardId);
    } else if (msg.error) {
      logger.warn({ card: cardId, detail: msg.error }, "capture listener reported an error");
    }
  }
}

/**
 * Starts (idempotently) the capture listener for a card: a long-lived CDP program in the runner
 * that injects the observer and streams captures back. Failure-isolated — a capture that cannot
 * start must NEVER break opening the browser.
 */
export function startCapture(cardId: string): void {
  if (listeners.has(cardId)) return;
  try {
    const { cdpPort } = cardBrowserPorts(cardId);
    const payload = { mode: "capture", cdpPort };
    const payloadB64 = Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
    const tag = randomUUID().replace(/-/g, "");
    const script = buildCdpHostScript(config.runner.container, tag, payloadB64, { background: true });
    const { file, args } = hostExecutor().scriptCommand();
    const child = spawn(file, args, { stdio: ["pipe", "pipe", "pipe"] });
    const listener: Listener = { child, buffer: "" };
    listeners.set(cardId, listener);
    child.stdin.on("error", () => { /* torn down below */ });
    child.stdin.write(script);
    child.stdin.end();
    child.stdout.on("data", (d: Buffer) => consumeLines(cardId, listener, d.toString()));
    child.on("error", (err) => logger.warn({ card: cardId, err: err.message }, "capture listener failed to spawn"));
    child.on("close", () => { if (listeners.get(cardId) === listener) listeners.delete(cardId); });
    logger.info({ audit: true, action: "capture.start", card: cardId }, "credential capture listening on a card browser");
  } catch (err) {
    logger.warn({ card: cardId, err: (err as Error).message }, "could not start credential capture");
  }
}

/** Stops the capture listener for a card (browser closed). Idempotent. Keeps any pending captures. */
export function stopCapture(cardId: string): void {
  const listener = listeners.get(cardId);
  if (!listener) return;
  listeners.delete(cardId);
  try { listener.child.kill("SIGKILL"); } catch { /* ignore */ }
}

export function resetCaptureForTesting(): void {
  for (const l of listeners.values()) { try { l.child.kill("SIGKILL"); } catch { /* ignore */ } }
  listeners.clear();
  pending.clear();
}

// Re-exported so a single import point covers the whole feature where convenient.
export type { FillResult };
