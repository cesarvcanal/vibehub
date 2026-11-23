import * as React from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { useQueryClient } from "@tanstack/react-query";
import { AnalysisPanel } from "@/features/board/components/AnalysisPanel";
import { cardAnalysisConversationKey, cardAnalysisKey } from "@/features/board/lib/analysis";
import { ANALYSIS_DIMENSIONS, type AnalysisConversation, type AnalysisFinding, type AnalysisReadModel, type AnalysisReport, type CardAnalysisResponse } from "@/api/types";

const CARD_ID = "c1";

const ALL_OK: AnalysisReadModel["health"] = {
  correctness: "ok", security: "ok", performance: "ok", contracts: "ok", tests: "ok", repoRules: "ok",
};

const openSessionExpiry: AnalysisFinding = {
  id: "f1", severity: "blocking", dimension: "correctness", status: "open",
  title: "Sessão SSO não expira junto com o token", problem: "Quem perde o acesso no provedor continua logado no vibehub.",
  file: "back/src/auth/sso.ts", line: 84, proof: { kind: "failing_test", ref: "sso.test.ts" }, fix: "Gravar expiresAt na sessão e conferir em cada request.",
};

const fixedBlocking: AnalysisFinding = { ...openSessionExpiry, status: "fixed", commit: "9f3e2c1" };

const openBlocking: AnalysisFinding = {
  id: "f2", severity: "blocking", dimension: "security", status: "open",
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
  uncheckedDimensions: AnalysisReadModel["uncheckedDimensions"] = [],
): AnalysisReadModel => ({ analysis, verdict, health: { ...ALL_OK, repoRules: "skipped", ...health }, uncheckedDimensions, canMerge: false, merging: false });

function SeededAnalysis({ answer, conversation, children }: {
  answer: CardAnalysisResponse; conversation: AnalysisConversation | null; children: React.ReactNode;
}) {
  const client = useQueryClient();
  const [ready] = React.useState(() => {
    client.setQueryDefaults(cardAnalysisKey(CARD_ID), { staleTime: Infinity });
    client.setQueryData(cardAnalysisKey(CARD_ID), answer);
    client.setQueryDefaults(cardAnalysisConversationKey(CARD_ID), { staleTime: Infinity });
    client.setQueryData(cardAnalysisConversationKey(CARD_ID), conversation);
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
      <SeededAnalysis
        answer={parameters.analysis as CardAnalysisResponse}
        conversation={(parameters.conversation as AnalysisConversation | undefined) ?? null}
      >
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
  parameters: { analysis: readModel(report({ findings: [fixedBlocking] }), "apt") },
};

export const AptoComMerge: Story = {
  name: "Apto · com o botão de merge",
  parameters: { analysis: { ...readModel(report({ findings: [fixedBlocking] }), "apt"), canMerge: true } },
};

export const AptoMergeando: Story = {
  name: "Apto · merge rodando no servidor",
  parameters: { analysis: { ...readModel(report({ findings: [fixedBlocking] }), "apt"), canMerge: true, merging: true } },
};

export const AptoMergeBarrado: Story = {
  name: "Apto · último merge barrado pelo gate",
  parameters: {
    analysis: {
      ...readModel(report({ findings: [fixedBlocking] }), "apt"),
      canMerge: true,
      lastMergeRefusal: {
        cardId: CARD_ID, analysedSha: report().analysedSha, reason: "gate", by: "mussa", at: 1,
        output: "✗ npm test (585s, morto por tempo)\nFAIL src/pdv/fechamento.test.ts\nFAIL src/rh/ponto.test.ts",
      },
    },
  },
};

export const Mergeado: Story = {
  name: "Apto · PR já mergeado",
  parameters: { analysis: { ...readModel(report({ findings: [fixedBlocking] }), "apt"), mergedAt: 1 } },
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
      ["security", "tests"],
    ),
  },
};

const fixingReadModel = readModel(
  report({ stage: "analysed", findings: [openSessionExpiry, openQuestion] }),
  "pending",
  { correctness: "problem", security: "attention" },
);

export const Corrigindo: Story = {
  name: "Depois do juiz · corrigindo",
  args: { cardState: "working" },
  parameters: { analysis: fixingReadModel },
};

export const EsperandoDecisao: Story = {
  name: "Depois do juiz · esperando a decisão da pessoa",
  args: { cardState: "needs_me" },
  parameters: { analysis: fixingReadModel },
};

export const ParouSemFechar: Story = {
  name: "Depois do juiz · a IA parou sem fechar",
  args: { cardState: "your_turn" },
  parameters: { analysis: fixingReadModel },
};

const longPathSuggestion: AnalysisFinding = {
  id: "f17", severity: "suggestion", dimension: "correctness", status: "fixed", commit: "7728910a",
  title: "Os timers reagendados no boot não respeitam o `stopped` do orquestrador",
  problem: "`listReviewsWaitingUsageLimit().then(scheduleUsageResume)` roda depois de qualquer stop chamado no mesmo tick.",
  file: "back/src/services/review/orchestrator.ts", line: 1565,
  proof: { kind: "scenario", ref: "back/src/services/review/orchestrator.ts:1565-1569 e 1586-1591", detail: "start seguido de stop no mesmo tick" },
  fix: "Declarar `stopped` antes da leitura e, no `.then`, não agendar se ele já for true.",
};

export const LongPath: Story = {
  name: "Caminho longo · sem rolagem lateral",
  parameters: { analysis: readModel(report({ findings: [fixedBlocking, longPathSuggestion] }), "not_apt") },
};

export const FrotaIndisponivel: Story = {
  name: "Frota indisponível",
  parameters: {
    analysis: readModel(
      report({ stage: "fleet_unavailable", dimensions: [], findings: [], refutedCount: 0, unavailableReason: "a ferramenta Workflow não existe neste CLI" }),
      "not_apt",
      { correctness: "not_run", security: "not_run", performance: "not_run", contracts: "not_run", tests: "not_run", repoRules: "not_run" },
      [...ANALYSIS_DIMENSIONS],
    ),
  },
};

export const SemRelatorio: Story = {
  name: "Sem relatório ainda",
  parameters: { analysis: { analysis: null } satisfies CardAnalysisResponse },
};

const fleetConversation: AnalysisConversation = {
  runId: "wf_813b262f-7ef", finished: false,
  agents: [
    { id: "a1", label: "contexto", phase: "Contexto", status: "done", modelLabel: "Opus 5.5" },
    { id: "a2", label: "revisão: security", phase: "Revisão", status: "done", modelLabel: "Sonnet 5.5" },
    { id: "a3", label: "verificação: security · Sessão SSO não expira", phase: "Verificação", status: "running", modelLabel: "Sonnet 5.5" },
  ],
  items: [
    { agentId: "a1", at: 1, kind: "thinking" },
    { agentId: "a1", at: 2, kind: "tool", tool: "Bash", target: "Lista os arquivos do diff" },
    { agentId: "a1", at: 3, kind: "text", text: "O PR troca a senha local por SSO; o risco está na expiração da sessão e nos testes de login." },
    { agentId: "a2", at: 4, kind: "tool", tool: "Read", target: "back/src/auth/sso.ts" },
    { agentId: "a2", at: 5, kind: "result", text: "export async function ssoCallback(req) { const session = createSession(user) …" },
    { agentId: "a2", at: 6, kind: "text", text: JSON.stringify({ findings: [{ title: "Sessão SSO não expira junto com o token" }, { title: "Callback aceita state reaproveitado" }] }) },
    { agentId: "a3", at: 7, kind: "tool", tool: "Grep", target: "expiresAt" },
    { agentId: "a3", at: 8, kind: "text", text: JSON.stringify({ confirmed: true, evidence: "createSession não recebe o exp do token: a sessão vive 30 dias" }) },
  ],
};

export const Conversa: Story = {
  name: "Conversa · frota conversando",
  parameters: { analysis: readModel(report({ findings: [fixedBlocking] }), "apt"), conversation: fleetConversation },
};
