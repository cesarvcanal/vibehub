/**
 * O QUE A LINHA DE COMPACTAÇÃO DIZ — o /compact (ou a automática) no chat.
 *
 * Rodando: o título (pedida ou automática) e o relógio. Terminada: o divisor "antes disto, só o
 * resumo" com quanto a conversa ocupava antes e depois, quanto liberou e quanto levou. Falhou: o
 * motivo do CLI. O desenho mora em components/SdkCompactionRow.tsx.
 */

import { t as translate } from "@/i18n";
import { formatDuration, formatTokens } from "@/features/board/lib/sdkDetail";
import type { SdkRow } from "@/features/board/lib/sdkChat";

type CompactionRow = Extract<SdkRow, { kind: "compaction" }>;

/** O que a linha precisa ler da compactação. */
export type CompactionView = Pick<CompactionRow, "status"> &
  Partial<Pick<CompactionRow, "trigger" | "preTokens" | "postTokens" | "durationMs" | "error">>;

/** O motivo que o driver manda quando o turno fechou com a compactação aberta. */
const DRIVER_INTERRUPTED = "interrompida";

/** Título e detalhes (cada um vira um pedaço separado por "·"). PURE. */
export function compactionSummary(row: CompactionView): { title: string; parts: string[] } {
  const auto = row.trigger === "auto";
  if (row.status === "running") {
    return { title: translate(auto ? "sdk.compactRunningAuto" : "sdk.compactRunning"), parts: [] };
  }
  if (row.status === "failed") {
    const reason = row.error && row.error !== DRIVER_INTERRUPTED ? row.error : translate("sdk.compactInterrupted");
    return { title: translate("sdk.compactFailed"), parts: [reason] };
  }
  const parts: string[] = [];
  const { preTokens: pre, postTokens: post } = row;
  if (pre !== undefined && post !== undefined) {
    parts.push(translate("sdk.compactTokens", { pre: formatTokens(pre), post: formatTokens(post) }));
    if (pre > 0 && post < pre) parts.push(translate("sdk.compactSaved", { percent: Math.round(((pre - post) / pre) * 100) }));
  } else if (pre !== undefined) {
    parts.push(translate("sdk.compactTokensPre", { pre: formatTokens(pre) }));
  }
  if (row.durationMs !== undefined) parts.push(formatDuration(row.durationMs));
  return { title: translate(auto ? "sdk.compactDoneAuto" : "sdk.compactDone"), parts };
}

/** O relógio da barra: `m:ss` desde `startedAt`, nunca negativo (relógios de máquinas diferentes). PURE. */
export function compactionElapsed(startedAt: number, now: number): string {
  const seconds = Math.max(0, Math.floor((now - startedAt) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
