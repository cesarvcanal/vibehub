import type { Meta, StoryObj } from "@storybook/react-vite";
import { AccountLoanNotice } from "@/features/accounts/components/AccountLoanNotice";

const HOUR_MS = 3_600_000;

const meta = {
  title: "Accounts/AccountLoanNotice",
  component: AccountLoanNotice,
  args: { currentAccount: "cesarcanal", returning: false, onReturn: () => undefined },
  decorators: [(Story) => <div className="w-[720px] p-4"><Story /></div>],
} satisfies Meta<typeof AccountLoanNotice>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Borrowed: Story = {
  args: { loan: { originalEffectiveAccount: "albert", renewsAt: Date.now() + 2 * HOUR_MS, exhausted: [] } },
};

export const Renewed: Story = {
  args: { loan: { originalEffectiveAccount: "albert", renewsAt: Date.now() - 60_000, exhausted: [] } },
};

export const UnknownRenewal: Story = {
  args: { loan: { originalEffectiveAccount: "albert", exhausted: [] } },
};

export const Returning: Story = {
  args: { loan: { originalEffectiveAccount: "albert", renewsAt: Date.now() - 60_000, exhausted: [] }, returning: true },
};

export const NarrowWithLongNames: Story = {
  args: {
    loan: { originalEffectiveAccount: "conta-do-albert-reginato-financeiro", renewsAt: Date.now() + HOUR_MS, exhausted: [] },
    currentAccount: "conta-reserva-do-cesar-canal-multiverso",
  },
  decorators: [(Story) => <div className="w-[360px] p-4"><Story /></div>],
};
