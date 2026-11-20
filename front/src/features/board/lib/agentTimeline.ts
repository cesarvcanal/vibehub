import type { TimelineItem } from "@/features/board/lib/sdkDetail";
import { verbKey } from "@/features/board/lib/workflowPanel";

export type TimelineToolItem = Extract<TimelineItem, { kind: "tool" }>;

export interface TimelineVerbCount {
  key: string;
  tool: string;
  count: number;
}

export interface TimelineThinkingItem {
  kind: "thinking";
  at: number;
  text: string;
}

export type TimelineWorkStep = TimelineToolItem | TimelineThinkingItem;

export interface AgentTimelineWorkBlock {
  kind: "work";
  startedAt: number;
  endedAt?: number;
  steps: TimelineWorkStep[];
  verbs: TimelineVerbCount[];
}

export type AgentTimelineBlock = { kind: "text"; at: number; text: string } | TimelineThinkingItem | AgentTimelineWorkBlock;

function verbIdentity(key: string, tool: string): string {
  return key === "sdk.verb.default" ? `${key}:${tool}` : key;
}

function countVerbs(tools: readonly TimelineToolItem[]): TimelineVerbCount[] {
  const counts = new Map<string, TimelineVerbCount>();
  tools.forEach((item) => {
    const key = verbKey(item.name);
    const identity = verbIdentity(key, item.name);
    const known = counts.get(identity);
    counts.set(identity, known ? { ...known, count: known.count + 1 } : { key, tool: item.name, count: 1 });
  });
  return [...counts.values()];
}

function buildWorkBlock(steps: TimelineWorkStep[], tools: readonly TimelineToolItem[]): AgentTimelineWorkBlock {
  const stillRunning = tools.some((item) => item.endedAt === undefined);
  return {
    kind: "work",
    startedAt: steps[0].at,
    ...(stillRunning ? {} : { endedAt: Math.max(...tools.map((item) => item.endedAt ?? item.at)) }),
    steps,
    verbs: countVerbs(tools),
  };
}

export function groupAgentTimeline(items: readonly TimelineItem[]): AgentTimelineBlock[] {
  const blocks: AgentTimelineBlock[] = [];
  const pendingSteps: TimelineWorkStep[] = [];
  const flushPendingSteps = (): void => {
    const steps = pendingSteps.splice(0);
    const tools = steps.filter((step): step is TimelineToolItem => step.kind === "tool");
    const thoughts = steps.filter((step): step is TimelineThinkingItem => step.kind === "thinking");
    if (tools.length > 0) blocks.push(buildWorkBlock(steps, tools));
    else blocks.push(...thoughts);
  };
  items.forEach((item) => {
    if (item.kind === "tool") pendingSteps.push(item);
    else if (item.kind === "thinking") pendingSteps.push({ kind: "thinking", at: item.at, text: item.text });
    else {
      flushPendingSteps();
      blocks.push({ kind: "text", at: item.at, text: item.text });
    }
  });
  flushPendingSteps();
  return blocks;
}
