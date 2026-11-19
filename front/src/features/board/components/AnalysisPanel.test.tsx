import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { cleanup, configure, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { apiReject, renderApp, setupState } from "@/test/render";
import { AnalysisPanel } from "./AnalysisPanel";
import { LANGUAGE_KEY, setLanguage } from "@/i18n";
import { ANALYSIS_DIMENSIONS, type AnalysisReadModel, type AnalysisReport, type CardAnalysisResponse } from "@/api/types";

vi.setConfig({ testTimeout: 30_000 });
configure({ asyncUtilTimeout: 8_000 });

const get = vi.fn();
vi.mock("@/lib/api", () => ({
  get: (...a: unknown[]) => get(...a),
  post: vi.fn(),
  del: vi.fn(),
  patch: vi.fn(),
}));

const doneReport = (over: Partial<AnalysisReport> = {}): AnalysisReport => ({
  cardId: "c1", prUrl: "https://github.com/acme/w/pull/312", prNumber: 312, analysedSha: "a1b2c3d".padEnd(40, "0"),
  stage: "done", summary: "Login por SSO no lugar da senha local.", refutedCount: 5, updatedAt: 1,
  dimensions: [
    { key: "correctness", status: "ran" }, { key: "security", status: "ran" }, { key: "performance", status: "ran" },
    { key: "contracts", status: "ran" }, { key: "tests", status: "ran" },
    { key: "repoRules", status: "skipped", reason: "o diff só toca configuração" },
  ],
  findings: [
    {
      id: "f1", severity: "blocking", dimension: "correctness", status: "fixed", commit: "9f3e2c1",
      title: "Sessão SSO não expira com o token", problem: "Quem perde o acesso continua logado.",
      file: "back/src/auth/sso.ts", line: 84, proof: { kind: "failing_test", ref: "sso.test.ts" }, fix: "Gravar expiresAt.",
    },
    {
      id: "f3", severity: "question", dimension: "security", status: "open",
      title: "Conta local continua aceitando senha?", problem: "Pode ser a intenção ou uma brecha.",
    },
  ],
  ...over,
});

const readModel = (
  report: AnalysisReport, verdict: AnalysisReadModel["verdict"], health: Partial<AnalysisReadModel["health"]> = {},
  uncheckedDimensions: AnalysisReadModel["uncheckedDimensions"] = [],
): AnalysisReadModel => ({
  analysis: report,
  health: { correctness: "ok", security: "attention", performance: "ok", contracts: "ok", tests: "ok", repoRules: "skipped", ...health },
  verdict,
  uncheckedDimensions,
});

function renderPanel(analysisAnswer: CardAnalysisResponse | Promise<CardAnalysisResponse>, onClose: () => void = () => {}) {
  get.mockImplementation(async (url: string) => {
    if (url === "/auth/me") return { user: { id: "u1", username: "mussa", role: "member" } };
    if (url === "/setup/state") return setupState();
    if (url === "/cards/c1/analysis") return analysisAnswer;
    throw new Error(`unexpected ${url}`);
  });
  return renderApp(<AnalysisPanel cardId="c1" onClose={onClose} />);
}

beforeEach(() => {
  vi.clearAllMocks();
  setLanguage("pt-BR");
});
afterEach(() => {
  cleanup();
  localStorage.removeItem(LANGUAGE_KEY);
  setLanguage("en");
});

describe("painel da análise de PR", () => {
  it("mostra o veredito, as contagens e o estado de cada dimensão com o motivo de quem não rodou", async () => {
    renderPanel(readModel(doneReport(), "not_apt"));
    expect(await screen.findByRole("heading", { name: "Análise do PR #312" })).toBeInTheDocument();
    expect(screen.getByText("Não apto")).toBeInTheDocument();
    expect(screen.getByText("1 corrigido")).toBeInTheDocument();
    expect(screen.getByText("1 dúvida aberta")).toBeInTheDocument();
    expect(screen.getByText("5 derrubados na verificação")).toBeInTheDocument();
    const dimensions = screen.getByRole("list", { name: "Dimensões revisadas" });
    expect(within(dimensions).getByText("Segurança")).toBeInTheDocument();
    expect(within(dimensions).getByText("atenção")).toBeInTheDocument();
    expect(within(dimensions).getByText("fora do diff")).toBeInTheDocument();
    expect(within(dimensions).getByText("o diff só toca configuração")).toBeInTheDocument();
  });

  it("dimensão que rodou com achado não verificado aparece em atenção, com o motivo, ao lado do não apto que o servidor manda", async () => {
    const dimensions = doneReport().dimensions.map((dimension) => dimension.key === "tests"
      ? { ...dimension, unverifiedCount: 2, reason: "2 achados sem veredito (o verificador não respondeu)" }
      : dimension);
    renderPanel(readModel(doneReport({ dimensions }), "not_apt", { tests: "attention" }, ["tests"]));
    expect(await screen.findByText("Não apto")).toBeInTheDocument();
    const testsDimension = within(screen.getByRole("list", { name: "Dimensões revisadas" })).getByText("Testes").closest("li")!;
    expect(within(testsDimension).getByText("atenção")).toBeInTheDocument();
    expect(within(testsDimension).getByText("2 achados sem veredito (o verificador não respondeu)")).toBeInTheDocument();
  });

  it("agrupa os achados por classe, com arquivo:linha, prova e o commit que corrigiu", async () => {
    renderPanel(readModel(doneReport(), "not_apt"));
    const blockers = await screen.findByRole("region", { name: "Bloqueantes" });
    expect(within(blockers).getByText("Sessão SSO não expira com o token")).toBeInTheDocument();
    expect(within(blockers).getByText("back/src/auth/sso.ts:84")).toBeInTheDocument();
    expect(within(blockers).getByText("corrigido em 9f3e2c1")).toBeInTheDocument();
    expect(within(blockers).getByText("teste que falha · sso.test.ts")).toBeInTheDocument();
    const questions = screen.getByRole("region", { name: "Dúvidas" });
    expect(within(questions).getByText("esperando decisão")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Sugestões" })).not.toBeInTheDocument();
  });

  it("a prova mostra o detalhe que o achado traz, junto do tipo e da referência", async () => {
    const [fixedBlocking, openQuestion] = doneReport().findings;
    const withDetail = { ...fixedBlocking!, proof: { kind: "scenario" as const, ref: "sso.ts:84", detail: "token expirado continua entrando" } };
    renderPanel(readModel(doneReport({ findings: [withDetail, openQuestion!] }), "not_apt"));
    const blockers = await screen.findByRole("region", { name: "Bloqueantes" });
    expect(within(blockers).getByText("cenário · sso.ts:84")).toBeInTheDocument();
    expect(within(blockers).getByText("token expirado continua entrando")).toBeInTheDocument();
  });

  it("frota indisponível mostra o motivo e o que fazer, sem achado nenhum", async () => {
    renderPanel(readModel(
      doneReport({ stage: "fleet_unavailable", unavailableReason: "the Workflow tool is not available", findings: [], dimensions: [] }),
      "not_apt",
      { correctness: "not_run", security: "not_run", performance: "not_run", contracts: "not_run", tests: "not_run", repoRules: "not_run" },
      [...ANALYSIS_DIMENSIONS],
    ));
    expect(await screen.findByText("A frota de agentes não rodou neste card")).toBeInTheDocument();
    expect(screen.getByText("the Workflow tool is not available")).toBeInTheDocument();
    expect(screen.getByText("Frota indisponível")).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Dimensões revisadas" })).not.toBeInTheDocument();
  });

  it("card sem relatório ainda diz que a frota não gravou e aponta o painel de workflow", async () => {
    renderPanel({ analysis: null });
    expect(await screen.findByText(/A frota de agentes ainda não gravou o relatório/)).toBeInTheDocument();
  });

  it("enquanto a leitura não chega, diz carregando e nada do relatório", async () => {
    renderPanel(new Promise<CardAnalysisResponse>(() => {}));
    expect(await screen.findByText("Carregando")).toBeInTheDocument();
    expect(screen.queryByText(/A frota de agentes ainda não gravou o relatório/)).not.toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Dimensões revisadas" })).not.toBeInTheDocument();
  });

  it("leitura que falhou mostra o erro do servidor, nunca o painel vazio de sem relatório", async () => {
    renderPanel(Promise.reject(apiReject(500, "analysis store unreadable")));
    expect(await screen.findByText("analysis store unreadable")).toBeInTheDocument();
    expect(screen.queryByText("Carregando")).not.toBeInTheDocument();
    expect(screen.queryByText(/A frota de agentes ainda não gravou o relatório/)).not.toBeInTheDocument();
  });

  it("o botão de fechar fecha o painel", async () => {
    const onClose = vi.fn();
    renderPanel(readModel(doneReport(), "not_apt"), onClose);
    await userEvent.click(await screen.findByRole("button", { name: "Fechar a análise" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
