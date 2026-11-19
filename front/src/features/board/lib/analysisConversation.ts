import type { AnalysisConversation, AnalysisConversationAgent, AnalysisConversationItem } from "@/api/types";

export interface ConversationTurn {
  agent: AnalysisConversationAgent;
  items: AnalysisConversationItem[];
}

export function conversationTurns(conversation: AnalysisConversation): ConversationTurn[] {
  const agentsById = new Map(conversation.agents.map((agent) => [agent.id, agent]));
  const knownItems = conversation.items.filter((item) => agentsById.has(item.agentId));
  return knownItems.reduce<ConversationTurn[]>((turns, item) => {
    const lastTurn = turns.at(-1);
    if (lastTurn?.agent.id === item.agentId) return [...turns.slice(0, -1), { ...lastTurn, items: [...lastTurn.items, item] }];
    return [...turns, { agent: agentsById.get(item.agentId)!, items: [item] }];
  }, []);
}
