import type { TimelineItem } from "@/features/board/lib/sdkDetail";
import { verbKey } from "@/features/board/lib/workflowPanel";

export type TimelineToolItem = Extract<TimelineItem, { kind: "tool" }>;

export interface TimelineVerbCount {
  key: string;
  tool: string;
  count: number;
}

export type AgentTimelineBlock =
  | { kind: "text"; at: number; text: string }
  | { kind: "thinking"; at: number; text: string }
  | { kind: "work"; startedAt: number; endedAt?: number; tools: TimelineToolItem[]; verbs: TimelineVerbCount[] };

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

function closeWorkBlock(tools: readonly TimelineToolItem[]): AgentTimelineBlock {
  const stillRunning = tools.some((item) => item.endedAt === undefined);
  const lastEnd = Math.max(...tools.map((item) => item.endedAt ?? item.at));
  return {
    kind: "work",
    startedAt: tools[0].at,
    ...(stillRunning ? {} : { endedAt: lastEnd }),
    tools: [...tools],
    verbs: countVerbs(tools),
  };
}

export function groupAgentTimeline(items: readonly TimelineItem[]): AgentTimelineBlock[] {
  const grouped = items.reduce<{ blocks: AgentTimelineBlock[]; pendingTools: TimelineToolItem[] }>(
    (state, item) => {
      if (item.kind === "tool") return { blocks: state.blocks, pendingTools: [...state.pendingTools, item] };
      const flushed = state.pendingTools.length > 0 ? [...state.blocks, closeWorkBlock(state.pendingTools)] : state.blocks;
      const spoken: AgentTimelineBlock = item.kind === "text" ? { kind: "text", at: item.at, text: item.text } : { kind: "thinking", at: item.at, text: item.text };
      return { blocks: [...flushed, spoken], pendingTools: [] };
    },
    { blocks: [], pendingTools: [] },
  );
  return grouped.pendingTools.length > 0 ? [...grouped.blocks, closeWorkBlock(grouped.pendingTools)] : grouped.blocks;
}
