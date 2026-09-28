import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { dataPath } from "../../config/env.js";
import type { CatalogEvent } from "./protocol.js";

/**
 * O CATÁLOGO DO CARD EM DISCO — o que o menu "/" oferece, sobrevivendo ao driver que o anunciou.
 *
 * O bug que isto fecha (produção, 2026-09-28): "quando eu começava a digitar o /, de primeira não
 * apareciam as opções das skills ou plugins; eu tinha que apagar e tentar de novo ou dar F5". O
 * catálogo chega num evento que o driver anuncia UMA vez, ao subir, e vivia só na sessão em memória
 * (`session.catalog`). Num card cujo driver ainda estava bootando — ou que tinha sido hibernado
 * pelo idle stop — o primeiro `/` não tinha lista nenhuma para mostrar. Segundos depois o anúncio
 * chegava, e era por isso que "apagar e tentar de novo" resolvia: o menu nunca esteve quebrado, a
 * lista é que ainda não existia.
 *
 * As skills e comandos de um card mudam de mês em mês, não de segundo em segundo — então a última
 * lista conhecida é uma resposta boa para o instante do connect, e o anúncio do driver novo apenas
 * a atualiza. Mesma durabilidade e mesmo formato de nome do `sdk-inflight`/`sdk-history`: um JSON
 * por card sob o data dir.
 *
 * Nada aqui lança: um menu vazio é um contratempo, uma conexão derrubada é um bug.
 */

/** Onde os catálogos vivem, sob o data dir. */
export const SDK_CATALOG_DIR = "sdk-catalog";

/** Mesma regra do sdk-history: o id do card nomeia um arquivo, então só valores id-shaped passam. */
const CARD_ID_RE = /^[0-9a-zA-Z-]{8,64}$/;

function catalogFile(cardId: string): string | null {
  if (!CARD_ID_RE.test(cardId)) return null;
  return dataPath(SDK_CATALOG_DIR, `${cardId}.json`);
}

/** A última lista conhecida deste card — `null` quando não há nenhuma (ou o arquivo está ilegível). */
export async function readCardCatalog(cardId: string): Promise<CatalogEvent | null> {
  const file = catalogFile(cardId);
  if (!file) return null;
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const event = parsed as CatalogEvent;
    if (event.type !== "catalog" || !Array.isArray(event.commands)) return null;
    return event;
  } catch {
    return null; // sem arquivo, ou um arquivo torto: o driver anuncia o dele daqui a pouco
  }
}

/**
 * Guarda a lista que o driver acabou de anunciar.
 *
 * Uma lista VAZIA não é gravada de propósito: ela apagaria um menu bom por causa de um driver que
 * subiu capenga (sem plugins montados, uma sessão que falhou o carregamento), e um menu vazio é
 * exatamente o sintoma que este módulo existe para não ter.
 */
export async function writeCardCatalog(cardId: string, catalog: CatalogEvent): Promise<void> {
  const file = catalogFile(cardId);
  if (!file) return;
  if (!Array.isArray(catalog.commands) || catalog.commands.length === 0) return;
  try {
    await mkdir(join(file, ".."), { recursive: true });
    await writeFile(file, JSON.stringify(catalog), "utf8");
  } catch {
    /* sem durabilidade nesta instalação: a sessão em memória ainda serve esta conexão */
  }
}
