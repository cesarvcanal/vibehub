import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import type { ReviewFleetAgent, ReviewFleetRun } from "@/api/types";
import { ReviewFleet } from "@/features/board/components/ReviewFleet";
import { resetLanguage, setLanguage } from "@/i18n";

const USAGE_LIMIT = "You've hit your session limit · resets 1:10am (UTC)";

function fleetAgent(overrides: Partial<ReviewFleetAgent>): ReviewFleetAgent {
  return { id: "a1", label: "contexto", phase: "Contexto", status: "done", result: "{\"summary\":\"ok\"}", endedAt: 1, ...overrides };
}

function fleetRun(overrides: Partial<ReviewFleetRun>): ReviewFleetRun {
  const failedJudge: ReviewFleetAgent = { id: "a2", label: "juiz", phase: "Julgamento", status: "stopped", error: USAGE_LIMIT };
  const agents = [fleetAgent({}), failedJudge];
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

  it("o agente que falhou mostra o motivo do harness num aviso com título, não que a frota parou antes", () => {
    render(<ReviewFleet round={1} runs={[fleetRun({ outcome: "failed" })]} />);
    const notice = within(screen.getByTestId("fleet-chat-stopped")).getByRole("note");
    expect(within(notice).getByText("Falhou")).toBeInTheDocument();
    expect(within(notice).getByText(USAGE_LIMIT)).toBeInTheDocument();
    expect(screen.queryByText(/a frota parou antes/)).toBeNull();
  });

  it("o agente que a frota largou sem motivo diz que ela parou antes dele, sem culpar a rodada", () => {
    const abandonedJudge: ReviewFleetAgent = { id: "a2", label: "juiz", phase: "Julgamento", status: "stopped" };
    render(<ReviewFleet round={1} runs={[fleetRun({ outcome: "completed", agents: [fleetAgent({}), abandonedJudge] })]} />);
    const notice = within(screen.getByTestId("fleet-chat-stopped")).getByRole("note");
    expect(within(notice).getByText("Não respondeu")).toBeInTheDocument();
    expect(notice).toHaveTextContent("A frota parou antes de ele terminar (reinício do painel ou rodada encerrada).");
  });
});
