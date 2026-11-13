import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { dataPath } from "../../config/env.js";
import { withBtwCommand, type CatalogEvent } from "./protocol.js";
import { CARD_ID_RE } from "../board/cardId.js";
import { logger } from "../../utils/logger.js";

/**
 * THE CARD'S CATALOG ON DISK — what the "/" menu offers, outliving the driver that announced it.
 *
 * The bug this closes (production, 2026-09-28): "quando eu começava a digitar o /, de primeira não
 * apareciam as opções das skills ou plugins; eu tinha que apagar e tentar de novo ou dar F5". The
 * catalog arrives in an event the driver announces ONCE, on boot, and it lived only in the in-memory
 * session (`session.catalog`). On a card whose driver was still booting — or had been hibernated
 * by the idle stop — the first `/` had no list at all to show. Seconds later the announcement
 * arrived, and that is why "apagar e tentar de novo" worked: the menu was never broken, the list
 * just did not exist yet.
 *
 * A card's skills and commands change month to month, not second to second — so the last known
 * list is a good answer for the instant of the connect, and the new driver's announcement merely
 * updates it. Same durability and same naming as `sdk-inflight`/`sdk-history`: one JSON per card
 * under the data dir.
 *
 * Reading and writing never throw: an empty menu is a setback, a dropped connection is a bug. Only
 * the purge's removal throws (see `removeCardCatalog`).
 */

/** Where the catalogs live, under the data dir. */
export const SDK_CATALOG_DIR = "sdk-catalog";

function catalogFile(cardId: string): string | null {
  if (!CARD_ID_RE.test(cardId)) return null;
  return dataPath(SDK_CATALOG_DIR, `${cardId}.json`);
}

/** This card's last known list — `null` when there is none (or the file is unreadable). */
export async function readCardCatalog(cardId: string): Promise<CatalogEvent | null> {
  const file = catalogFile(cardId);
  if (!file) return null;
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const event = parsed as CatalogEvent;
    if (event.type !== "catalog" || !Array.isArray(event.commands)) return null;
    // A file written before /btw existed does not have it — and the one that answers it is the panel, not the CLI.
    return { ...event, commands: withBtwCommand(event.commands) };
  } catch {
    return null; // no file, or a crooked file: the driver announces its own in a moment
  }
}

/**
 * Stores the list the driver has just announced.
 *
 * An EMPTY list is deliberately not stored: it would erase a good menu because of a driver that
 * came up crippled (no plugins mounted, a session that failed to load), and an empty menu is
 * exactly the symptom this module exists to avoid.
 */
export async function writeCardCatalog(cardId: string, catalog: CatalogEvent): Promise<void> {
  const file = catalogFile(cardId);
  if (!file) return;
  if (!Array.isArray(catalog.commands) || catalog.commands.length === 0) return;
  try {
    await mkdir(join(file, ".."), { recursive: true });
    await writeFile(file, JSON.stringify(catalog), "utf8");
  } catch (err) {
    // No durability on this installation: the in-memory session still serves this connection.
    logger.warn({ card: cardId, detail: (err as Error).message }, "could not write the sdk catalog");
  }
}

/**
 * Deletes the card's catalog — part of the PURGE (services/board/purge.ts). Throws when the rm fails, so
 * the purge reports the step instead of saying "apagado" over a file that stayed.
 */
export async function removeCardCatalog(cardId: string): Promise<void> {
  const file = catalogFile(cardId);
  if (!file) return;
  await rm(file, { force: true });
}
