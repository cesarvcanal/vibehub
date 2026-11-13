import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readCardCatalog, writeCardCatalog } from "./catalog.js";
import { config } from "../../config/env.js";
import { withBtwCommand, type CatalogEvent } from "./protocol.js";

/**
 * CÉSAR'S BUG (production, 2026-09-28): "quando eu começava a digitar o /, de primeira não
 * apareciam as opções das skills ou plugins; eu tinha que apagar e tentar de novo ou dar F5".
 *
 * The "/" menu is fed by the `catalog` event, which the driver announces ONCE, on boot. It lived
 * only in the in-memory session (`session.catalog`), so on a card whose driver was still booting —
 * or had just been hibernated — the first `/` had nothing to show. Seconds later the catalog
 * arrived, which is why "apagar e tentar de novo" worked: it was not the menu that was broken, it
 * was the list that did not exist yet.
 *
 * A card's list of skills and commands changes month to month, not second to second. Keeping it on
 * disk makes the menu exist at the INSTANT of the connect, with the last known list, and the new
 * driver's announcement only updates it.
 */

const CARD = "56fc53c6-ff44-484c-b2c3-e5576b6760e7";

let dir = "";
let savedDataDir = "";
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "vibehub-catalog-"));
  savedDataDir = config.dataDir;
  config.dataDir = dir;
});
afterEach(async () => {
  config.dataDir = savedDataDir;
  await rm(dir, { recursive: true, force: true });
});

describe("o catálogo do card sobrevive ao driver (o menu '/' que não abria de primeira)", () => {
  const CATALOG = {
    type: "catalog" as const,
    commands: [
      { name: "code-review", description: "Revisa o diff" },
      { name: "superpowers:systematic-debugging", description: "Depuração sistemática" },
    ],
  };

  /** What the connect delivers: the stored list, always with /btw (the panel is the one that answers it). */
  const menu = (catalog: CatalogEvent): CatalogEvent => ({ ...catalog, commands: withBtwCommand(catalog.commands) });

  it("um arquivo gravado antes do /btw existir também o oferece — sem esperar o driver anunciar", async () => {
    await writeCardCatalog(CARD, CATALOG);
    expect((await readCardCatalog(CARD))?.commands.map((c) => c.name)).toEqual([
      "code-review", "superpowers:systematic-debugging", "btw",
    ]);
  });

  it("sem nada em disco: nenhuma lista — e nunca uma exceção", async () => {
    expect(await readCardCatalog(CARD)).toBeNull();
  });

  it("gravado por um driver, lido pelo connect seguinte — sem driver nenhum no meio", async () => {
    await writeCardCatalog(CARD, CATALOG);
    expect(await readCardCatalog(CARD)).toEqual(menu(CATALOG));
  });

  it("o anúncio do driver novo SUBSTITUI a lista antiga (skills entram e saem do projeto)", async () => {
    await writeCardCatalog(CARD, CATALOG);
    const novo = { type: "catalog" as const, commands: [{ name: "deploy", description: "Sobe pra prod" }] };
    await writeCardCatalog(CARD, novo);
    expect(await readCardCatalog(CARD)).toEqual(menu(novo));
  });

  it("uma lista VAZIA não é gravada: ela apagaria um menu bom por um driver que subiu capenga", async () => {
    await writeCardCatalog(CARD, CATALOG);
    await writeCardCatalog(CARD, { type: "catalog", commands: [] });
    expect(await readCardCatalog(CARD)).toEqual(menu(CATALOG));
  });

  it("arquivo corrompido não derruba o connect — é um menu vazio, não um erro", async () => {
    await writeCardCatalog(CARD, CATALOG);
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(dir, "sdk-catalog", `${CARD}.json`), "{ isso não é json", "utf8");
    expect(await readCardCatalog(CARD)).toBeNull();
  });

  it("id fora do formato de card nunca vira caminho de arquivo", async () => {
    expect(await readCardCatalog("../../etc/passwd")).toBeNull();
    await writeCardCatalog("../../etc/passwd", CATALOG); // does not throw
  });
});
