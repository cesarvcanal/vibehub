/**
 * QUANTO DA JANELA DE CONTEXTO A SESSÃO JÁ OCUPA — o número do `/context` do Claude Code. O driver
 * pergunta à sessão no fim de cada turno (`getContextUsage`) e repassa como `context_usage`.
 *
 * Normalizado AQUI, no lado que fala com o navegador: a tela recebe sempre tokens inteiros e um
 * percentual 0..100 calculado sobre a janela CRUA do modelo (200k, 1M), o mesmo denominador do
 * "84k/200k" que ela escreve ao lado.
 */

export interface ContextUsageInfo {
  /** Tokens que a conversa ocupa agora. */
  usedTokens: number;
  /** O tamanho da janela do modelo, cru. */
  maxTokens: number;
  /** 0..100. */
  percent: number;
  model?: string;
}

export interface ContextUsageEvent extends ContextUsageInfo { type: "context_usage" }

function tokens(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
  return Math.round(value);
}

/** O que chegou do driver como `ContextUsageInfo`, ou null quando não há janela para medir. PURE. */
export function normalizeContextUsage(raw: unknown): ContextUsageInfo | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const used = tokens(o.usedTokens);
  const max = tokens(o.maxTokens);
  if (used === undefined || max === undefined || max === 0) return null;
  const percent = Math.min(100, (used / max) * 100);
  const model = typeof o.model === "string" && o.model.trim() ? o.model.trim().slice(0, 128) : undefined;
  return { usedTokens: used, maxTokens: max, percent, ...(model ? { model } : {}) };
}
