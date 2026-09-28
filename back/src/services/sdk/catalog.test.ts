import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readCardCatalog, writeCardCatalog } from "./catalog.js";
import { config } from "../../config/env.js";

/**
 * O BUG DO CÉSAR (produção, 2026-09-28): "quando eu começava a digitar o /, de primeira não
 * apareciam as opções das skills ou plugins; eu tinha que apagar e tentar de novo ou dar F5".
 *
 * O menu "/" é alimentado pelo evento `catalog`, que o driver anuncia UMA vez, ao subir. Ele vivia
 * só na sessão em memória (`session.catalog`), então num card cujo driver ainda estava bootando —
 * ou que tinha acabado de ser hibernado — o primeiro `/` não tinha o que mostrar. Segundos depois o
 * catálogo chegava, e por isso "apagar e tentar de novo" resolvia: não era o menu que estava
 * quebrado, era a lista que ainda não existia.
 *
 * A lista de skills e comandos de um card muda de mês em mês, não de segundo em segundo. Guardá-la
 * em disco faz o menu existir no INSTANTE do connect, com a última lista conhecida, e o anúncio do
 * driver novo só a atualiza.
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

  it("sem nada em disco: nenhuma lista — e nunca uma exceção", async () => {
    expect(await readCardCatalog(CARD)).toBeNull();
  });

  it("gravado por um driver, lido pelo connect seguinte — sem driver nenhum no meio", async () => {
    await writeCardCatalog(CARD, CATALOG);
    expect(await readCardCatalog(CARD)).toEqual(CATALOG);
  });

  it("o anúncio do driver novo SUBSTITUI a lista antiga (skills entram e saem do projeto)", async () => {
    await writeCardCatalog(CARD, CATALOG);
    const novo = { type: "catalog" as const, commands: [{ name: "deploy", description: "Sobe pra prod" }] };
    await writeCardCatalog(CARD, novo);
    expect(await readCardCatalog(CARD)).toEqual(novo);
  });

  it("uma lista VAZIA não é gravada: ela apagaria um menu bom por um driver que subiu capenga", async () => {
    await writeCardCatalog(CARD, CATALOG);
    await writeCardCatalog(CARD, { type: "catalog", commands: [] });
    expect(await readCardCatalog(CARD)).toEqual(CATALOG);
  });

  it("arquivo corrompido não derruba o connect — é um menu vazio, não um erro", async () => {
    await writeCardCatalog(CARD, CATALOG);
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(dir, "sdk-catalog", `${CARD}.json`), "{ isso não é json", "utf8");
    expect(await readCardCatalog(CARD)).toBeNull();
  });

  it("id fora do formato de card nunca vira caminho de arquivo", async () => {
    expect(await readCardCatalog("../../etc/passwd")).toBeNull();
    await writeCardCatalog("../../etc/passwd", CATALOG); // não lança
  });
});
