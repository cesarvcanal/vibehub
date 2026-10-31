import type { Meta, StoryObj } from "@storybook/react-vite";
import { TerminalComposer } from "@/features/board/components/TerminalComposer";

/**
 * The field a card is written from. Open the stories in a 390–430px window to see the phone's
 * shape — one box, the text across the whole width, "+" / stop / mic / send in a bar under it — and
 * in a wide one for the desktop's field with the buttons beside it.
 */
const meta: Meta<typeof TerminalComposer> = {
  title: "Board/Composer",
  component: TerminalComposer,
  args: {
    cardId: "c1",
    onSend: () => undefined,
    onUploadImage: async () => "/work/.uploads/c1/shot.png",
  },
};

export default meta;

type Story = StoryObj<typeof TerminalComposer>;

export const Vazio: Story = {
  args: { interrupt: { active: false, onInterrupt: () => undefined } },
};

export const AgenteTrabalhando: Story = {
  args: { interrupt: { active: true, onInterrupt: () => undefined } },
};
