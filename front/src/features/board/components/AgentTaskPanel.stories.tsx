import type { Meta, StoryObj } from "@storybook/react-vite";
import { AgentTaskPanel } from "@/features/board/components/AgentTaskPanel";
import { Markdown } from "@/features/board/components/ChatView";

const REVIEW_PROMPT = [
  "Revise a branch atual contra o AGENTS.md da raiz do repositório.",
  "O diff: `git fetch origin main && git diff origin/main...HEAD`",
  "O que o autor afirma: `git log origin/main..HEAD`",
  "O relatório segue \"Como relatar\" (§12 do AGENTS.md) e abre com a lista abaixo marcada.",
  "",
  "- [ ] Achados de violação de regra escrita do AGENTS.md, com a regra citada",
  "- [ ] Achados de contradição ou duplicação entre a regra nova e o resto do AGENTS.md",
  "- [ ] Achados de cheiro da linha de base, marcados como julgamento",
  "- [ ] Veredito apto ou não apto, com o motivo",
].join("\n");

const REVIEW_REPORT = [
  "- [x] Achados de violação de regra escrita do AGENTS.md, com a regra citada",
  "- [x] Achados de contradição ou duplicação entre a regra nova e o resto do AGENTS.md",
  "- [ ] Achados de cheiro da linha de base, marcados como julgamento — o diff é só documentação",
  "- [x] Veredito apto ou não apto, com o motivo",
  "",
  "## Veredito: não apto",
  "",
  "Uma frase nova do AGENTS.md descreve como se já existisse uma tela que ainda não foi feita.",
  "",
  "### O que foi revisado",
  "",
  "A branch só muda o `AGENTS.md`, em três commits:",
  "- a seção nova \"Como relatar\" na §12;",
  "- a regra \"tarefa de subagente vira checklist\" na §15;",
  "- a troca do revisor do fechamento (a revisão que o agente faz antes de entregar).",
  "",
  "### 1. Bloqueia: a regra afirma que a tela já mostra o checklist",
  "",
  "- **Onde:** `AGENTS.md:677`.",
  "- **Cenário:** um agente segue a regra e espera ver caixas marcadas na aba Tarefa, mas vê o prompt como texto corrido.",
  "- **Correção:** tirar a frase, ou reescrevê-la como condição, até a tela existir.",
  "",
  "### 2. Menor: a §12 ainda fala em um revisor só",
  "",
  "O texto antigo continua verdadeiro, mas quem lê só a §12 imagina um revisor.",
].join("\n");

const meta = {
  title: "Chat/Subagente: tarefa e relatório",
  component: AgentTaskPanel,
  decorators: [(Story) => <div className="w-full max-w-[72rem] px-5 py-4 text-sm"><Story /></div>],
} satisfies Meta<typeof AgentTaskPanel>;
export default meta;
type Story = StoryObj<typeof meta>;

export const TaskFinished: Story = {
  name: "Tarefa: terminou, com uma entrega que faltou",
  args: { prompt: REVIEW_PROMPT, report: REVIEW_REPORT, running: false },
};

export const TaskRunning: Story = {
  name: "Tarefa: ainda rodando",
  args: { prompt: REVIEW_PROMPT, report: "", running: true },
};

export const TaskUnmarked: Story = {
  name: "Tarefa: relatório não marcou a lista",
  args: { prompt: REVIEW_PROMPT, report: "Terminei a revisão, tudo certo.", running: false },
};

export const TaskWithoutDeliverables: Story = {
  name: "Tarefa: prompt sem lista de entregas",
  args: { prompt: "Explore o **chat** e ache onde o reducer junta as mensagens.\n\nResponda com o caminho do arquivo.", report: "", running: false },
};

export const Report: Story = {
  name: "Relatório",
  args: { prompt: "", report: REVIEW_REPORT, running: false },
  render: ({ report }) => (
    <div className="rounded-md border border-border bg-card px-5 py-4 text-[13px]">
      <Markdown text={report} variant="document" />
    </div>
  ),
};
