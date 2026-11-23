import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderApp } from "@/test/render";
import { resetLanguage, setLanguage } from "@/i18n";
import type { FailureNarrative, PlatformFailureNotice } from "@/api/types";
import { FailureDetails } from "./FailureDetails";

vi.mock("@/lib/api", () => ({
  get: vi.fn(async () => ({})),
  post: vi.fn(),
}));

const LONG_CAUSE = "O driver do chat fechou a conexão com o CLI antes de o turno terminar. ".repeat(6).trim();

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

function renderFailure(failure: PlatformFailureNotice) {
  return renderApp(<ul><FailureDetails failure={failure} isOwner={false} /></ul>);
}

beforeEach(() => {
  setLanguage("pt-BR");
  return () => resetLanguage();
});

describe("resumo de cada falha no modal de falhas do vibehub", () => {
  it("falha sem explicação da IA mostra o erro registrado sem abrir os detalhes técnicos", () => {
    renderFailure(buildFailure());
    expect(screen.getByText("Erro registrado")).toBeVisible();
    expect(screen.getByText("sdk turn failed: write EPIPE")).toBeVisible();
  });

  it("falha com explicação da IA mostra contexto, causa e o erro registrado", () => {
    renderFailure(buildFailure({ narrative: buildNarrative() }));
    expect(screen.getByText("O card Ajustar login estava respondendo uma mensagem.")).toBeVisible();
    expect(screen.getByText("Provavelmente a conexão com o CLI caiu.")).toBeVisible();
    expect(screen.getByText("sdk turn failed: write EPIPE")).toBeVisible();
  });

  it("resumo curto aparece inteiro, sem ver mais", () => {
    renderFailure(buildFailure({ narrative: buildNarrative() }));
    expect(screen.getByText("Provavelmente a conexão com o CLI caiu.")).not.toHaveClass("line-clamp-3");
    expect(screen.queryByRole("button", { name: "ver mais" })).toBeNull();
  });

  it("resumo longo vem dobrado e ver mais abre o texto inteiro", async () => {
    renderFailure(buildFailure({ narrative: buildNarrative({ cause: LONG_CAUSE }) }));
    expect(screen.getByText(LONG_CAUSE)).toHaveClass("line-clamp-3");

    await userEvent.click(screen.getByRole("button", { name: "ver mais" }));

    expect(screen.getByText(LONG_CAUSE)).not.toHaveClass("line-clamp-3");
    expect(screen.getByRole("button", { name: "ver menos" })).toHaveAttribute("aria-expanded", "true");
  });
});
