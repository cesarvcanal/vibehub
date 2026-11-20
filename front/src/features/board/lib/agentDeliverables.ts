export type DeliverableState = "open" | "done" | "missed" | "unmarked";

export interface AgentDeliverable {
  text: string;
  state: DeliverableState;
}

export interface AgentDeliverables {
  context: string;
  items: AgentDeliverable[];
}

const TASK_LINE = /^\s*[-*]\s+\[([ xX])\]\s+(.+?)\s*$/;

interface TaskLine {
  text: string;
  checked: boolean;
}

const CODE_FENCE = /^\s*(```|~~~)/;

function parseTaskLine(line: string): TaskLine | null {
  const match = TASK_LINE.exec(line);
  return match ? { checked: match[1] !== " ", text: match[2] } : null;
}

function parseTaskLinesOutsideCode(lines: readonly string[]): Array<TaskLine | null> {
  const insideCode = lines.reduce<{ open: boolean; flags: boolean[] }>(
    (fence, line) => {
      const isFenceLine = CODE_FENCE.test(line);
      fence.flags.push(fence.open || isFenceLine);
      return { open: isFenceLine ? !fence.open : fence.open, flags: fence.flags };
    },
    { open: false, flags: [] },
  ).flags;
  return lines.map((line, index) => (insideCode[index] ? null : parseTaskLine(line)));
}

function readOpeningTaskList(report: string): TaskLine[] {
  const lines = report.split("\n");
  const tasks = parseTaskLinesOutsideCode(lines);
  const firstTask = tasks.findIndex((task) => task !== null);
  if (firstTask < 0) return [];
  const listEnd = lines.findIndex((line, index) => index > firstTask && tasks[index] === null && line.trim() !== "");
  return tasks.slice(firstTask, listEnd < 0 ? undefined : listEnd).filter((task): task is TaskLine => task !== null);
}

function normalizeTaskText(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

function markedState(reportTasks: readonly TaskLine[], promptText: string, index: number, promptCount: number): DeliverableState {
  const promptKey = normalizeTaskText(promptText);
  const sameStart = reportTasks.find((task) => normalizeTaskText(task.text).startsWith(promptKey));
  const samePosition = reportTasks.length === promptCount ? reportTasks[index] : undefined;
  const match = sameStart ?? samePosition;
  if (!match) return "unmarked";
  return match.checked ? "done" : "missed";
}

export function readAgentDeliverables(prompt: string, report: string, running: boolean): AgentDeliverables {
  const promptLines = prompt.split("\n");
  const promptTasks = parseTaskLinesOutsideCode(promptLines);
  const context = promptLines.filter((_, index) => !promptTasks[index]).join("\n").trim();
  const taskTexts = promptTasks.filter((task): task is TaskLine => task !== null).map((task) => task.text);
  const reportTasks = readOpeningTaskList(report);
  const items: AgentDeliverable[] = taskTexts.map((text, index) => ({
    text,
    state: running ? "open" : markedState(reportTasks, text, index, taskTexts.length),
  }));
  return { context, items };
}
