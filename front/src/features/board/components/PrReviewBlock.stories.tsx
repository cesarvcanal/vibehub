import type { Meta, StoryObj } from "@storybook/react-vite";
import { PrReviewBlock } from "@/features/board/components/PrReviewBlock";
import type { CardPr } from "@/api/types";

/** The PR line above the composer, in every state its review can be in. */
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
export const IaMexendo: Story = {
  name: "Pronto, mas a IA do autor está mexendo",
  args: { review: { id: "r1", prNumber: 211, phase: "ready", round: 1 }, authorWorking: true },
};
export const Impasse: Story = { name: "Impasse", args: { review: { id: "r1", prNumber: 211, phase: "impasse", round: 3 } } };
export const Mergeado: Story = { name: "Mergeado", args: { review: { id: "r1", prNumber: 211, phase: "merged", round: 2 } } };
