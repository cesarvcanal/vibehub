import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderApp } from "@/test/render";
import { resetLanguage, setLanguage } from "@/i18n";
import type { FailureInvestigationReport, FailureNarrative, PlatformFailureNotice } from "@/api/types";
import { FailureDetails } from "./FailureDetails";

vi.mock("@/lib/api", () => ({
  get: vi.fn(async () => ({})),
  post: vi.fn(),
}));

function buildFailure(details: Partial<NonNullable<PlatformFailureNotice["details"]>> = {}): PlatformFailureNotice {
  return {
    id: "f-driver",
    source: "backend_error",
    status: "concluded_without_fix",
    occurrences: 2,
    firstSeenAt: 1_000,
    lastSeenAt: 2_000,
    details: {
      symptom: "sdk turn failed: write EPIPE",
      component: "sdk-driver",
      evidence: "Error: write EPIPE\n    at afterWriteDispatched",
      ...details,
    },
  };
}

function buildNarrative(narrative: Partial<FailureNarrative> = {}): FailureNarrative {
  return {
    context: "O card Ajustar login estava respondendo uma mensagem.",
    whatHappened: "O agente parou de responder no meio do turno.",
    cause: "Provavelmente a conexão com o CLI caiu.",
    trigger: "system",
    triggerReason: "Nenhuma ação de pessoa antes do erro.",
    ...narrative,
  };
}

function buildInvestigationReport(report: Partial<FailureInvestigationReport> = {}): FailureInvestigationReport {
  return {
    verdict: "not_a_bug",
    conclusion: "O gate parou a suíte no prazo, como deve.",
    howItHappened: "O projeto não tem gate próprio e o npm test inteiro passou de 10 minutos.",
    cause: "A suíte do projeto é lenta demais para o prazo do gate.",
    resolution: "Criar no projeto um gate que rode só os testes afetados.",
    reportedAt: 3_000,
    ...report,
  };
}

function renderFailure(failure: PlatformFailureNotice) {
  return renderApp(<ul><FailureDetails failure={failure} isOwner={false} /></ul>);
}

beforeEach(() => {
  setLanguage("pt-BR");
  return () => resetLanguage();
});

describe("cada falha no modal de falhas do vibehub, como uma análise", () => {
  it("falha sem explicação nem conclusão mostra o erro registrado", () => {
    renderFailure(buildFailure());
    expect(screen.getByText("Erro registrado")).toBeVisible();
    expect(screen.getByText("sdk turn failed: write EPIPE")).toBeVisible();
  });

  it("com a conclusão da investigação, o veredito e a conclusão aparecem sem abrir a análise", () => {
    renderFailure(buildFailure({ investigationReport: buildInvestigationReport() }));
    expect(screen.getByText("Não é bug do vibehub")).toBeVisible();
    expect(screen.getByText("O gate parou a suíte no prazo, como deve.")).toBeVisible();
    expect(screen.queryByText("A investigação terminou sem deixar conclusão. Investigue de novo para ter a análise.")).toBeNull();
  });

  it("a decisão que ficou para o dono aparece sem abrir a análise", () => {
    renderFailure(buildFailure({ investigationReport: buildInvestigationReport({ pendingDecision: "Tratar o estouro como vermelho do projeto?" }) }));
    expect(screen.getByText("Decisão sua")).toBeVisible();
    expect(screen.getByText("Tratar o estouro como vermelho do projeto?")).toBeVisible();
  });

  it("abrir a análise mostra contexto, como ocorreu, por que e o que resolve", async () => {
    renderFailure(buildFailure({ narrative: buildNarrative(), investigationReport: buildInvestigationReport() }));
    expect(screen.queryByText("O projeto não tem gate próprio e o npm test inteiro passou de 10 minutos.")).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "Ver análise completa" }));

    for (const [label, text] of [
      ["Contexto", "O card Ajustar login estava respondendo uma mensagem."],
      ["Como ocorreu", "O projeto não tem gate próprio e o npm test inteiro passou de 10 minutos."],
      ["Por que aconteceu", "A suíte do projeto é lenta demais para o prazo do gate."],
      ["O que resolve", "Criar no projeto um gate que rode só os testes afetados."],
      ["Erro registrado", "sdk turn failed: write EPIPE"],
    ]) {
      expect(screen.getByText(label!)).toBeVisible();
      expect(screen.getByText(text!)).toBeVisible();
    }
    expect(screen.getByRole("button", { name: "Fechar análise" })).toHaveAttribute("aria-expanded", "true");
  });

  it("a causa achada pela investigação vale sobre a causa provável escrita pela IA", async () => {
    renderFailure(buildFailure({ narrative: buildNarrative(), investigationReport: buildInvestigationReport() }));
    await userEvent.click(screen.getByRole("button", { name: "Ver análise completa" }));
    expect(screen.queryByText("Provavelmente a conexão com o CLI caiu.")).toBeNull();
  });

  it("sem conclusão da investigação, a análise usa o contexto e a causa provável da IA", async () => {
    renderFailure(buildFailure({ narrative: buildNarrative() }));
    expect(screen.getByText("O agente parou de responder no meio do turno.")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Ver análise completa" }));
    expect(screen.getByText("O card Ajustar login estava respondendo uma mensagem.")).toBeVisible();
    expect(screen.getByText("Provavelmente a conexão com o CLI caiu.")).toBeVisible();
  });

  it("em nova investigação, a conclusão anterior sai do topo e aparece na análise como investigação anterior", async () => {
    renderFailure({ ...buildFailure({ previousInvestigationReport: buildInvestigationReport() }), status: "investigating" });
    expect(screen.queryByText("Não é bug do vibehub")).toBeNull();
    expect(screen.queryByText("O gate parou a suíte no prazo, como deve.")).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "Ver análise completa" }));

    expect(screen.getByText("Investigação anterior")).toBeVisible();
    expect(screen.getByText("Não é bug do vibehub: O gate parou a suíte no prazo, como deve.")).toBeVisible();
  });

  it("investigada sem conclusão gravada diz que o card não deixou conclusão", () => {
    renderFailure(buildFailure());
    expect(screen.getByText("A investigação terminou sem deixar conclusão. Investigue de novo para ter a análise.")).toBeVisible();
  });
});
