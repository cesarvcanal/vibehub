import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { dataPath } from "../../config/env.js";
import { logger } from "../../utils/logger.js";
import { CARD_ID_RE } from "../board/cardId.js";

/**
 * O QUE CADA PESSOA JÁ MARCOU num cartão de pergunta aberto, em DISCO — por card, pergunta e nome.
 *
 * O incidente (produção, 2026-11-03): quatro perguntas marcadas, um deploy, tudo em branco. O manager
 * guardava os rascunhos só em memória (para quem abre o card no meio da resposta de outra pessoa) e
 * o deploy reinicia o back. Aqui eles sobrevivem ao deploy, à aba fechada e à troca de aparelho — o
 * que eu marquei, o que os outros marcaram — até a pergunta encerrar (`forgetQuestionDrafts`).
 *
 * As gravações de um card são ENCADEADAS e COALESCIDAS: um rascunho chega a cada ~150 ms enquanto
 * alguém digita, e só o último estado importa — no máximo uma escrita em voo e uma na fila, sempre a
 * mais nova. A leitura espera a fila do card: o driver sucessor não pode ler um arquivo velho.
 */

export const SDK_QUESTION_DRAFTS_DIR = "sdk-question-drafts";

export interface StoredQuestionDraft {
  picked: string[][];
  other: string[];
  /** Quando a pessoa fez a mudança (relógio do navegador dela) — a mais nova vence. */
  at?: number;
}

/** `id da pergunta → nome → rascunho`. */
export type CardQuestionDrafts = Map<string, Map<string, StoredQuestionDraft>>;

function draftsFile(cardId: string): string {
  if (!CARD_ID_RE.test(cardId)) throw new Error(`invalid card id for question drafts: '${cardId}'`);
  return dataPath(SDK_QUESTION_DRAFTS_DIR, `${cardId}.json`);
}

const strings = (value: unknown): string[] | null =>
  Array.isArray(value) && value.every((v) => typeof v === "string") ? (value as string[]) : null;

/** Um rascunho do disco, conferido. PURE. */
function parseDraft(value: unknown): StoredQuestionDraft | null {
  if (!value || typeof value !== "object") return null;
  const { picked, other, at } = value as { picked?: unknown; other?: unknown; at?: unknown };
  if (!Array.isArray(picked)) return null;
  const pickedLists = picked.map(strings);
  const otherList = strings(other);
  if (pickedLists.some((p) => p === null) || otherList === null) return null;
  return { picked: pickedLists as string[][], other: otherList, ...(typeof at === "number" && Number.isFinite(at) ? { at } : {}) };
}

/** O conteúdo do arquivo, ou null quando não há nada a guardar. PURE. */
export function serializeQuestionDrafts(drafts: CardQuestionDrafts): string | null {
  const out: Record<string, Record<string, StoredQuestionDraft>> = {};
  for (const [id, byName] of drafts) {
    if (byName.size === 0) continue;
    out[id] = Object.fromEntries(byName);
  }
  return Object.keys(out).length === 0 ? null : JSON.stringify(out);
}

/** O texto do arquivo, conferido — o que não bate é ignorado, nunca lança. PURE. */
export function parseQuestionDrafts(raw: string): CardQuestionDrafts {
  const drafts: CardQuestionDrafts = new Map();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return drafts;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return drafts;
  for (const [id, byName] of Object.entries(parsed)) {
    if (!byName || typeof byName !== "object" || Array.isArray(byName)) continue;
    const names = new Map<string, StoredQuestionDraft>();
    for (const [name, value] of Object.entries(byName)) {
      const draft = parseDraft(value);
      if (draft && name !== "") names.set(name, draft);
    }
    if (names.size > 0) drafts.set(id, names);
  }
  return drafts;
}

/** Por card: a escrita em voo e o próximo conteúdo (null = apagar o arquivo). */
const writing = new Map<string, Promise<void>>();
const nextContent = new Map<string, string | null>();

async function writeNow(cardId: string, content: string | null): Promise<void> {
  try {
    const file = draftsFile(cardId);
    if (content === null) {
      await rm(file, { force: true });
      return;
    }
    await mkdir(join(file, ".."), { recursive: true });
    await writeFile(file, content, "utf8");
  } catch (err) {
    logger.warn({ card: cardId, detail: (err as Error).message }, "could not write the question drafts");
  }
}

/** Grava o estado de agora dos rascunhos do card. Nunca lança; a promessa resolve quando estiver em disco. */
export function saveQuestionDrafts(cardId: string, drafts: CardQuestionDrafts): Promise<void> {
  nextContent.set(cardId, serializeQuestionDrafts(drafts));
  const running = writing.get(cardId);
  if (running) return running;
  const loop = (async () => {
    while (nextContent.has(cardId)) {
      const content = nextContent.get(cardId)!;
      nextContent.delete(cardId);
      await writeNow(cardId, content);
    }
    writing.delete(cardId);
  })();
  writing.set(cardId, loop);
  return loop;
}

/** Os rascunhos guardados do card (vazio quando não há, ou quando o arquivo não se lê). Nunca lança. */
export async function loadQuestionDrafts(cardId: string): Promise<CardQuestionDrafts> {
  await writing.get(cardId);
  try {
    return parseQuestionDrafts(await readFile(draftsFile(cardId), "utf8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      logger.warn({ card: cardId, detail: (err as Error).message }, "could not read the question drafts");
    }
    return new Map();
  }
}

/** Resolve quando as gravações pendentes do card estiverem em disco. */
export function questionDraftsSettled(cardId: string): Promise<void> {
  return writing.get(cardId) ?? Promise.resolve();
}

/** O card foi apagado: os rascunhos dele também. Nunca lança. */
export async function removeQuestionDrafts(cardId: string): Promise<void> {
  nextContent.set(cardId, null);
  await (writing.get(cardId) ?? saveQuestionDrafts(cardId, new Map()));
}
