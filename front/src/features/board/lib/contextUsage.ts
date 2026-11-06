/**
 * QUANTO DA JANELA DE CONTEXTO A CONVERSA JÁ OCUPA — o medidor ao lado do "está digitando" no chat.
 *
 * A régua é de QUALIDADE, não de capacidade: o modelo não "trava" perto do fim da janela, ele piora
 * bem antes — esquece instrução do começo, repete erro, confunde arquivo. Por isso as faixas são
 * baixas comparadas com o limite (o auto-compact do CLI só entra perto de ~80%):
 *
 *   0–30%   inteligente   a conversa cabe folgada; o modelo segura tudo que foi dito
 *   30–60%  preocupante   já perde detalhe do início; bom momento para fechar a etapa ou /compact
 *   60%+    perigoso      respostas piores e mais erro; /compact ou um card novo
 *
 * A cor NÃO pula na fronteira: o matiz desliza entre âncoras (verde → amarelo em 30% → laranja →
 * vermelho em 60%), então o medidor vai esquentando conforme a conversa cresce.
 */

/** A conversa deixa de estar folgada aqui. */
export const CONTEXT_WARN_AT = 30;
/** Daqui pra cima a qualidade cai de verdade. */
export const CONTEXT_DANGER_AT = 60;

export type ContextZone = "smart" | "warn" | "danger";

/** A última leitura que o back mandou (ver back/src/services/sdk/contextUsage.ts). */
export interface ContextUsageInfo {
  usedTokens: number;
  maxTokens: number;
  /** 0..100 */
  percent: number;
  model?: string;
}

/** A faixa de um percentual. PURE. */
export function contextZone(percent: number): ContextZone {
  const pct = Number.isFinite(percent) ? percent : 0;
  if (pct >= CONTEXT_DANGER_AT) return "danger";
  if (pct >= CONTEXT_WARN_AT) return "warn";
  return "smart";
}

/**
 * Âncoras do matiz. Verde firme até 15%; dali desliza para chegar AMARELO em 30% (a fronteira do
 * preocupante), laranja no meio da faixa e VERMELHO em 60%, onde o perigoso começa.
 */
const HUE_STOPS: readonly (readonly [pct: number, hue: number])[] = [
  [15, 142],
  [30, 48],
  [45, 30],
  [60, 6],
  [100, 0],
];

/** O matiz (hsl) de um percentual, contínuo. PURE. */
export function contextHue(percent: number): number {
  const pct = Math.min(100, Math.max(0, Number.isFinite(percent) ? percent : 0));
  if (pct <= HUE_STOPS[0]![0]) return HUE_STOPS[0]![1];
  for (let i = 1; i < HUE_STOPS.length; i++) {
    const [p1, h1] = HUE_STOPS[i]!;
    if (pct <= p1) {
      const [p0, h0] = HUE_STOPS[i - 1]!;
      return Math.round(h0 + ((pct - p0) / (p1 - p0)) * (h1 - h0));
    }
  }
  return 0;
}

/** `hsl(…)` do percentual, com alfa opcional (0..1). PURE. */
export function contextColor(percent: number, alpha = 1): string {
  return `hsl(${contextHue(percent)} 80% 48% / ${alpha})`;
}

/** O degradê inteiro da régua, do frio ao quente — o mesmo caminho que a cor do medidor percorre. */
export function contextGradient(): string {
  const stops = [0, 15, 30, 45, 60, 100].map((p) => `${contextColor(p)} ${p}%`);
  return `linear-gradient(to right, ${stops.join(", ")})`;
}

/** O que chegou no socket como leitura, ou null quando não dá para medir nada. PURE. */
export function parseContextUsage(raw: { usedTokens?: unknown; maxTokens?: unknown; percent?: unknown; model?: unknown }): ContextUsageInfo | null {
  const { usedTokens, maxTokens, percent, model } = raw;
  if (typeof usedTokens !== "number" || !Number.isFinite(usedTokens) || usedTokens < 0) return null;
  if (typeof maxTokens !== "number" || !Number.isFinite(maxTokens) || maxTokens <= 0) return null;
  const pct = typeof percent === "number" && Number.isFinite(percent) ? percent : (usedTokens / maxTokens) * 100;
  return {
    usedTokens,
    maxTokens,
    percent: Math.min(100, Math.max(0, pct)),
    ...(typeof model === "string" && model ? { model } : {}),
  };
}
