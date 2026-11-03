/**
 * O RASCUNHO DE CADA CARTÃO DE PERGUNTA — o que a pessoa já marcou e escreveu num AskUserQuestion
 * que ainda não respondeu — guardado no localStorage, por card e por pergunta.
 *
 * Por que no disco: todo (re)connect limpa a tela e o replay redesenha o cartão, que desmonta e
 * remonta (produção, 2026-10-07, a primeira versão: um mapa do módulo, que bastava para isso). Mas
 * um deploy também RECARREGA a aba — a versão nova manda o F5 sozinho (lib/versionCheck.ts) — e o
 * mapa do módulo morre com ele: quatro perguntas marcadas viravam um cartão em branco (produção,
 * 2026-11-03). O localStorage é o que um F5 não apaga, como o rascunho do composer e o outbox.
 *
 * A chave é card + pergunta: o id vem do driver (`q_<n>_<ms>`) e dois cards podem gerar o mesmo.
 *
 * Guardado também DEPOIS do clique em "Responder": o "respondida" da tela é otimista, e se o fio
 * cair junto com o driver antes da confirmação o replay redesenha o cartão pendente — com o que já
 * estava marcado. Por isso ninguém apaga na resposta: o que sai é o velho (`QUESTION_DRAFT_TTL_MS`)
 * e o excesso (`QUESTION_DRAFTS_MAX`, os mais antigos primeiro), a cada gravação.
 *
 * Nunca lança: localStorage bloqueado (modo privado, cota) só tira a durabilidade — a memória da
 * aba segura o rascunho enquanto ela estiver aberta.
 */

import { isEmptyDraft, type QuestionDraft } from "@/features/board/lib/peerQuestionDraft";

const STORAGE_KEY = "vibehub.questionDrafts";

/** Quantos cartões o disco guarda, no máximo. */
export const QUESTION_DRAFTS_MAX = 50;

/** Depois disso o rascunho sai: a pergunta já encerrou há muito (o prazo do cartão é 30 min). */
export const QUESTION_DRAFT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

interface StoredQuestionDraft {
  picked: string[][];
  other: string[];
  /** Quando a pessoa fez a mudança (epoch ms) — a ordem da poda, e o que decide contra a versão do servidor. */
  at: number;
}

/** A memória da aba: vale primeiro, e é o que sobra com o localStorage bloqueado. */
const memory = new Map<string, StoredQuestionDraft>();

function keyOf(cardId: string, questionId: string): string {
  return `${cardId}:${questionId}`;
}

const strings = (value: unknown): string[] | null =>
  Array.isArray(value) && value.every((v) => typeof v === "string") ? (value as string[]) : null;

/** Uma entrada do disco, conferida — localStorage é entrada não confiável. PURE. */
function parseEntry(value: unknown): StoredQuestionDraft | null {
  if (!value || typeof value !== "object") return null;
  const { picked, other, at } = value as { picked?: unknown; other?: unknown; at?: unknown };
  if (!Array.isArray(picked) || typeof at !== "number") return null;
  const pickedLists = picked.map(strings);
  const otherList = strings(other);
  if (pickedLists.some((p) => p === null) || otherList === null) return null;
  return { picked: pickedLists as string[][], other: otherList, at };
}

function readStored(): Record<string, StoredQuestionDraft> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, StoredQuestionDraft> = {};
    for (const [key, value] of Object.entries(parsed)) {
      const entry = parseEntry(value);
      if (entry) out[key] = entry;
    }
    return out;
  } catch {
    return {};
  }
}

function writeStored(drafts: Record<string, StoredQuestionDraft>): void {
  try {
    if (Object.keys(drafts).length === 0) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, JSON.stringify(drafts));
  } catch {
    /* a memória da aba ainda segura o rascunho */
  }
}

/** Sem o velho e sem o excesso — os mais recentes ficam. PURE. */
export function pruneQuestionDrafts<T extends { at: number }>(drafts: Record<string, T>, now: number): Record<string, T> {
  const kept = Object.entries(drafts)
    .filter(([, d]) => now - d.at <= QUESTION_DRAFT_TTL_MS)
    .sort(([, a], [, b]) => b.at - a.at)
    .slice(0, QUESTION_DRAFTS_MAX);
  return Object.fromEntries(kept);
}

/** O rascunho deste cartão, com o horário da última mudança: o da aba, ou o do disco (depois de um F5), ou nada. */
export function readQuestionDraft(cardId: string, questionId: string): (QuestionDraft & { at: number }) | undefined {
  const key = keyOf(cardId, questionId);
  const live = memory.get(key);
  if (live) return live;
  return readStored()[key];
}

/**
 * Grava o rascunho de agora. `draft.at` é QUANDO a pessoa mudou (ausente = agora): regravar o mesmo
 * conteúdo não o rejuvenesce — senão um rascunho velho passaria por novo diante do servidor. Vazio =
 * a pessoa desmarcou e apagou tudo: a entrada sai.
 */
export function writeQuestionDraft(cardId: string, questionId: string, draft: QuestionDraft, now: number = Date.now()): void {
  const key = keyOf(cardId, questionId);
  const stored = readStored();
  if (isEmptyDraft(draft)) {
    memory.delete(key);
    if (!(key in stored)) return;
    delete stored[key];
  } else {
    const entry: StoredQuestionDraft = { picked: draft.picked, other: draft.other, at: draft.at ?? now };
    memory.set(key, entry);
    stored[key] = entry;
  }
  writeStored(pruneQuestionDrafts(stored, now));
}

/** Test hook: esquece a memória da aba — exatamente o que um F5 apaga (o localStorage fica). */
export function forgetQuestionDraftMemoryForTesting(): void {
  memory.clear();
}
