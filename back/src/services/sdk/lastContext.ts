import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { dataPath } from "../../config/env.js";
import { writeFileAtomic } from "../../store/atomicWrite.js";
import { logger } from "../../utils/logger.js";
import { CARD_ID_RE } from "../board/cardId.js";
import { normalizeContextUsage, type ContextUsageInfo } from "./contextUsage.js";

/**
 * THE CARD'S LAST CONTEXT READING ON DISK, by the session it belongs to — the meter that outlives the back.
 *
 * The bug (production, 2026-11-16): "o contexto não aparece… eu preciso mandar mensagem para aparecer". The
 * reading only comes at the end of a turn, and the manager kept the last one only in memory: every deploy
 * restarts the back, so a card opened after a deploy (the merge of its own PR included) had no meter until
 * the next message. Here it survives the deploy, the idle stop and the pause; the route reads it before
 * bringing a driver up, and the manager only shows it when the driver resumes THAT session.
 *
 * A card's writes are CHAINED and COALESCED (a long turn sends a reading every ~5 s): at most one write in
 * flight and one queued, always the newest. The read waits for the card's queue.
 */

export const SDK_CONTEXT_DIR = "sdk-context";

export interface StoredContext {
  /** The session the reading measured — a different session does not inherit it. */
  sessionId: string;
  info: ContextUsageInfo;
}

function contextFile(cardId: string): string | null {
  if (!CARD_ID_RE.test(cardId)) return null;
  return dataPath(SDK_CONTEXT_DIR, `${cardId}.json`);
}

/** The file's text, checked — re-normalised by the back's own rule. PURE. */
function parseStoredContext(raw: string): StoredContext | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const { sessionId, info } = parsed as { sessionId?: unknown; info?: unknown };
  if (typeof sessionId !== "string" || sessionId === "") return null;
  const usage = normalizeContextUsage(info);
  return usage ? { sessionId, info: usage } : null;
}

/** Per card: the write in flight and the next content (null = delete the file). */
const writing = new Map<string, Promise<void>>();
const nextContent = new Map<string, string | null>();

async function writeNow(file: string, cardId: string, content: string | null): Promise<void> {
  try {
    if (content === null) {
      await rm(file, { force: true });
      return;
    }
    await mkdir(join(file, ".."), { recursive: true });
    await writeFileAtomic(file, content);
  } catch (err) {
    // No durability on this installation: the live session still holds the reading in memory.
    logger.warn({ card: cardId, detail: (err as Error).message }, "could not write the context reading");
  }
}

/** Stores the card's last reading (null deletes it). Never throws; resolves when it is on disk. */
export function saveLastContext(cardId: string, reading: StoredContext | null): Promise<void> {
  const file = contextFile(cardId);
  if (!file) return Promise.resolve();
  nextContent.set(cardId, reading ? JSON.stringify(reading) : null);
  const running = writing.get(cardId);
  if (running) return running;
  const loop = (async () => {
    while (nextContent.has(cardId)) {
      const content = nextContent.get(cardId)!;
      nextContent.delete(cardId);
      await writeNow(file, cardId, content);
    }
    writing.delete(cardId);
  })();
  writing.set(cardId, loop);
  return loop;
}

/** Resolves when the card's pending writes are on disk. */
export function lastContextSettled(cardId: string): Promise<void> {
  return writing.get(cardId) ?? Promise.resolve();
}

/** The card's last reading, or null (none, unreadable or crooked). Never throws. */
export async function readLastContext(cardId: string): Promise<StoredContext | null> {
  const file = contextFile(cardId);
  if (!file) return null;
  await lastContextSettled(cardId);
  try {
    return parseStoredContext(await readFile(file, "utf8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      logger.warn({ card: cardId, detail: (err as Error).message }, "could not read the context reading");
    }
    return null;
  }
}

/**
 * Deletes the card's reading — part of the PURGE (services/board/purge.ts). Throws when the rm fails, so
 * the purge reports the step instead of saying "apagado" over a file that stayed.
 */
export async function removeLastContext(cardId: string): Promise<void> {
  const file = contextFile(cardId);
  if (!file) return;
  await lastContextSettled(cardId);
  await rm(file, { force: true });
}
