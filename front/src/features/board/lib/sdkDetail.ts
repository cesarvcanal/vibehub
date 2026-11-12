import * as React from "react";
import { t as translate } from "@/i18n";
import type { AgentTask, SdkRow, ToolResultSummary } from "@/features/board/lib/sdkChat";
import type { DiffRow } from "@/features/board/lib/toolDiff";

/**
 * SEEING WHAT CLAUDE IS DOING — the pure rules of the detail that opens when you click an action,
 * a subagent or "Mudanças", and the channel that asks the back for that detail.
 *
 * The chat receives only the SUMMARY of each result; the rest is requested on demand over the
 * websocket (`{ type: "detail", req }`) and the back reads it from the session transcript on the
 * runner (back/src/services/sdk/detail.ts). The response comes back only to this tab and never goes
 * through the reducer.
 */

/* ------------------------------------------------------------ the result line */

/** Readable duration: `850 ms`, `4,2 s`, `1m 24s`, `3h 07m`. PURE. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1).replace(".", translate("sdk.result.decimalSeparator"))} s`;
  const whole = Math.floor(s);
  const minutes = Math.floor(whole / 60);
  if (minutes < 60) return `${minutes}m ${String(whole % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/** How many tokens, short: `900`, `41 mil` / `41k`, `1 mi` / `1M`, `1,5 mi` / `1.5M`. PURE. */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n < 1000) return String(Math.max(0, Math.round(n || 0)));
  // 999,500 would round to "1000k": from there up the count is already in millions.
  if (n < 999_500) return translate("sdk.result.thousands", { n: Math.round(n / 1000) });
  const millions = Math.round(n / 100_000) / 10;
  const shown = Number.isInteger(millions) ? String(millions) : millions.toFixed(1).replace(".", translate("sdk.result.decimalSeparator"));
  return translate("sdk.result.millions", { n: shown });
}

/**
 * The RESULT LINE of an action, like the terminal's: "7 linhas", "+3 −1", "linhas 60–80 de 290",
 * "9 ocorrências em 7 arquivos", "sem saída", "erro: …". Null = nothing to say. PURE.
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

/** Where an action stands, for the icon. PURE. */
export type ToolStatus = "running" | "ok" | "error" | "unknown";

export function toolStatus(row: Extract<SdkRow, { kind: "tool" }>): ToolStatus {
  if (row.pending) return "running";
  if (row.result) return row.result.isError ? "error" : "ok";
  return row.live ? "running" : "unknown";
}

/* ------------------------------------------------------------------- subagents */

/** Where a subagent stands: the task state rules; without it, the call's result. PURE. */
export function agentStatus(row: Extract<SdkRow, { kind: "tool" }>, task: AgentTask | undefined): ToolStatus {
  if (task) return task.status === "running" ? "running" : task.status === "completed" ? "ok" : "error";
  if (row.result) {
    if (row.result.isError) return "error";
    return row.result.background ? (row.live ? "running" : "unknown") : "ok";
  }
  return row.live ? "running" : "unknown";
}

/**
 * Subagent silence beyond which the clock stops: one that died without notice does not count forever.
 * The same ceiling as the back (TASK_CLOCK_STALE_MS in back/src/services/sdk/toolResult.ts).
 */
export const AGENT_CLOCK_STALE_MS = 30 * 60_000;

/**
 * How long the subagent has been working. The back sends, in every frame, the time up to that
 * instant on its clock; while running, the tab adds the time since it received the frame, on ITS
 * own clock (no skew between the two), up to the silence ceiling — which starts already spent by the
 * `quietMs` the frame left with. When finished, the final duration. While running, in whole seconds:
 * a clock that ticks second by second does not show tenths. PURE.
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

/** A subagent's name from the call: the description the model gave, otherwise the type. PURE. */
export function agentName(input: unknown): string {
  const o = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const pick = [o.description, o.subagent_type, o.name].find((v) => typeof v === "string" && v.trim() !== "");
  return typeof pick === "string" ? pick.trim() : "Agent";
}

/* ---------------------------------------------------------------- the channel */

/** The back's responses, as they arrive (`data` is what the probe read; `error` says why not). */
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
  /** Requests; returns the request's `nonce`, or null when the socket is closed. */
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

/** Reads a detail response from the socket; a malformed shape becomes null. PURE. */
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

/** How many details each channel remembers (the oldest goes first). */
export const DETAIL_CACHE_MAX = 200;

/**
 * The last detail that arrived, per channel (card) and request: reopening the modal shows right away
 * what already came, instead of "Carregando…" again on every opening, and the new request just
 * updates on top.
 */
const detailCache = new WeakMap<DetailChannel, Map<string, unknown>>();

function cacheOf(channel: DetailChannel): Map<string, unknown> {
  let cache = detailCache.get(channel);
  if (!cache) {
    cache = new Map();
    detailCache.set(channel, cache);
  }
  return cache;
}

function remember(channel: DetailChannel, slot: string, data: unknown): void {
  const cache = cacheOf(channel);
  cache.delete(slot);
  cache.set(slot, data);
  if (cache.size > DETAIL_CACHE_MAX) cache.delete(cache.keys().next().value as string);
}

/**
 * Requests once and listens for the response (and, with `pollMs`, requests again while open). `key`
 * changes = new request. Returns the latest data and the request state; what already came before for
 * the same request shows up right away while the new request runs. `nudge` changes = requests again
 * right away, keeping the data.
 */
export function useDetail<T>(
  req: DetailResponse["req"],
  opts: { id?: string; path?: string },
  key: string | null,
  pollMs?: number,
  nudge?: string,
): { data: T | null; loading: boolean; error: string | null } {
  const channel = React.useContext(DetailChannelContext);
  const slot = `${req}|${key ?? ""}`;
  const cached = (): T | null => (channel && key !== null ? ((cacheOf(channel).get(slot) as T | undefined) ?? null) : null);
  const [state, setState] = React.useState<{ key: string | null; data: T | null; loading: boolean; error: string | null }>(() => ({ key: null, data: null, loading: false, error: null }));
  const id = opts.id;
  const path = opts.path;
  React.useEffect(() => {
    if (!channel || key === null) return;
    let alive = true;
    let pending: string | null = null;
    setState((prev) => (prev.key === key ? prev : { key, data: cached(), loading: true, error: null }));
    const ask = (): void => {
      pending = channel.request(req, { id, path });
      if (pending === null) setState((prev) => ({ ...prev, key, loading: false, error: prev.data ? null : "offline" }));
    };
    const off = channel.subscribe((response) => {
      if (!alive || response.req !== req || response.nonce !== pending) return;
      const data = (response.data as T | undefined) ?? null;
      if (data !== null && !response.error) remember(channel, slot, data);
      setState((prev) => ({ key, data: data ?? (response.error ? prev.data : null), loading: false, error: response.error ?? null }));
    });
    ask();
    const timer = pollMs ? setInterval(ask, pollMs) : null;
    return () => {
      alive = false;
      off();
      if (timer) clearInterval(timer);
    };
  }, [channel, req, id, path, key, pollMs, nudge]);
  return state.key === key ? { data: state.data, loading: state.loading, error: state.error } : { data: cached(), loading: key !== null, error: null };
}

/** Does the action already have a result in the transcript? Without it, it is still running (or the transcript did not record it). PURE. */
export function detailHasResult(detail: Pick<ToolDetailData, "result" | "endedAt" | "text" | "structured"> | null): boolean {
  return !!detail && (detail.result !== undefined || detail.endedAt !== undefined || detail.text !== undefined || detail.structured !== undefined);
}

/* ------------------------------------------------------- what comes from the back */

/** Mirror of `ToolDetail` (back/src/services/sdk/detail.ts). */
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
  /** Bash with `run_in_background`: the real output, read from the task's file on every probe. */
  background?: BackgroundOutputData;
}

/** Mirror of `BackgroundOutput` (back). `status`: running | completed | failed | killed | stopped. */
export interface BackgroundOutputData {
  taskId: string;
  status: string;
  output?: string;
  outputLength?: number;
  missing?: boolean;
}

export type TimelineItem =
  | { kind: "thinking" | "text"; at: number; text: string }
  | { kind: "tool"; at: number; id: string; name: string; input?: unknown; endedAt?: number; result?: ToolResultSummary };

/** Mirror of `AgentTimeline` (back). */
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

/* ------------------------------------------------------- reading the detail */

type Fields = Record<string, unknown>;
const asFields = (v: unknown): Fields => (v && typeof v === "object" && !Array.isArray(v) ? (v as Fields) : {});
const str = (v: unknown): string => (typeof v === "string" ? v : "");

export type { DiffRow };

/** A unified diff (from git or from `structuredPatch`) as lines. File headers are dropped. PURE. */
export function parseUnifiedDiff(diff: string): DiffRow[] {
  const out: DiffRow[] = [];
  // A header only exists BEFORE the first `@@` of each file: inside the hunk, `--- x` is the removed
  // line `-- x` (a SQL comment, a markdown `---`), not the file name.
  let inHunk = false;
  for (const line of String(diff ?? "").split("\n")) {
    if (line.startsWith("diff --git")) {
      inHunk = false;
      continue;
    }
    if (!inHunk && (line.startsWith("index ") || line.startsWith("--- ") || line.startsWith("+++ ")
      || line.startsWith("new file mode") || line.startsWith("deleted file mode") || line.startsWith("similarity index"))) continue;
    if (line.startsWith("@@")) {
      inHunk = true;
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line);
      out.push(m ? { kind: "hunk", text: line, oldStart: Number(m[1]), newStart: Number(m[2]) } : { kind: "hunk", text: line });
    }
    else if (line.startsWith("+")) out.push({ kind: "add", text: line.slice(1) });
    else if (line.startsWith("-")) out.push({ kind: "del", text: line.slice(1) });
    else if (line.startsWith(" ")) out.push({ kind: "ctx", text: line.slice(1) });
    else if (line.startsWith("\\")) continue;
  }
  return out;
}

/** The `structuredPatch` of an Edit/Write as diff lines. PURE. */
export function patchRows(structured: unknown): DiffRow[] | null {
  const patch = asFields(structured).structuredPatch;
  if (!Array.isArray(patch) || patch.length === 0) return null;
  const out: DiffRow[] = [];
  for (const hunk of patch) {
    const h = asFields(hunk);
    out.push({
      kind: "hunk",
      text: `@@ -${h.oldStart ?? "?"},${h.oldLines ?? "?"} +${h.newStart ?? "?"},${h.newLines ?? "?"} @@`,
      ...(typeof h.oldStart === "number" && typeof h.newStart === "number" ? { oldStart: h.oldStart, newStart: h.newStart } : {}),
    });
    for (const l of Array.isArray(h.lines) ? h.lines : []) {
      if (typeof l !== "string") continue;
      if (l.startsWith("+")) out.push({ kind: "add", text: l.slice(1) });
      else if (l.startsWith("-")) out.push({ kind: "del", text: l.slice(1) });
      else out.push({ kind: "ctx", text: l.startsWith(" ") ? l.slice(1) : l });
    }
  }
  return out;
}

/** A Bash's output: stdout and stderr separated, when the structured result has them; otherwise the text. PURE. */
export function bashOutput(detail: Pick<ToolDetailData, "structured" | "text">): { stdout: string; stderr: string } {
  const s = asFields(detail.structured);
  if (typeof s.stdout === "string" || typeof s.stderr === "string") return { stdout: str(s.stdout), stderr: str(s.stderr) };
  return { stdout: str(detail.text), stderr: "" };
}

/** The content of a Read (without the numbers the CLI prefixes), with the starting line. PURE. */
export function readContent(detail: Pick<ToolDetailData, "structured" | "text">): { content: string; startLine: number } {
  const file = asFields(asFields(detail.structured).file);
  if (typeof file.content === "string") return { content: file.content, startLine: typeof file.startLine === "number" ? file.startLine : 1 };
  // Without the structured result: the text comes as "   12→linha" (or with a tab); strip the prefix.
  const lines = str(detail.text).split("\n");
  const m = /^\s*(\d+)[→\t]/.exec(lines[0] ?? "");
  const start = m ? Number(m[1]) : 1;
  return { content: lines.map((l) => l.replace(/^\s*\d+[→\t]/, "")).join("\n"), startLine: start };
}

/** The files Claude and the subagents CHANGED in this conversation, from the edit actions. PURE. */
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
