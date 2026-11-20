import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import type { ReviewFleetAgent, ReviewFleetRun } from "@/api/types";
import { ReviewFleet } from "@/features/board/components/ReviewFleet";
import { resetLanguage, setLanguage } from "@/i18n";

const USAGE_LIMIT = "You've hit your session limit · resets 1:10am (UTC)";

function fleetAgent(overrides: Partial<ReviewFleetAgent>): ReviewFleetAgent {
  return { id: "a1", label: "contexto", phase: "Contexto", status: "done", result: "{\"summary\":\"ok\"}", endedAt: 1, ...overrides };
}

function fleetRun(overrides: Partial<ReviewFleetRun>): ReviewFleetRun {
  const agents = [fleetAgent({}), fleetAgent({ id: "a2", label: "juiz", phase: "Julgamento", status: "stopped", error: USAGE_LIMIT, result: undefined })];
  return { runId: "wf_1", name: "vibehub-pr-analysis", phases: ["Contexto", "Julgamento"], total: 2, done: 1, agents, at: 1, finished: true, ...overrides };
}

describe("ReviewFleet — como a rodada da frota terminou", () => {
  beforeEach(() => setLanguage("pt-BR"));
  afterEach(() => resetLanguage());

  it.each([
    ["failed", "Frota interrompida · 1 de 2 responderam"],
    ["killed", "Frota interrompida · 1 de 2 responderam"],
    ["completed", "Agentes concluídos · 1 de 2"],
  ] as const)("desfecho %s: a faixa diz %s", (outcome, strip) => {
    render(<ReviewFleet round={1} runs={[fleetRun({ outcome })]} />);
    expect(screen.getByTestId("review-fleet-strip")).toHaveTextContent(strip);
  });

  it("o agente que falhou mostra o motivo do harness, não que a rodada terminou antes", () => {
    render(<ReviewFleet round={1} runs={[fleetRun({ outcome: "failed" })]} />);
    expect(screen.getByTestId("fleet-chat-stopped")).toHaveTextContent(`Falhou: ${USAGE_LIMIT}`);
    expect(screen.queryByText("Parou sem responder: a rodada terminou antes.")).toBeNull();
  });
});
