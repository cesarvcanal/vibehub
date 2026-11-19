import type { AnalysisConversation, AnalysisConversationItem, ReviewFleetAgent, ReviewFleetRun } from "@/api/types";
import { agentRole, readAgentResult, type AgentReading } from "@/features/board/lib/reviewFleet";

export type ModelFamily = "opus" | "sonnet" | "haiku" | "other";

export interface ChatSpeaker {
  agentId: string;
  label: string;
  model?: string;
  family: ModelFamily;
}

export interface ChatReply {
  title: string;
  messageId?: string;
}

export type FleetChatEntry =
  | { kind: "message"; id: string; speaker: ChatSpeaker; at?: number; reading: AgentReading; replyTo?: ChatReply }
  | { kind: "stopped"; id: string; speaker: ChatSpeaker }
  | { kind: "typing"; id: string; speaker: ChatSpeaker; doing?: { tool: string; target?: string } };

type ChatMessage = Extract<FleetChatEntry, { kind: "message" }>;

const MODEL_FAMILIES = ["opus", "sonnet", "haiku"] as const;
const JUDGE_LABEL = "juiz";
const LABEL_SEPARATOR = " · ";
const LONG_SPEECH_CHARS = 480;
const LONG_SPEECH_LINES = 8;

export function modelFamily(model: string | undefined): ModelFamily {
  const lowered = model?.toLowerCase() ?? "";
  return MODEL_FAMILIES.find((family) => lowered.includes(family)) ?? "other";
}

function speakerOf(agentId: string, label: string, model: string | undefined): ChatSpeaker {
  const family = modelFamily(model);
  return model ? { agentId, label, model, family } : { agentId, label, family };
}

function verifiedTitle(label: string): string | undefined {
  if (agentRole(label).kind !== "verification") return undefined;
  const separator = label.indexOf(LABEL_SEPARATOR);
  return separator >= 0 ? label.slice(separator + LABEL_SEPARATOR.length) : undefined;
}

function withReplies(messages: ChatMessage[]): ChatMessage[] {
  const lastReviewMessage = new Map<string, string>();
  return messages.map((message) => {
    const role = agentRole(message.speaker.label);
    if (role.kind === "review") lastReviewMessage.set(role.dimension, message.id);
    const title = verifiedTitle(message.speaker.label);
    if (role.kind !== "verification" || title === undefined) return message;
    const messageId = lastReviewMessage.get(role.dimension);
    return { ...message, replyTo: messageId ? { title, messageId } : { title } };
  });
}

export function reviewFleetChat(run: ReviewFleetRun): FleetChatEntry[] {
  const speaker = (agent: ReviewFleetAgent) => speakerOf(agent.id, agent.label, agent.model);
  const byEnd = (left: ReviewFleetAgent, right: ReviewFleetAgent) => (left.endedAt ?? 0) - (right.endedAt ?? 0);
  const answered = run.agents.filter((agent) => agent.status === "done").sort(byEnd);
  const judgesLast = [...answered.filter((agent) => agent.label !== JUDGE_LABEL), ...answered.filter((agent) => agent.label === JUDGE_LABEL)];
  const messages = judgesLast.map((agent): ChatMessage => {
    const reading = readAgentResult(agent.result ?? "");
    const id = `${run.runId}-${agent.id}`;
    return agent.endedAt === undefined ? { kind: "message", id, speaker: speaker(agent), reading } : { kind: "message", id, speaker: speaker(agent), at: agent.endedAt, reading };
  });
  const stopped = run.agents
    .filter((agent) => agent.status === "stopped")
    .map((agent): FleetChatEntry => ({ kind: "stopped", id: `${run.runId}-${agent.id}`, speaker: speaker(agent) }));
  const typing = run.finished
    ? []
    : run.agents
      .filter((agent) => agent.status === "running")
      .map((agent): FleetChatEntry => ({ kind: "typing", id: `${run.runId}-${agent.id}`, speaker: speaker(agent) }));
  return [...withReplies(messages), ...stopped, ...typing];
}

function lastStepDoing(steps: AnalysisConversationItem[]): { tool: string; target?: string } | undefined {
  const lastStep = steps.at(-1);
  if (lastStep?.kind !== "tool" || !lastStep.tool) return undefined;
  return lastStep.target ? { tool: lastStep.tool, target: lastStep.target } : { tool: lastStep.tool };
}

export function analysisFleetChat(conversation: AnalysisConversation): FleetChatEntry[] {
  const speakers = new Map(conversation.agents.map((agent) => [agent.id, speakerOf(agent.id, agent.label, agent.modelLabel)]));
  const messages = conversation.items.flatMap((item, index): ChatMessage[] => {
    const speaker = speakers.get(item.agentId);
    if (!speaker || item.kind !== "text" || !item.text) return [];
    return [{ kind: "message", id: `${conversation.runId}-${item.agentId}-${index}`, speaker, at: item.at, reading: readAgentResult(item.text) }];
  });
  const typing = conversation.finished
    ? []
    : conversation.agents
      .filter((agent) => agent.status === "running")
      .map((agent): FleetChatEntry => {
        const doing = lastStepDoing(conversation.items.filter((item) => item.agentId === agent.id));
        const entry = { kind: "typing" as const, id: `${conversation.runId}-${agent.id}-typing`, speaker: speakers.get(agent.id)! };
        return doing ? { ...entry, doing } : entry;
      });
  return [...withReplies(messages), ...typing];
}

export function isLongSpeech(text: string): boolean {
  return text.length > LONG_SPEECH_CHARS || text.split("\n").length > LONG_SPEECH_LINES;
}

export function chatClockText(at: number): string {
  return new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(at));
}
