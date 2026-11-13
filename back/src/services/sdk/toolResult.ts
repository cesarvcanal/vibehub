/**
 * WHAT EACH TOOL RETURNED — the chat's result line, like the terminal's.
 *
 * The driver passes on the RAW, capped result (`RawToolResultEvent`: the text the model read and the
 * structured `tool_use_result`, pruned). Here it becomes the SUMMARY the screen draws under the action —
 * "7 linhas", "+3 −1", "9 ocorrências em 7 arquivos", "erro: …" — and only the summary goes on to the
 * browser and to the history. The whole detail is read from the transcript when someone clicks
 * (see ./detail.ts). PURE.
 */

import { asFields } from "./fields.js";

/** The frame the driver emits (stdout), before the summary. */
export interface RawToolResultEvent {
  type: "tool_result";
  id: string;
  isError?: boolean;
  text?: string;
  textLength?: number;
  structured?: unknown;
  /** Lines counted BEFORE the cut: stdout+stderr (Bash) or, without them, the whole text. */
  outputLines?: number;
  parentToolUseId?: string;
}

/** A result's summary — the line's numbers; the screen translates. */
export interface ToolResultSummary {
  isError?: boolean;
  /** First useful line of the error, capped. */
  error?: string;
  /** Lines of output (Bash), read (Read) or of content (Grep). */
  lines?: number;
  startLine?: number;
  totalLines?: number;
  files?: number;
  matches?: number;
  added?: number;
  removed?: number;
  created?: boolean;
  /** Finished without printing anything. */
  empty?: boolean;
  interrupted?: boolean;
  /** Went to the background (Bash with run_in_background, async subagent). */
  background?: boolean;
  /** A subagent that finished right there (foreground). */
  agent?: { toolUses?: number; durationMs?: number; tokens?: number };
}

/** What goes on to the browser and to the history. */
export interface ToolResultEvent {
  type: "tool_result";
  id: string;
  parentToolUseId?: string;
  toolResult: ToolResultSummary;
}

const ERROR_MAX = 200;

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : undefined);

/** How many lines a text has (not counting the final line break). PURE. */
export function lineCount(text: string): number {
  const t = text.replace(/\s+$/, "");
  return t === "" ? 0 : t.split("\n").length;
}

/** The first line of an error that says something — without the labels the CLI puts around it. PURE. */
export function firstErrorLine(text: string): string {
  const clean = text.replace(/<\/?tool_use_error>/g, "");
  const line = clean.split("\n").map((l) => l.trim()).find((l) => l !== "") ?? "";
  return line.length > ERROR_MAX ? `${line.slice(0, ERROR_MAX - 1)}…` : line;
}

/** +/− of a `structuredPatch` (Edit/Write/MultiEdit). PURE. */
function patchCounts(patch: unknown): { added: number; removed: number } | null {
  if (!Array.isArray(patch)) return null;
  let added = 0;
  let removed = 0;
  for (const hunk of patch) {
    const lines = asFields(hunk)?.lines;
    if (!Array.isArray(lines)) continue;
    for (const l of lines) {
      if (typeof l !== "string") continue;
      if (l.startsWith("+")) added += 1;
      else if (l.startsWith("-")) removed += 1;
    }
  }
  return { added, removed };
}

/**
 * A result's summary, by the SHAPE of the structured part (each tool has its own) and, without it, by the
 * text. It does not depend on the tool's name: an MCP result falls into the text. PURE.
 */
export function summarizeToolResult(raw: RawToolResultEvent): ToolResultSummary {
  const text = typeof raw.text === "string" ? raw.text : "";
  if (raw.isError === true) return { isError: true, error: firstErrorLine(text) || "error" };
  const s = asFields(raw.structured);
  if (s) {
    // Subagent: in the background, or finished right there.
    if (s.status === "async_launched" || s.status === "remote_launched") return { background: true };
    if (s.status === "completed" && ("totalToolUseCount" in s || "totalDurationMs" in s)) {
      return { agent: { toolUses: num(s.totalToolUseCount), durationMs: num(s.totalDurationMs), tokens: num(s.totalTokens) } };
    }
    // Read
    const file = asFields(s.file);
    if (file && typeof file.content === "string") {
      return { lines: num(file.numLines) ?? lineCount(file.content), startLine: num(file.startLine), totalLines: num(file.totalLines) };
    }
    // Edit / Write / MultiEdit
    const patch = patchCounts(s.structuredPatch);
    if (patch) {
      const created = s.type === "create";
      if (created && typeof s.content === "string") return { created: true, added: lineCount(s.content), removed: 0 };
      return { ...patch, ...(created ? { created: true } : {}) };
    }
    // Bash
    if (typeof s.stdout === "string" || typeof s.stderr === "string") {
      if (typeof s.backgroundTaskId === "string" && s.backgroundTaskId) return { background: true };
      const out = num(raw.outputLines) ?? lineCount(String(s.stdout ?? "")) + lineCount(String(s.stderr ?? ""));
      return { ...(out === 0 ? { empty: true } : { lines: out }), ...(s.interrupted === true ? { interrupted: true } : {}) };
    }
    // Grep / Glob
    if (typeof s.numFiles === "number") {
      const lines = num(s.numLines);
      return { files: num(s.numFiles), ...(s.mode === "content" && lines !== undefined ? { matches: lines } : {}) };
    }
  }
  const lines = num(raw.outputLines) ?? lineCount(text);
  return lines === 0 ? { empty: true } : { lines };
}

/** The summarised frame that goes to the screen and to the history. PURE. */
export function toolResultEvent(raw: RawToolResultEvent): ToolResultEvent {
  return {
    type: "tool_result",
    id: raw.id,
    ...(raw.parentToolUseId ? { parentToolUseId: raw.parentToolUseId } : {}),
    toolResult: summarizeToolResult(raw),
  };
}

/* ------------------------------------------------------------------ subagents */

/** The task frames the driver emits (`task_started` / `task_progress` / `task_notification`). */
export interface RawTaskEvent {
  type: "task_started" | "task_progress" | "task_notification";
  taskId: string;
  toolUseId?: string;
  description?: string;
  subagentType?: string;
  taskType?: string;
  status?: string;
  toolUses?: unknown;
  tokens?: unknown;
  durationMs?: unknown;
  lastTool?: string;
  summary?: string;
}

/**
 * The state of ONE subagent (or task) spawned by a call — what the fleet and the tray
 * show. A single event (`agent_task`) carries the whole state: the screen replaces, never adds.
 */
export interface AgentTaskEvent {
  type: "agent_task";
  toolUseId: string;
  taskId: string;
  status: "running" | "completed" | "failed" | "stopped";
  description?: string;
  subagentType?: string;
  taskType?: string;
  toolUses?: number;
  tokens?: number;
  durationMs?: number;
  lastTool?: string;
  /** Running: the sentence of what it is doing now. Finished: the CLI's final summary. */
  summary?: string;
  /** When the back saw the task start (ms) — the screen's clock. */
  startedAt?: number;
  /** When the CLI's last frame for this task arrived (ms, the back's clock). */
  lastAt?: number;
  /** Only in what goes out to the tab (taskSnapshot): how long the task has been quiet. */
  quietMs?: number;
}

const STATUSES = new Set(["completed", "failed", "stopped"]);

/** Merges a task frame into the previous state (or null when it cannot be tied to a call). PURE. */
export function mergeTaskEvent(previous: AgentTaskEvent | undefined, raw: RawTaskEvent, now: number): AgentTaskEvent | null {
  const toolUseId = raw.toolUseId || previous?.toolUseId;
  if (!toolUseId || typeof raw.taskId !== "string") return null;
  const next: AgentTaskEvent = {
    ...(previous ?? { type: "agent_task", toolUseId, taskId: raw.taskId, status: "running", startedAt: now }),
    type: "agent_task",
    toolUseId,
    taskId: raw.taskId,
    lastAt: now,
  };
  if (raw.description) next.description = raw.description.slice(0, 300);
  if (raw.subagentType) next.subagentType = raw.subagentType.slice(0, 80);
  if (raw.taskType) next.taskType = raw.taskType.slice(0, 40);
  const toolUses = num(raw.toolUses);
  const tokens = num(raw.tokens);
  const durationMs = num(raw.durationMs);
  if (toolUses !== undefined) next.toolUses = toolUses;
  if (tokens !== undefined) next.tokens = tokens;
  if (durationMs !== undefined) next.durationMs = durationMs;
  if (raw.lastTool) next.lastTool = raw.lastTool.slice(0, 80);
  if (raw.type === "task_notification") {
    next.status = STATUSES.has(raw.status ?? "") ? (raw.status as AgentTaskEvent["status"]) : "completed";
    if (typeof raw.summary === "string") next.summary = raw.summary.slice(0, 4000);
  } else if (raw.type === "task_progress" && raw.summary) {
    next.summary = raw.summary.slice(0, 300);
  } else if (raw.type === "task_started") {
    next.status = "running";
  }
  return next;
}

/**
 * Subagent silence past which the clock stops: one that died without warning (the driver dropped before the
 * `task_notification`) does not count forever. The same cap as the front's (AGENT_CLOCK_STALE_MS).
 */
export const TASK_CLOCK_STALE_MS = 30 * 60_000;

/**
 * The subagent as it goes out to a tab — live and on connect. The stored `durationMs` is the one from the last
 * CLI frame that brought usage, and the periodic progress often comes without it: passing it on made the tab
 * go back in time. While running, the time goes up to now on the back's clock (the same as `startedAt`, with no
 * skew against the browser's), never less than what the CLI measured and stopped at the silence cap; and
 * `quietMs` tells the tab how long it has been quiet, so it stops at the same cap. PURE.
 */
export function taskSnapshot(task: AgentTaskEvent, now: number): AgentTaskEvent {
  if (task.status !== "running" || task.startedAt === undefined) return task;
  const lastAt = task.lastAt ?? now;
  const until = Math.min(now, lastAt + TASK_CLOCK_STALE_MS);
  return { ...task, durationMs: Math.max(task.durationMs ?? 0, until - task.startedAt), quietMs: Math.max(0, now - lastAt) };
}
