import type { Meta, StoryObj } from "@storybook/react-vite";
import { AgentTimelineView } from "@/features/board/components/SdkDetail";
import type { TimelineItem } from "@/features/board/lib/sdkDetail";

const T0 = Date.UTC(2026, 10, 20, 12, 41, 19);
const second = (n: number) => T0 + n * 1000;

const REVIEW_TIMELINE: TimelineItem[] = [
  { kind: "text", at: second(2), text: "Vou ler o diff e o AGENTS.md para confrontar cada linha nova com as regras." },
  { kind: "tool", at: second(3), endedAt: second(6), id: "t1", name: "Bash", input: { description: "Buscando o diff da branch", command: "git fetch origin main && git diff origin/main...HEAD" }, result: { lines: 412 } },
  { kind: "tool", at: second(7), endedAt: second(8), id: "t2", name: "Read", input: { file_path: "/work/vibehub/AGENTS.md" }, result: { lines: 700 } },
  { kind: "tool", at: second(9), endedAt: second(10), id: "t3", name: "Read", input: { file_path: "/work/vibehub/front/src/features/board/lib/agentDeliverables.ts" }, result: { lines: 72 } },
  { kind: "thinking", at: second(12), text: "A leitura junta todas as listas do relatório, não só a primeira. Um relatório com uma segunda lista de próximos passos quebraria o casamento por posição." },
  { kind: "text", at: second(30), text: "Achei um caso que quebra: um relatório com uma segunda lista de **próximos passos**. Vou reproduzir com um script." },
  { kind: "tool", at: second(31), endedAt: second(32), id: "t4", name: "Grep", input: { pattern: "readOpeningTaskList", path: "front/src" }, result: { lines: 2 } },
  { kind: "tool", at: second(33), id: "t5", name: "Bash", input: { description: "Reproduzindo com tsx", command: "npx tsx /tmp/repro.ts" } },
];

const meta = {
  title: "Chat/Subagente: linha do tempo",
  component: AgentTimelineView,
  decorators: [(Story) => <div className="w-full max-w-[72rem] px-5 py-4 text-sm"><Story /></div>],
  args: { agentName: "Code review · padrões", onOpen: () => undefined },
} satisfies Meta<typeof AgentTimelineView>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Working: Story = {
  name: "Trabalhando, com uma ação rodando",
  args: { items: REVIEW_TIMELINE },
};

export const OnlyActions: Story = {
  name: "Só ações, sem fala",
  args: { items: REVIEW_TIMELINE.filter((item) => item.kind === "tool").slice(0, 4) },
};
