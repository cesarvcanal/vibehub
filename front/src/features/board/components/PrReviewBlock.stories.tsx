import * as React from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { useQueryClient } from "@tanstack/react-query";
import { PrReviewBlock } from "@/features/board/components/PrReviewBlock";
import { cardAnalysisKey } from "@/features/board/lib/analysis";
import {
  ANALYSIS_DIMENSIONS, type AnalysisFinding, type AnalysisReadModel, type AnalysisReport, type CardAnalysisResponse, type CardPr,
} from "@/api/types";

/** The PR line above the composer, in every state its review can be in while the PR is open (a merged one leaves). */
const PR: CardPr = {
  number: 211, url: "https://github.com/cesarvcanal/vibehub/pull/211", base: "main", branch: "card/ajuste-layout-240c", openedAt: 1,
};

const meta = {
  title: "Revisão de PR/Bloco do PR no card",
  component: PrReviewBlock,
  args: { cardId: "c1", pr: PR, onOpenPanel: () => {} },
  decorators: [(Story) => <div className="max-w-3xl"><Story /></div>],
} satisfies Meta<typeof PrReviewBlock>;
export default meta;
type Story = StoryObj<typeof meta>;

export const SemRevisao: Story = { name: "Sem revisão" };
export const RevisorLendo: Story = { name: "Revisor lendo (rodada 1)", args: { review: { id: "r1", prNumber: 211, phase: "reviewing", round: 1 } } };
export const AutorCorrigindo: Story = { name: "Autor corrigindo (rodada 2)", args: { review: { id: "r1", prNumber: 211, phase: "fixing", round: 2 } } };
export const AguardandoDecisao: Story = {
  name: "Dúvida esperando decisão",
  args: { review: { id: "r1", prNumber: 211, phase: "reviewing", round: 1, pendingQuestions: 1 } },
};
export const Pronto: Story = { name: "Pronto pra merge", args: { review: { id: "r1", prNumber: 211, phase: "ready", round: 1 } } };
export const IaTrabalhando: Story = {
  name: "Pronto, mas a IA do autor está trabalhando",
  args: { review: { id: "r1", prNumber: 211, phase: "ready", round: 1 }, authorWorking: true },
};
export const Impasse: Story = { name: "Impasse", args: { review: { id: "r1", prNumber: 211, phase: "impasse", round: 3 } } };

function SeededAnalysis({ answer, children }: { answer: CardAnalysisResponse; children: React.ReactNode }) {
  const client = useQueryClient();
  const [ready] = React.useState(() => {
    client.setQueryDefaults(cardAnalysisKey("c1"), { staleTime: Infinity });
    client.setQueryData(cardAnalysisKey("c1"), answer);
    return true;
  });
  return ready ? <>{children}</> : null;
}

const fixedFinding: AnalysisFinding = {
  id: "f1", severity: "blocking", dimension: "tests", status: "fixed", commit: "abc1234", title: "t", problem: "p", fix: "x",
  proof: { kind: "failing_test", ref: "a.test.ts" },
};

const analysisReport = (over: Partial<AnalysisReport> = {}): AnalysisReport => ({
  cardId: "c1", prUrl: PR.url, prNumber: PR.number, analysedSha: "b".repeat(40), stage: "done", summary: "s", refutedCount: 2, updatedAt: 1,
  dimensions: ANALYSIS_DIMENSIONS.map((key) => ({ key, status: "ran" as const })),
  findings: [fixedFinding],
  ...over,
});

const healthOk: AnalysisReadModel["health"] = {
  correctness: "ok", security: "ok", performance: "ok", contracts: "ok", tests: "ok", repoRules: "ok",
};

const analysisStory = (name: string, answer: CardAnalysisResponse, cardWorking = false): Story => ({
  name,
  args: { analysis: true, cardWorking },
  decorators: [(Story) => <SeededAnalysis answer={answer}><Story /></SeededAnalysis>],
});

export const AnaliseAnalisando = analysisStory("Análise · a frota está rodando", { analysis: null }, true);
export const AnaliseSemRelatorio = analysisStory("Análise · card parou sem relatório", { analysis: null });
export const AnaliseCorrigindo = analysisStory("Análise · depois do juiz, corrigindo", {
  analysis: analysisReport({ stage: "analysed", findings: [{ ...fixedFinding, status: "open", commit: undefined }] }),
  health: { ...healthOk, tests: "problem" },
  verdict: "pending",
}, true);
export const AnaliseApta = analysisStory("Análise · apta", { analysis: analysisReport(), health: healthOk, verdict: "apt" });
export const AnaliseNaoAptaSemConferencia = analysisStory("Análise · não apta, dimensão sem conferência", {
  analysis: analysisReport({ dimensions: ANALYSIS_DIMENSIONS.map((key) => ({ key, status: key === "security" ? "not_run" as const : "ran" as const })) }),
  health: { ...healthOk, security: "not_run" },
  verdict: "not_apt",
});
export const AnaliseFrotaIndisponivel = analysisStory("Análise · frota indisponível", {
  analysis: analysisReport({ stage: "fleet_unavailable", dimensions: [], findings: [], refutedCount: 0, unavailableReason: "sem Workflow" }),
  health: { correctness: "not_run", security: "not_run", performance: "not_run", contracts: "not_run", tests: "not_run", repoRules: "not_run" },
  verdict: "not_apt",
});
