import * as React from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { useQueryClient } from "@tanstack/react-query";
import { AnalysisPanel } from "@/features/board/components/AnalysisPanel";
import { cardAnalysisKey } from "@/features/board/lib/analysis";
import type { AnalysisFinding, AnalysisReadModel, AnalysisReport, CardAnalysisResponse, DimensionHealth } from "@/api/types";

const CARD_ID = "c1";

const ALL_OK: Record<AnalysisReport["dimensions"][number]["key"], DimensionHealth> = {
  correctness: "ok", security: "ok", performance: "ok", contracts: "ok", tests: "ok", repoRules: "ok",
};

const fixedBlocking: AnalysisFinding = {
  id: "f1", severity: "blocking", dimension: "correctness", status: "fixed", commit: "9f3e2c1",
  title: "Sessão SSO não expira junto com o token", problem: "Quem perde o acesso no provedor continua logado no vibehub.",
  file: "back/src/auth/sso.ts", line: 84, proof: { kind: "failing_test", ref: "sso.test.ts" }, fix: "Gravar expiresAt na sessão e conferir em cada request.",
};

const openBlocking: AnalysisFinding = {
  ...fixedBlocking, id: "f2", status: "open", commit: undefined, dimension: "security",
  title: "Callback do SSO aceita state reaproveitado", problem: "Um link de login interceptado pode ser usado de novo.",
  file: "back/src/auth/sso.ts", line: 132, proof: { kind: "scenario", ref: "sso.ts:132", detail: "o mesmo state duas vezes entra duas vezes" },
  fix: "Apagar o state na primeira leitura.",
};

const openQuestion: AnalysisFinding = {
  id: "f3", severity: "question", dimension: "security", status: "open",
  title: "Conta local continua aceitando senha?", problem: "Pode ser a intenção (acesso de emergência) ou uma brecha.",
  fix: "Decidir se a senha local fica só para o dono da instalação.",
};

const report = (over: Partial<AnalysisReport> = {}): AnalysisReport => ({
  cardId: CARD_ID, prUrl: "https://github.com/cesarvcanal/vibehub/pull/312", prNumber: 312, analysedSha: "a1b2c3d".padEnd(40, "0"),
  stage: "done", summary: "Login por SSO no lugar da senha local.", refutedCount: 5, updatedAt: 1,
  dimensions: [
    { key: "correctness", status: "ran" }, { key: "security", status: "ran" }, { key: "performance", status: "ran" },
    { key: "contracts", status: "ran" }, { key: "tests", status: "ran" },
    { key: "repoRules", status: "skipped", reason: "o diff só toca configuração" },
  ],
  findings: [fixedBlocking, openQuestion],
  ...over,
});

const readModel = (
  analysis: AnalysisReport, verdict: AnalysisReadModel["verdict"], health: Partial<AnalysisReadModel["health"]> = {},
): AnalysisReadModel => ({ analysis, verdict, health: { ...ALL_OK, repoRules: "skipped", ...health } });

function SeededAnalysis({ answer, children }: { answer: CardAnalysisResponse; children: React.ReactNode }) {
  const client = useQueryClient();
  const [ready] = React.useState(() => {
    client.setQueryDefaults(cardAnalysisKey(CARD_ID), { staleTime: Infinity });
    client.setQueryData(cardAnalysisKey(CARD_ID), answer);
    return true;
  });
  return ready ? <>{children}</> : null;
}

const meta: Meta<typeof AnalysisPanel> = {
  title: "Análise de PR/Painel da análise",
  component: AnalysisPanel,
  args: { cardId: CARD_ID, onClose: () => undefined },
  decorators: [
    (Story, { parameters }) => (
      <SeededAnalysis answer={parameters.analysis as CardAnalysisResponse}>
        <div className="flex h-[80vh] max-w-md flex-col">
          <Story />
        </div>
      </SeededAnalysis>
    ),
  ],
};
export default meta;
type Story = StoryObj<typeof AnalysisPanel>;

export const Apto: Story = {
  parameters: { analysis: readModel(report(), "apt", { security: "attention" }) },
};

export const NaoAptoComBloqueante: Story = {
  name: "Não apto · bloqueante aberto",
  parameters: {
    analysis: readModel(report({ findings: [fixedBlocking, openBlocking, openQuestion] }), "not_apt", { security: "problem" }),
  },
};

export const NaoAptoSemConferencia: Story = {
  name: "Não apto · dimensão sem conferência",
  parameters: {
    analysis: readModel(
      report({
        dimensions: [
          { key: "correctness", status: "ran" }, { key: "security", status: "not_run", reason: "o agente de revisão não respondeu" },
          { key: "performance", status: "ran" }, { key: "contracts", status: "ran" },
          { key: "tests", status: "ran", unverifiedCount: 3, reason: "3 achados acima do teto de 15 não foram verificados" },
          { key: "repoRules", status: "skipped", reason: "o diff só toca configuração" },
        ],
        findings: [fixedBlocking],
      }),
      "not_apt",
      { security: "not_run", tests: "attention" },
    ),
  },
};

export const Corrigindo: Story = {
  name: "Depois do juiz · corrigindo",
  parameters: {
    analysis: readModel(
      report({ stage: "analysed", findings: [{ ...fixedBlocking, status: "open", commit: undefined }, openQuestion] }),
      "pending",
      { correctness: "problem", security: "attention" },
    ),
  },
};

export const FrotaIndisponivel: Story = {
  name: "Frota indisponível",
  parameters: {
    analysis: readModel(
      report({ stage: "fleet_unavailable", dimensions: [], findings: [], refutedCount: 0, unavailableReason: "a ferramenta Workflow não existe neste CLI" }),
      "not_apt",
      { correctness: "not_run", security: "not_run", performance: "not_run", contracts: "not_run", tests: "not_run", repoRules: "not_run" },
    ),
  },
};

export const SemRelatorio: Story = {
  name: "Sem relatório ainda",
  parameters: { analysis: { analysis: null } satisfies CardAnalysisResponse },
};
