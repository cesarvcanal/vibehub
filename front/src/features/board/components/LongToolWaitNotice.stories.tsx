import type { Meta, StoryObj } from "@storybook/react-vite";
import { LongToolWaitNotice } from "@/features/board/components/LongToolWaitNotice";
import { CardFailureNotice } from "@/features/platformFailures/components/CardFailureNotice";

const LONG_COMMAND = "timeout 400 sh -c 'until grep -q \"^EXIT\" /tmp/vh-8f4f-front.log; do sleep 5; done'; grep -E \"Test Files|Tests |EXIT\" /tmp/vh-8f4f-front.log";

const meta = {
  title: "Chat/Agente esperando um comando",
  render: ({ what, elapsedSeconds, width }) => (
    <div className="p-6" style={{ width }}>
      <LongToolWaitNotice wait={{ rowId: "t1", what, elapsedSeconds }} onInterrupt={() => undefined} />
      <CardFailureNotice
        cardId="c1"
        notices={[{ id: "f1", source: "stalled_turn", status: "open", occurrences: 1, firstSeenAt: 0, lastSeenAt: 0 }]}
      />
    </div>
  ),
} satisfies Meta<{ what: string; elapsedSeconds: number; width: number }>;
export default meta;
type Story = StoryObj<typeof meta>;

export const WithDescription: Story = { name: "Com descrição", args: { what: "Espera o fim da bateria do front", elapsedSeconds: 190, width: 760 } };
export const LongCommandNarrow: Story = { name: "Comando longo, card estreito", args: { what: LONG_COMMAND.slice(0, 60), elapsedSeconds: 412, width: 420 } };
