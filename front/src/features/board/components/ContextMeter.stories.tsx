import type { Meta, StoryObj } from "@storybook/react-vite";
import { ContextMeter } from "@/features/board/components/ContextMeter";

const MAX_TOKENS = 200_000;

const meta = {
  title: "Chat/Medidor de contexto",
  component: ContextMeter,
  argTypes: { usage: { control: false } },
  decorators: [(Story) => <div className="flex justify-end p-24"><Story /></div>],
} satisfies Meta<typeof ContextMeter>;
export default meta;
type Story = StoryObj<typeof meta>;

const usageAt = (percent: number) => ({ usedTokens: (percent / 100) * MAX_TOKENS, maxTokens: MAX_TOKENS, percent });

export const Smart: Story = { name: "Inteligente (12%)", args: { usage: usageAt(12) } };
export const Warn: Story = { name: "Atenção (35%)", args: { usage: usageAt(35) } };
export const Danger: Story = { name: "Perigo (65%)", args: { usage: usageAt(65) } };
