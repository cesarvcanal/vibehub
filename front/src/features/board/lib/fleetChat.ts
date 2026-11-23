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
  | { kind: "stopped"; id: string; speaker: ChatSpeaker; error?: string }
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

function reviewSpeakers(run: ReviewFleetRun): Map<string, ChatSpeaker> {
  return speakersOf(run.agents.map(({ id, label, model, modelLabel }) => ({ id, label, model: modelLabel ?? model })));
}

function resultMessage(runId: string, agent: ReviewFleetAgent, speaker: ChatSpeaker): ChatMessage {
  const reading = readAgentResult(agent.result ?? "");
  const id = `${runId}-${agent.id}`;
  return agent.endedAt === undefined ? { kind: "message", id, speaker, reading } : { kind: "message", id, speaker, at: agent.endedAt, reading };
}

function stoppedEntries(run: ReviewFleetRun, speakers: Map<string, ChatSpeaker>): FleetChatEntry[] {
  return run.agents
    .filter((agent) => agent.status === "stopped")
    .map((agent): FleetChatEntry => {
      const entry = { kind: "stopped" as const, id: `${run.runId}-${agent.id}`, speaker: speakers.get(agent.id)! };
      return agent.error ? { ...entry, error: agent.error } : entry;
    });
}

function reviewTypingEntries(run: ReviewFleetRun, speakers: Map<string, ChatSpeaker>): FleetChatEntry[] {
  if (run.finished) return [];
  return run.agents
    .filter((agent) => agent.status === "running")
    .map((agent): FleetChatEntry => ({ kind: "typing", id: `${run.runId}-${agent.id}`, speaker: speakers.get(agent.id)! }));
}

export function reviewFleetChat(run: ReviewFleetRun): FleetChatEntry[] {
  const speakers = reviewSpeakers(run);
  const byEnd = (left: ReviewFleetAgent, right: ReviewFleetAgent) => (left.endedAt ?? 0) - (right.endedAt ?? 0);
  const answered = run.agents.filter((agent) => agent.status === "done").sort(byEnd);
  const isJudge = (agent: ReviewFleetAgent) => agentRole(agent.label).kind === "judge";
  const judgesLast = [...answered.filter((agent) => !isJudge(agent)), ...answered.filter(isJudge)];
  const messages = judgesLast.map((agent) => resultMessage(run.runId, agent, speakers.get(agent.id)!));
  return [...withReplies(messages), ...stoppedEntries(run, speakers), ...reviewTypingEntries(run, speakers)];
}

function spokenMessages(runId: string, speakers: Map<string, ChatSpeaker>, items: AnalysisConversationItem[]): ChatMessage[] {
  const spoken = items.flatMap((item) => {
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
    const id = `${runId}-${speech.speaker.agentId}-${speech.at}-${sameInstant}`;
    messages.push({ kind: "message", id, speaker: speech.speaker, at: speech.at, reading: readAgentResult(speech.text) });
  }
  return messages;
}

export function reviewConversationChat(run: ReviewFleetRun, conversation: AnalysisConversation): FleetChatEntry[] {
  const speakers = reviewSpeakers(run);
  const spoken = spokenMessages(run.runId, speakers, conversation.items);
  const agentsWhoSpoke = new Set(spoken.map((message) => message.speaker.agentId));
  const silentResults = run.agents
    .filter((agent) => agent.status === "done" && !agentsWhoSpoke.has(agent.id))
    .map((agent) => resultMessage(run.runId, agent, speakers.get(agent.id)!));
  const byTime = (left: ChatMessage, right: ChatMessage) => (left.at ?? 0) - (right.at ?? 0);
  const messages = [...spoken, ...silentResults].sort(byTime);
  return [...withReplies(messages), ...stoppedEntries(run, speakers), ...reviewTypingEntries(run, speakers)];
}

function lastStepDoing(lastStep: AnalysisConversationItem | undefined): { tool: string; target?: string } | undefined {
  if (lastStep?.kind !== "tool" || !lastStep.tool) return undefined;
  return lastStep.target ? { tool: lastStep.tool, target: lastStep.target } : { tool: lastStep.tool };
}

export function analysisFleetChat(conversation: AnalysisConversation): FleetChatEntry[] {
  const speakers = speakersOf(conversation.agents.map(({ id, label, modelLabel }) => ({ id, label, model: modelLabel })));
  const messages = spokenMessages(conversation.runId, speakers, conversation.items);
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
