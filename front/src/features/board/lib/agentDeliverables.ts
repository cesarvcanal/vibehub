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

function parseTaskLine(line: string): TaskLine | null {
  const match = TASK_LINE.exec(line);
  return match ? { checked: match[1] !== " ", text: match[2] } : null;
}

function normalizeTaskText(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

function markedState(reportTasks: readonly TaskLine[], promptText: string, index: number, promptCount: number): DeliverableState {
  const promptKey = normalizeTaskText(promptText);
  const sameText = reportTasks.find((task) => normalizeTaskText(task.text) === promptKey);
  const samePosition = reportTasks.length === promptCount ? reportTasks[index] : undefined;
  const match = sameText ?? samePosition;
  if (!match) return "unmarked";
  return match.checked ? "done" : "missed";
}

export function readAgentDeliverables(prompt: string, report: string, running: boolean): AgentDeliverables {
  const promptLines = prompt.split("\n");
  const promptTasks = promptLines.map(parseTaskLine);
  const context = promptLines.filter((_, index) => !promptTasks[index]).join("\n").trim();
  const taskTexts = promptTasks.filter((task): task is TaskLine => task !== null).map((task) => task.text);
  const reportTasks = report.split("\n").map(parseTaskLine).filter((task): task is TaskLine => task !== null);
  const items: AgentDeliverable[] = taskTexts.map((text, index) => ({
    text,
    state: running ? "open" : markedState(reportTasks, text, index, taskTexts.length),
  }));
  return { context, items };
}
