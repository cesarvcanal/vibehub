import type { Meta, StoryObj } from "@storybook/react-vite";
import { WorkflowPanel } from "@/features/board/components/WorkflowPanel";
import type { SdkRow, WorkflowAgentFrame } from "@/features/board/lib/sdkChat";

type WorkflowRow = Extract<SdkRow, { kind: "workflow" }>;

const T0 = Date.UTC(2026, 10, 20, 0, 58);
const USAGE_LIMIT = "You've hit your session limit · resets 1:10am (UTC)";

const agent = (over: Partial<WorkflowAgentFrame> & Pick<WorkflowAgentFrame, "id" | "label">): WorkflowAgentFrame => ({
  status: "done", startedAt: T0, ...over,
});

const failedRun: WorkflowRow = {
  kind: "workflow", id: "wf:wf_lim01", runId: "wf_lim01", name: "vibehub-pr-analysis",
  phases: [{ title: "Contexto" }, { title: "Revisão" }, { title: "Verificação" }, { title: "Julgamento" }],
  startedAt: T0, total: 4, done: 2, at: T0 + 600_000, finished: true, outcome: "failed",
  agents: [
    agent({ id: "a11f", label: "contexto", phase: "Contexto", model: "opus", endedAt: T0 + 90_000, result: "{\"summary\":\"O PR mantém a chamada de voz viva durante o deploy.\"}" }),
    agent({ id: "a12f", label: "revisão: tests", phase: "Revisão", model: "sonnet", endedAt: T0 + 90_000, result: "{\"findings\":[]}" }),
    agent({
      id: "a13f", label: "verificação: tests · Teste de queda afirma logo após startCall, sem esperar o efeito", phase: "Verificação",
      model: "sonnet", status: "stopped", lastAt: T0 + 120_000, error: USAGE_LIMIT,
    }),
    agent({ id: "a14f", label: "juiz", phase: "Julgamento", model: "opus", status: "stopped", lastAt: T0 + 130_000, error: USAGE_LIMIT }),
  ],
};

const meta = {
  title: "Chat/Painel da frota",
  component: WorkflowPanel,
  decorators: [(Story) => <div className="w-full max-w-[40rem]"><Story /></div>],
} satisfies Meta<typeof WorkflowPanel>;
export default meta;
type Story = StoryObj<typeof meta>;

export const FrotaQueFalhouPeloLimiteDeUso: Story = {
  name: "Frota que falhou pelo limite de uso",
  args: { row: failedRun },
};
