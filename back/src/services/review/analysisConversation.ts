import { effectiveAccountSlug, getProject, type Card } from "../board/registry.js";
import { transcriptDirFor } from "../maestro/cardSession.js";
import { modelLabelFor } from "../maestro/maestro.js";
import { readFleetConversation } from "../sdk/workflow.js";
import type { FleetConversation, FleetConversationAgent } from "../sdk/workflowProbe.js";

export type AnalysisConversationAgent = Omit<FleetConversationAgent, "model"> & { modelLabel?: string };

export type AnalysisConversation = Omit<FleetConversation, "agents"> & { agents: AnalysisConversationAgent[] };

function toReaderAgent({ model, ...agent }: FleetConversationAgent): AnalysisConversationAgent {
  const modelLabel = modelLabelFor(model);
  return modelLabel ? { ...agent, modelLabel } : agent;
}

export async function readCardFleetConversation(card: Card, runId?: string): Promise<AnalysisConversation | null> {
  const project = await getProject(card.projectId);
  if (!project) throw new Error("project not found");
  const conversation = await readFleetConversation(transcriptDirFor(project, card, effectiveAccountSlug(card, project)), runId);
  return conversation && { ...conversation, agents: conversation.agents.map(toReaderAgent) };
}
