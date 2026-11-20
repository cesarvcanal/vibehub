import type { Meta, StoryObj } from "@storybook/react-vite";
import { CardWaitNotice } from "@/features/board/components/CardWaitNotice";
import { CardTile } from "@/features/board/components/CardTile";
import type { CardWait } from "@/api/types";

const WAIT: CardWait = {
  cardId: "d3497d82",
  instruction: "Faça o PR complementar da captura de falhas: ligue o aviso no celular e cubra com teste o erro que ficava mudo.",
  createdAt: 1,
  createdBy: "u1",
};
const TARGET_TITLE = "Captura de falha da plataforma pega todo erro real e avisa o dono em qualquer tela";
const READY_WAIT: CardWait = { ...WAIT, readyAt: 2, outcome: "pr_merged", prNumber: 356 };
const FAILED_WAIT: CardWait = { ...READY_WAIT, failure: { at: 3, reason: "the terminal for card \"auto-aprimorável\" has no live session" } };

const meta = {
  title: "Card/Espera por outro card",
  render: ({ width }) => (
    <div className="flex gap-6">
      <div className="space-y-3" style={{ width }}>
        <CardWaitNotice cardId="a9e64bf6" wait={WAIT} waitTargetTitle={TARGET_TITLE} />
        <CardWaitNotice cardId="a9e64bf6" wait={READY_WAIT} waitTargetTitle={TARGET_TITLE} />
        <CardWaitNotice cardId="a9e64bf6" wait={FAILED_WAIT} />
      </div>
      <div className="w-72 space-y-2">
        {[
          { waitingFor: WAIT, waitTargetTitle: TARGET_TITLE },
          { waitingFor: WAIT, waitTargetTitle: undefined },
          { waitingFor: FAILED_WAIT, waitTargetTitle: "Captura de falhas" },
        ].map((wait, index) => (
          <CardTile
            key={index}
            card={{
              id: `card-${index}`, projectId: "p1", title: "auto-aprimorável não funcionando", column: "waiting", position: index,
              tmuxSession: `card-${index}`, worktreeSlug: `auto-${index}`, createdAt: 1, ...wait,
            }}
            onOpen={() => undefined}
          />
        ))}
      </div>
    </div>
  ),
} satisfies Meta<{ width: number }>;
export default meta;
type Story = StoryObj<typeof meta>;

export const ChatWidth: Story = { name: "Largura do chat", args: { width: 760 } };
export const NarrowCard: Story = { name: "Card estreito", args: { width: 380 } };
