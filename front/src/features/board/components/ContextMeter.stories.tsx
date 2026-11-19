import type { Meta, StoryObj } from "@storybook/react-vite";
import { ContextMeter } from "@/features/board/components/ContextMeter";

const MAX_TOKENS = 200_000;

const meta = {
  title: "Chat/Medidor de contexto",
  argTypes: { percent: { control: { type: "range", min: 0, max: 100, step: 1 } } },
  render: ({ percent }) => (
    <div className="flex justify-end p-24">
      <ContextMeter usage={{ usedTokens: (percent / 100) * MAX_TOKENS, maxTokens: MAX_TOKENS, percent }} />
    </div>
  ),
} satisfies Meta<{ percent: number }>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Smart: Story = { name: "Inteligente (12%)", args: { percent: 12 } };
export const Warn: Story = { name: "Atenção (35%)", args: { percent: 35 } };
export const Danger: Story = { name: "Perigo (65%)", args: { percent: 65 } };
