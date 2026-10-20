/**
 * O QUE CADA FERRAMENTA DEVOLVEU — a linha de resultado do chat, como a do terminal.
 *
 * O driver repassa o resultado CRU e capado (`RawToolResultEvent`: o texto que o modelo leu e o
 * `tool_use_result` estruturado, podado). Aqui ele vira o RESUMO que a tela desenha sob a ação —
 * "7 linhas", "+3 −1", "9 ocorrências em 7 arquivos", "erro: …" — e só o resumo segue para o
 * navegador e para o histórico. O detalhe inteiro é lido do transcript quando alguém clica
 * (ver ./detail.ts). PURE.
 */

/** O frame que o driver emite (stdout), antes do resumo. */
export interface RawToolResultEvent {
  type: "tool_result";
  id: string;
  isError?: boolean;
  text?: string;
  textLength?: number;
  structured?: unknown;
  /** Linhas contadas ANTES do corte: stdout+stderr (Bash) ou, sem eles, o texto inteiro. */
  outputLines?: number;
  parentToolUseId?: string;
}

/** O resumo de um resultado — os números da linha; a tela traduz. */
export interface ToolResultSummary {
  isError?: boolean;
  /** Primeira linha útil do erro, capada. */
  error?: string;
  /** Linhas da saída (Bash), lidas (Read) ou de conteúdo (Grep). */
  lines?: number;
  startLine?: number;
  totalLines?: number;
  files?: number;
  matches?: number;
  added?: number;
  removed?: number;
  created?: boolean;
  /** Terminou sem imprimir nada. */
  empty?: boolean;
  interrupted?: boolean;
  /** Foi para o segundo plano (Bash com run_in_background, subagente assíncrono). */
  background?: boolean;
  /** Um subagente que terminou ali mesmo (primeiro plano). */
  agent?: { toolUses?: number; durationMs?: number; tokens?: number };
}

/** O que segue para o navegador e para o histórico. */
export interface ToolResultEvent {
  type: "tool_result";
  id: string;
  parentToolUseId?: string;
  toolResult: ToolResultSummary;
}

const ERROR_MAX = 200;

type Fields = Record<string, unknown>;
const asFields = (v: unknown): Fields | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Fields) : null);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : undefined);

/** Quantas linhas um texto tem (sem contar a quebra final). PURE. */
export function lineCount(text: string): number {
  const t = text.replace(/\s+$/, "");
  return t === "" ? 0 : t.split("\n").length;
}

/** A primeira linha que diz alguma coisa de um erro — sem as etiquetas que o CLI põe em volta. PURE. */
export function firstErrorLine(text: string): string {
  const clean = text.replace(/<\/?tool_use_error>/g, "");
  const line = clean.split("\n").map((l) => l.trim()).find((l) => l !== "") ?? "";
  return line.length > ERROR_MAX ? `${line.slice(0, ERROR_MAX - 1)}…` : line;
}

/** +/− de um `structuredPatch` (Edit/Write/MultiEdit). PURE. */
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
 * O resumo de um resultado, pela FORMA do estruturado (cada ferramenta tem a sua) e, sem ele, pelo
 * texto. Não depende do nome da ferramenta: um resultado de MCP cai no texto. PURE.
 */
export function summarizeToolResult(raw: RawToolResultEvent): ToolResultSummary {
  const text = typeof raw.text === "string" ? raw.text : "";
  if (raw.isError === true) return { isError: true, error: firstErrorLine(text) || "error" };
  const s = asFields(raw.structured);
  if (s) {
    // Subagente: no segundo plano, ou terminado ali mesmo.
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

/** O frame resumido que vai para a tela e para o histórico. PURE. */
export function toolResultEvent(raw: RawToolResultEvent): ToolResultEvent {
  return {
    type: "tool_result",
    id: raw.id,
    ...(raw.parentToolUseId ? { parentToolUseId: raw.parentToolUseId } : {}),
    toolResult: summarizeToolResult(raw),
  };
}

/* ------------------------------------------------------------------ subagentes */

/** Os frames de tarefa que o driver emite (`task_started` / `task_progress` / `task_notification`). */
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
 * O estado de UM subagente (ou tarefa) disparado por uma chamada — o que a frota e a bandeja
 * mostram. Um evento só (`agent_task`) carrega o estado inteiro: a tela substitui, nunca soma.
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
  /** Rodando: a frase do que ele faz agora. Terminado: o resumo final do CLI. */
  summary?: string;
  /** Quando o back viu a tarefa começar (ms) — o relógio da tela. */
  startedAt?: number;
}

const STATUSES = new Set(["completed", "failed", "stopped"]);

/** Funde um frame de tarefa no estado anterior (ou null quando não dá pra ligar a uma chamada). PURE. */
export function mergeTaskEvent(previous: AgentTaskEvent | undefined, raw: RawTaskEvent, now: number): AgentTaskEvent | null {
  const toolUseId = raw.toolUseId || previous?.toolUseId;
  if (!toolUseId || typeof raw.taskId !== "string") return null;
  const next: AgentTaskEvent = {
    ...(previous ?? { type: "agent_task", toolUseId, taskId: raw.taskId, status: "running", startedAt: now }),
    type: "agent_task",
    toolUseId,
    taskId: raw.taskId,
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
 * O subagente como uma aba que acabou de conectar deve vê-lo. O `durationMs` guardado é o do último
 * progresso do CLI, que pode ser de minutos atrás; a aba conta a partir do que recebe, então o
 * tempo vai até agora, medido no relógio do back (o mesmo do `startedAt`). PURE.
 */
export function taskSnapshot(task: AgentTaskEvent, now: number): AgentTaskEvent {
  if (task.status !== "running" || task.startedAt === undefined) return task;
  return { ...task, durationMs: Math.max(task.durationMs ?? 0, now - task.startedAt) };
}
