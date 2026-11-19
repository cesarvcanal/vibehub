import { describe, expect, it } from "vitest";
import type { AnalysisConversation } from "@/api/types";
import { conversationTurns } from "./analysisConversation";

const conversation = (items: AnalysisConversation["items"]): AnalysisConversation => ({
  runId: "wf_a1", finished: false, items,
  agents: [
    { id: "a1", label: "revisão:security", phase: "Revisão", status: "done", modelLabel: "Sonnet 5.5" },
    { id: "a2", label: "juiz", phase: "Julgamento", status: "running" },
  ],
});

describe("conversationTurns", () => {
  it("junta os passos seguidos do mesmo agente numa fala e abre outra quando outro agente fala", () => {
    const turns = conversationTurns(conversation([
      { agentId: "a1", at: 1, kind: "tool", tool: "Read", target: "a.ts" },
      { agentId: "a1", at: 2, kind: "text", text: "achei" },
      { agentId: "a2", at: 3, kind: "text", text: "refutado" },
      { agentId: "a1", at: 4, kind: "text", text: "concordo" },
    ]));
    expect(turns.map((turn) => [turn.agent.id, turn.items.length])).toEqual([["a1", 2], ["a2", 1], ["a1", 1]]);
    expect(turns[0]!.agent.modelLabel).toBe("Sonnet 5.5");
  });

  it("passo de um agente que a lista não traz fica de fora, sem quebrar a conversa", () => {
    const turns = conversationTurns(conversation([
      { agentId: "a9", at: 1, kind: "text", text: "fantasma" },
      { agentId: "a2", at: 2, kind: "text", text: "ok" },
    ]));
    expect(turns.map((turn) => turn.agent.id)).toEqual(["a2"]);
  });
});
