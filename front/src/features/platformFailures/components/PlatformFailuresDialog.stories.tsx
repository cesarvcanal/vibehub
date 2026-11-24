import type { Meta, StoryObj } from "@storybook/react-vite";
import type { PlatformFailure } from "@/api/types";
import { PlatformFailuresDialog } from "./PlatformFailuresDialog";

const FIRST_SEEN_AT = Date.UTC(2026, 10, 21, 10, 29);
const LAST_SEEN_AT = Date.UTC(2026, 10, 23, 20, 41);

const GATE_TIMEOUT: PlatformFailure = {
  id: "f-gate",
  signature: "backend_error|backend|gate timed out",
  source: "backend_error",
  status: "concluded_without_fix",
  component: "backend",
  symptom: "gate timed out — killed in the runner: the gate passed its deadline and was killed in the runner",
  evidence: "mensagem: gate timed out — killed in the runner\nerro: the gate passed its deadline and was killed in the runner\nação: maestro.gate",
  occurrences: 10,
  affectedCardIds: [],
  firstSeenAt: FIRST_SEEN_AT,
  lastSeenAt: LAST_SEEN_AT,
  investigationCardId: "card-investigation",
  narrative: {
    context: "Um card do erp-aux pediu a entrega de um PR e o vibehub rodou o gate, a checagem de testes antes do merge.",
    whatHappened: "A checagem de testes antes da entrega passou do prazo e foi parada.",
    cause: "Provavelmente a suíte de testes do projeto é lenta demais para o prazo do gate.",
    trigger: "system",
    triggerReason: "Nenhuma ação de pessoa nos minutos antes do erro.",
  },
  investigationReport: {
    verdict: "not_a_bug",
    conclusion: "O gate fez o que deve: parou a suíte no prazo de 585 s e devolveu vermelho com o aviso. Não é defeito do vibehub.",
    howItHappened: "Nas 10 vezes, o check que estourou foi o npm test padrão, usado quando o projeto não tem .vibehub/gate.json. Ele roda a suíte inteira de todos os workspaces com 2 workers e leva mais de 10 minutos.",
    cause: "O erp-aux não tem um gate próprio nas branches dev e prod, então cai no npm test inteiro, que não cabe no prazo.",
    resolution: "No projeto: um .vibehub/gate.json que rode só os testes afetados pela mudança, ou CI no PR, que a entrega lê antes do gate local.",
    pendingDecision: "Tratar o estouro do npm test padrão como vermelho do projeto, igual a um teste que falha, e não como falha do vibehub?",
    reportedAt: Date.UTC(2026, 10, 24, 13, 15),
  },
};

const DRIVER_EPIPE: PlatformFailure = {
  id: "f-driver",
  signature: "backend_error|sdk-driver|write EPIPE",
  source: "backend_error",
  status: "open",
  component: "sdk-driver",
  symptom: "sdk turn failed: write EPIPE",
  evidence: "Error: write EPIPE\n    at afterWriteDispatched (node:internal/stream_base_commons:161:15)",
  occurrences: 1,
  affectedCardIds: ["card-1"],
  firstSeenAt: LAST_SEEN_AT,
  lastSeenAt: LAST_SEEN_AT,
  narrative: {
    context: "O card Ajustar login estava respondendo uma mensagem da pessoa.",
    whatHappened: "O agente parou de responder no meio do turno.",
    cause: "Provavelmente a conexão com o CLI do Claude caiu enquanto o turno rodava.",
    trigger: "system",
    triggerReason: "Nenhuma ação de pessoa antes do erro.",
  },
};

const SCREEN_ERROR: PlatformFailure = {
  id: "f-screen",
  signature: "screen_error|front|Cannot read properties of undefined",
  source: "screen_error",
  status: "open",
  component: "front",
  symptom: "Cannot read properties of undefined (reading 'title')",
  evidence: "tela: /board\nTypeError: Cannot read properties of undefined (reading 'title')",
  occurrences: 2,
  affectedCardIds: [],
  firstSeenAt: FIRST_SEEN_AT,
  lastSeenAt: LAST_SEEN_AT,
  narrativeUnavailable: "no_api_key",
};

const meta = {
  title: "Platform failures/PlatformFailuresDialog",
  component: PlatformFailuresDialog,
  args: { isOpen: true, isLoadError: false, onOpenChange: () => undefined },
} satisfies Meta<typeof PlatformFailuresDialog>;

export default meta;

type Story = StoryObj<typeof meta>;

export const InvestigatedWithConclusion: Story = { args: { failures: [GATE_TIMEOUT, DRIVER_EPIPE, SCREEN_ERROR] } };
