import * as React from "react";
import { t as translate } from "@/i18n";
import type { AgentTask, SdkRow, ToolResultSummary } from "@/features/board/lib/sdkChat";

/**
 * VER O QUE O CLAUDE ESTÁ FAZENDO — as regras puras do detalhe que abre quando se clica numa ação,
 * num subagente ou em "Mudanças", e o canal que pede esse detalhe ao back.
 *
 * O chat recebe só o RESUMO de cada resultado; o resto é pedido sob demanda pelo websocket
 * (`{ type: "detail", req }`) e o back lê do transcript da sessão no runner
 * (back/src/services/sdk/detail.ts). A resposta volta só para esta aba e nunca passa pelo reducer.
 */

/* ------------------------------------------------------------ a linha de resultado */

/** Duração legível: `850 ms`, `4,2 s`, `1m 24s`, `3h 07m`. PURE. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1).replace(".", translate("sdk.result.decimal"))} s`;
  const whole = Math.floor(s);
  const minutes = Math.floor(whole / 60);
  if (minutes < 60) return `${minutes}m ${String(whole % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/** Quantos tokens, curto: `900`, `41 mil` / `41k`. PURE. */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n < 1000) return String(Math.max(0, Math.round(n || 0)));
  return translate("sdk.result.thousands", { n: Math.round(n / 1000) });
}

/**
 * A LINHA DE RESULTADO de uma ação, como a do terminal: "7 linhas", "+3 −1", "linhas 60–80 de 290",
 * "9 ocorrências em 7 arquivos", "sem saída", "erro: …". Null = nada a dizer. PURE.
 */
export function toolResultLine(name: string, r: ToolResultSummary | undefined): string | null {
  if (!r) return null;
  if (r.isError) return translate("sdk.result.error", { error: r.error || "error" });
  if (r.background) return translate("sdk.result.background");
  if (r.agent) {
    const parts = [
      typeof r.agent.toolUses === "number" ? translate("sdk.result.actions", { n: r.agent.toolUses }) : null,
      typeof r.agent.durationMs === "number" ? formatDuration(r.agent.durationMs) : null,
    ].filter(Boolean);
    return parts.length ? `${translate("sdk.result.agentDone")} · ${parts.join(" · ")}` : translate("sdk.result.agentDone");
  }
  if (r.created) return translate("sdk.result.created", { n: r.added ?? 0 });
  if (typeof r.added === "number" || typeof r.removed === "number") return `+${r.added ?? 0} −${r.removed ?? 0}`;
  if (name === "Read" && typeof r.lines === "number") {
    if (typeof r.startLine === "number" && typeof r.totalLines === "number" && (r.startLine > 1 || r.lines < r.totalLines)) {
      return translate("sdk.result.readRange", { from: r.startLine, to: r.startLine + Math.max(0, r.lines - 1), total: r.totalLines });
    }
    return translate("sdk.result.readLines", { n: r.lines });
  }
  if (typeof r.files === "number") {
    if (typeof r.matches === "number") return translate("sdk.result.matches", { n: r.matches, files: r.files });
    return r.files === 0 ? translate("sdk.result.nothingFound") : translate("sdk.result.files", { n: r.files });
  }
  const interrupted = r.interrupted ? ` · ${translate("sdk.result.interrupted")}` : "";
  if (r.empty) return translate(name === "Bash" ? "sdk.result.noOutput" : "sdk.result.empty") + interrupted;
  if (typeof r.lines === "number") return translate("sdk.result.lines", { n: r.lines }) + interrupted;
  return null;
}

/** Em que pé uma ação está, para o ícone. PURE. */
export type ToolStatus = "running" | "ok" | "error" | "unknown";

export function toolStatus(row: Extract<SdkRow, { kind: "tool" }>): ToolStatus {
  if (row.pending) return "running";
  if (row.result) return row.result.isError ? "error" : "ok";
  return row.live ? "running" : "unknown";
}

/* ------------------------------------------------------------------- subagentes */

/** Em que pé um subagente está: o estado da tarefa manda; sem ela, o resultado da chamada. PURE. */
export function agentStatus(row: Extract<SdkRow, { kind: "tool" }>, task: AgentTask | undefined): ToolStatus {
  if (task) return task.status === "running" ? "running" : task.status === "completed" ? "ok" : "error";
  if (row.result) {
    if (row.result.isError) return "error";
    return row.result.background ? (row.live ? "running" : "unknown") : "ok";
  }
  return row.live ? "running" : "unknown";
}

/**
 * Silêncio do subagente além do qual o relógio para: quem morreu sem aviso não conta para sempre.
 * O mesmo teto do back (TASK_CLOCK_STALE_MS em back/src/services/sdk/toolResult.ts).
 */
export const AGENT_CLOCK_STALE_MS = 30 * 60_000;

/**
 * Há quanto tempo o subagente trabalha. O back manda, em todo frame, o tempo até aquele instante
 * no relógio dele; rodando, a aba soma o tempo desde que recebeu o frame, no relógio DELA (sem
 * diferença entre os dois), até o teto de silêncio — que já começa gasto pelo `quietMs` com que o
 * frame saiu. Terminado, a duração final. Rodando, em segundos inteiros: um relógio que anda de
 * segundo em segundo não mostra décimos. PURE.
 */
export function agentElapsedMs(
  status: ToolStatus,
  task: AgentTask | undefined,
  result: ToolResultSummary["agent"] | undefined,
  now: number,
): number | undefined {
  const measured = task?.durationMs ?? result?.durationMs;
  if (status !== "running" || task?.receivedAt === undefined) return measured;
  const budget = Math.max(0, AGENT_CLOCK_STALE_MS - (task.quietMs ?? 0));
  const silence = Math.min(Math.max(0, now - task.receivedAt), budget);
  return Math.floor(((measured ?? 0) + silence) / 1000) * 1000;
}

/** O nome de um subagente pela chamada: a descrição que o modelo deu, senão o tipo. PURE. */
export function agentName(input: unknown): string {
  const o = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const pick = [o.description, o.subagent_type, o.name].find((v) => typeof v === "string" && v.trim() !== "");
  return typeof pick === "string" ? pick.trim() : "Agent";
}

/* ---------------------------------------------------------------- o canal */

/** As respostas do back, como chegam (`data` é o que a sondagem leu; `error` diz por que não). */
export interface DetailResponse {
  type: "detail";
  req: "tool" | "agent" | "changes" | "file";
  id?: string;
  path?: string;
  nonce?: string;
  data?: unknown;
  error?: string;
}

export interface DetailRequestFrame {
  type: "detail";
  req: DetailResponse["req"];
  id?: string;
  path?: string;
  nonce: string;
}

export interface DetailChannel {
  /** Pede; devolve o `nonce` do pedido, ou null quando o socket está fechado. */
  request(req: DetailResponse["req"], opts?: { id?: string; path?: string }): string | null;
  subscribe(listener: (response: DetailResponse) => void): () => void;
  deliver(response: DetailResponse): void;
}

let nonceSeq = 0;

export function createDetailChannel(send: (frame: DetailRequestFrame) => void): DetailChannel {
  const listeners = new Set<(response: DetailResponse) => void>();
  return {
    request(req, opts = {}) {
      nonceSeq += 1;
      const nonce = `d${nonceSeq}`;
      try {
        send({ type: "detail", req, ...(opts.id ? { id: opts.id } : {}), ...(opts.path ? { path: opts.path } : {}), nonce });
        return nonce;
      } catch {
        return null;
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    deliver(response) {
      for (const listener of listeners) listener(response);
    },
  };
}

/** Lê uma resposta de detalhe vinda do socket; forma torta vira null. PURE. */
export function parseDetailResponse(event: { type?: string; req?: unknown; id?: unknown; path?: unknown; nonce?: unknown; data?: unknown; error?: unknown }): DetailResponse | null {
  if (event.type !== "detail") return null;
  if (event.req !== "tool" && event.req !== "agent" && event.req !== "changes" && event.req !== "file") return null;
  return {
    type: "detail",
    req: event.req,
    ...(typeof event.id === "string" ? { id: event.id } : {}),
    ...(typeof event.path === "string" ? { path: event.path } : {}),
    ...(typeof event.nonce === "string" ? { nonce: event.nonce } : {}),
    ...(event.data !== undefined ? { data: event.data } : {}),
    ...(typeof event.error === "string" ? { error: event.error } : {}),
  };
}

export const DetailChannelContext = React.createContext<DetailChannel | null>(null);

/**
 * Pede uma vez e escuta a resposta (e, com `pollMs`, pede de novo enquanto aberto). `key` muda =
 * pedido novo. Devolve o último dado e o estado do pedido.
 */
export function useDetail<T>(
  req: DetailResponse["req"],
  opts: { id?: string; path?: string },
  key: string | null,
  pollMs?: number,
): { data: T | null; loading: boolean; error: string | null } {
  const channel = React.useContext(DetailChannelContext);
  const [state, setState] = React.useState<{ key: string | null; data: T | null; loading: boolean; error: string | null }>({ key: null, data: null, loading: false, error: null });
  const id = opts.id;
  const path = opts.path;
  React.useEffect(() => {
    if (!channel || key === null) return;
    let alive = true;
    let pending: string | null = null;
    setState((prev) => (prev.key === key ? prev : { key, data: null, loading: true, error: null }));
    const ask = (): void => {
      pending = channel.request(req, { id, path });
      if (pending === null) setState((prev) => ({ ...prev, key, loading: false, error: prev.data ? null : "offline" }));
    };
    const off = channel.subscribe((response) => {
      if (!alive || response.req !== req || response.nonce !== pending) return;
      setState({ key, data: (response.data as T | undefined) ?? null, loading: false, error: response.error ?? null });
    });
    ask();
    const timer = pollMs ? setInterval(ask, pollMs) : null;
    return () => {
      alive = false;
      off();
      if (timer) clearInterval(timer);
    };
  }, [channel, req, id, path, key, pollMs]);
  return state.key === key ? { data: state.data, loading: state.loading, error: state.error } : { data: null, loading: key !== null, error: null };
}

/* ------------------------------------------------------- o que vem do back */

/** Espelho de `ToolDetail` (back/src/services/sdk/detail.ts). */
export interface ToolDetailData {
  found: boolean;
  by?: "main" | "subagent";
  agentId?: string;
  agentDescription?: string;
  name?: string;
  input?: unknown;
  isError?: boolean;
  text?: string;
  textLength?: number;
  structured?: unknown;
  thinking?: string;
  startedAt?: number;
  endedAt?: number;
  result?: ToolResultSummary;
}

export type TimelineItem =
  | { kind: "thinking" | "text"; at: number; text: string }
  | { kind: "tool"; at: number; id: string; name: string; input?: unknown; endedAt?: number; result?: ToolResultSummary };

/** Espelho de `AgentTimeline` (back). */
export interface AgentTimelineData {
  found: boolean;
  agentId?: string;
  description?: string;
  agentType?: string;
  prompt?: string;
  startedAt?: number;
  lastAt?: number;
  toolCount?: number;
  partial?: boolean;
  items: TimelineItem[];
}

export interface CardChangesData {
  branch: string;
  base: string;
  uncommitted: Array<{ status: string; path: string }>;
  commits: Array<{ sha: string; author: string; at: string; subject: string }>;
  files: Array<{ status: string; path: string }>;
  stat: { files: number; insertions: number; deletions: number };
}

export interface FileDiffData { path: string; diff: string; truncated: boolean }

/* ------------------------------------------------------- leitura do detalhe */

type Fields = Record<string, unknown>;
const asFields = (v: unknown): Fields => (v && typeof v === "object" && !Array.isArray(v) ? (v as Fields) : {});
const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** Uma linha de diff: o que a tela pinta. */
export interface DiffRow { kind: "add" | "del" | "ctx" | "hunk"; text: string }

/** Um diff unificado (do git ou do `structuredPatch`) em linhas. Cabeçalhos de arquivo saem. PURE. */
export function parseUnifiedDiff(diff: string): DiffRow[] {
  const out: DiffRow[] = [];
  for (const line of String(diff ?? "").split("\n")) {
    if (line.startsWith("diff --git") || line.startsWith("index ") || line.startsWith("--- ") || line.startsWith("+++ ")
      || line.startsWith("new file mode") || line.startsWith("deleted file mode") || line.startsWith("similarity index")) continue;
    if (line.startsWith("@@")) out.push({ kind: "hunk", text: line });
    else if (line.startsWith("+")) out.push({ kind: "add", text: line.slice(1) });
    else if (line.startsWith("-")) out.push({ kind: "del", text: line.slice(1) });
    else if (line.startsWith(" ")) out.push({ kind: "ctx", text: line.slice(1) });
    else if (line.startsWith("\\")) continue;
  }
  return out;
}

/** O `structuredPatch` de um Edit/Write em linhas de diff. PURE. */
export function patchRows(structured: unknown): DiffRow[] | null {
  const patch = asFields(structured).structuredPatch;
  if (!Array.isArray(patch) || patch.length === 0) return null;
  const out: DiffRow[] = [];
  for (const hunk of patch) {
    const h = asFields(hunk);
    out.push({ kind: "hunk", text: `@@ -${h.oldStart ?? "?"},${h.oldLines ?? "?"} +${h.newStart ?? "?"},${h.newLines ?? "?"} @@` });
    for (const l of Array.isArray(h.lines) ? h.lines : []) {
      if (typeof l !== "string") continue;
      if (l.startsWith("+")) out.push({ kind: "add", text: l.slice(1) });
      else if (l.startsWith("-")) out.push({ kind: "del", text: l.slice(1) });
      else out.push({ kind: "ctx", text: l.startsWith(" ") ? l.slice(1) : l });
    }
  }
  return out;
}

/** A saída de um Bash: stdout e stderr separados, quando o estruturado tem; senão o texto. PURE. */
export function bashOutput(detail: Pick<ToolDetailData, "structured" | "text">): { stdout: string; stderr: string } {
  const s = asFields(detail.structured);
  if (typeof s.stdout === "string" || typeof s.stderr === "string") return { stdout: str(s.stdout), stderr: str(s.stderr) };
  return { stdout: str(detail.text), stderr: "" };
}

/** O conteúdo de um Read (sem os números que o CLI prefixa), com a linha inicial. PURE. */
export function readContent(detail: Pick<ToolDetailData, "structured" | "text">): { content: string; startLine: number } {
  const file = asFields(asFields(detail.structured).file);
  if (typeof file.content === "string") return { content: file.content, startLine: typeof file.startLine === "number" ? file.startLine : 1 };
  // Sem o estruturado: o texto vem como "   12→linha" (ou com tab); tira o prefixo.
  const lines = str(detail.text).split("\n");
  const m = /^\s*(\d+)[→\t]/.exec(lines[0] ?? "");
  const start = m ? Number(m[1]) : 1;
  return { content: lines.map((l) => l.replace(/^\s*\d+[→\t]/, "")).join("\n"), startLine: start };
}

/** Os arquivos que o Claude e os subagentes ALTERARAM nesta conversa, pelas ações de edição. PURE. */
export interface ChangedFile {
  path: string;
  rows: Array<Extract<SdkRow, { kind: "tool" }>>;
  added: number;
  removed: number;
}

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

export function changedFiles(
  rows: readonly SdkRow[],
  diffOf: (name: string, input: unknown) => { added: number; removed: number } | null,
): ChangedFile[] {
  const byPath = new Map<string, ChangedFile>();
  for (const row of rows) {
    if (row.kind !== "tool" || !EDIT_TOOLS.has(row.name) || row.result?.isError) continue;
    const o = asFields(row.input);
    const path = str(o.file_path) || str(o.notebook_path) || str(o.path);
    if (!path) continue;
    const entry = byPath.get(path) ?? { path, rows: [], added: 0, removed: 0 };
    entry.rows.push(row);
    const counts = row.result && (typeof row.result.added === "number" || typeof row.result.removed === "number")
      ? { added: row.result.added ?? 0, removed: row.result.removed ?? 0 }
      : diffOf(row.name, row.input);
    if (counts) {
      entry.added += counts.added;
      entry.removed += counts.removed;
    }
    byPath.set(path, entry);
  }
  return [...byPath.values()];
}
