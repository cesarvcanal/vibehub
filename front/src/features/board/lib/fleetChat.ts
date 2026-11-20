import type { AnalysisConversation, AnalysisConversationItem, ReviewFleetAgent, ReviewFleetRun } from "@/api/types";
import { LABEL_SEPARATOR, agentRole, readAgentResult, type AgentReading } from "@/features/board/lib/reviewFleet";

export type ModelFamily = "opus" | "sonnet" | "haiku" | "other";

export interface ChatSpeaker {
  agentId: string;
  label: string;
  model?: string;
  family: ModelFamily;
  ordinal?: number;
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
const LONG_SPEECH_CHARS = 480;
const LONG_SPEECH_LINES = 8;

export function modelFamily(model: string | undefined): ModelFamily {
  const lowered = model?.toLowerCase() ?? "";
  return MODEL_FAMILIES.find((family) => lowered.includes(family)) ?? "other";
}

function speakersOf(agents: { id: string; label: string; model?: string }[]): Map<string, ChatSpeaker> {
  const verificationsPerDimension = new Map<string, number>();
  return new Map(agents.map((agent) => {
    const family = modelFamily(agent.model);
    const base: ChatSpeaker = agent.model
      ? { agentId: agent.id, label: agent.label, model: agent.model, family }
      : { agentId: agent.id, label: agent.label, family };
    const role = agentRole(agent.label);
    if (role.kind !== "verification") return [agent.id, base];
    const ordinal = (verificationsPerDimension.get(role.dimension) ?? 0) + 1;
    verificationsPerDimension.set(role.dimension, ordinal);
    return [agent.id, { ...base, ordinal }];
  }));
}

function withReplies(messages: ChatMessage[]): ChatMessage[] {
  const lastReviewMessage = new Map<string, string>();
  return messages.map((message) => {
    const { label } = message.speaker;
    const role = agentRole(label);
    if (role.kind === "review") lastReviewMessage.set(role.dimension, message.id);
    const separator = label.indexOf(LABEL_SEPARATOR);
    if (role.kind !== "verification" || separator < 0) return message;
    const title = label.slice(separator + LABEL_SEPARATOR.length);
    const messageId = lastReviewMessage.get(role.dimension);
    return { ...message, replyTo: messageId ? { title, messageId } : { title } };
  });
}

export function reviewFleetChat(run: ReviewFleetRun): FleetChatEntry[] {
  const speakers = speakersOf(run.agents);
  const speaker = (agent: ReviewFleetAgent) => speakers.get(agent.id)!;
  const byEnd = (left: ReviewFleetAgent, right: ReviewFleetAgent) => (left.endedAt ?? 0) - (right.endedAt ?? 0);
  const answered = run.agents.filter((agent) => agent.status === "done").sort(byEnd);
  const isJudge = (agent: ReviewFleetAgent) => agentRole(agent.label).kind === "judge";
  const judgesLast = [...answered.filter((agent) => !isJudge(agent)), ...answered.filter(isJudge)];
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

function lastStepDoing(lastStep: AnalysisConversationItem | undefined): { tool: string; target?: string } | undefined {
  if (lastStep?.kind !== "tool" || !lastStep.tool) return undefined;
  return lastStep.target ? { tool: lastStep.tool, target: lastStep.target } : { tool: lastStep.tool };
}

export function analysisFleetChat(conversation: AnalysisConversation): FleetChatEntry[] {
  const speakers = speakersOf(conversation.agents.map(({ id, label, modelLabel }) => ({ id, label, model: modelLabel })));
  const spoken = conversation.items.flatMap((item) => {
    const speaker = speakers.get(item.agentId);
    return speaker && item.kind === "text" && item.text ? [{ speaker, at: item.at, text: item.text }] : [];
  });
  const messages: ChatMessage[] = [];
  const sameInstantOrdinals: number[] = [];
  for (const speech of spoken) {
    const previous = messages.at(-1);
    const continuesInstant = previous?.speaker.agentId === speech.speaker.agentId && previous.at === speech.at;
    const sameInstant = continuesInstant ? sameInstantOrdinals.at(-1)! + 1 : 0;
    sameInstantOrdinals.push(sameInstant);
    const id = `${conversation.runId}-${speech.speaker.agentId}-${speech.at}-${sameInstant}`;
    messages.push({ kind: "message", id, speaker: speech.speaker, at: speech.at, reading: readAgentResult(speech.text) });
  }
  const typing = conversation.finished
    ? []
    : conversation.agents
      .filter((agent) => agent.status === "running")
      .map((agent): FleetChatEntry => {
        const doing = lastStepDoing(conversation.items.findLast((item) => item.agentId === agent.id));
        const entry = { kind: "typing" as const, id: `${conversation.runId}-${agent.id}-typing`, speaker: speakers.get(agent.id)! };
        return doing ? { ...entry, doing } : entry;
      });
  return [...withReplies(messages), ...typing];
}

export function isLongSpeech(text: string): boolean {
  return text.length > LONG_SPEECH_CHARS || text.split("\n").length > LONG_SPEECH_LINES;
}

const SAO_PAULO_CLOCK = new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

export function chatClockText(at: number): string {
  return SAO_PAULO_CLOCK.format(new Date(at));
}
