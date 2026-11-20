import type { Meta, StoryObj } from "@storybook/react-vite";
import { CardWaitNotice } from "@/features/board/components/CardWaitNotice";
import { CardTile } from "@/features/board/components/CardTile";
import type { CardWait } from "@/api/types";
import type { BoardCard } from "@/features/board/api";

const WAIT: CardWait = {
  cardId: "d3497d82",
  instruction: "Faça o PR complementar da captura de falhas: ligue o aviso no celular e cubra com teste o erro que ficava mudo.",
  createdAt: 1,
  createdBy: "u1",
};
const TARGET_TITLE = "Captura de falha da plataforma pega todo erro real e avisa o dono em qualquer tela";
const READY_WAIT: CardWait = { ...WAIT, readyAt: 2, outcome: "pr_merged", prNumber: 356 };
const FAILED_WAIT: CardWait = { ...READY_WAIT, failure: { at: 3, reason: "the terminal for card \"auto-aprimorável\" has no live session" } };

function waitingCard(index: number, waitingFor: CardWait, waitTargetTitle: string | undefined, column: BoardCard["column"]): BoardCard {
  return {
    id: `card-${index}`, projectId: "p1", title: "auto-aprimorável não funcionando", column, position: index,
    tmuxSession: `card-${index}`, worktreeSlug: `auto-${index}`, createdAt: 1, waitingFor, waitTargetTitle,
  };
}

const NOTICE_CARDS = [
  waitingCard(0, WAIT, TARGET_TITLE, "waiting"),
  waitingCard(1, READY_WAIT, TARGET_TITLE, "paused"),
  waitingCard(2, READY_WAIT, TARGET_TITLE, "working"),
  waitingCard(3, FAILED_WAIT, undefined, "waiting"),
];
const TILE_CARDS = [
  waitingCard(4, WAIT, TARGET_TITLE, "waiting"),
  waitingCard(5, WAIT, undefined, "waiting"),
  waitingCard(6, FAILED_WAIT, "Captura de falhas", "waiting"),
];

const meta = {
  title: "Card/Espera por outro card",
  render: ({ width }) => (
    <div className="flex gap-6">
      <div className="space-y-3" style={{ width }}>
        {NOTICE_CARDS.map((card) => (card.waitingFor ? <CardWaitNotice key={card.id} card={card} wait={card.waitingFor} /> : null))}
      </div>
      <div className="w-72 space-y-2">
        {TILE_CARDS.map((card) => <CardTile key={card.id} card={card} onOpen={() => undefined} />)}
      </div>
    </div>
  ),
} satisfies Meta<{ width: number }>;
export default meta;
type Story = StoryObj<typeof meta>;

export const ChatWidth: Story = { name: "Largura do chat", args: { width: 760 } };
export const NarrowCard: Story = { name: "Card estreito", args: { width: 380 } };
