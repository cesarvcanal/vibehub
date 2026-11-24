import type { Meta, StoryObj } from "@storybook/react-vite";
import { Input } from "@/components/ui/input";
import { AccountBackupSelect } from "@/features/accounts/components/AccountBackupSelect";

const OPTIONS = [
  { slug: "default", label: "tech" },
  { slug: "albert", label: "Albert" },
  { slug: "cesarcanal", label: "César Canal" },
  { slug: "mussa", label: "Mussa" },
];

const meta = {
  title: "Accounts/AccountBackupSelect",
  component: AccountBackupSelect,
  args: { accountSlug: "albert", accountLabel: "Albert", value: "cesarcanal", options: OPTIONS },
  decorators: [
    (Story) => (
      <div className="max-w-md p-4">
        <div className="rounded-md border border-border/60 px-3 py-2">
          <div className="min-w-0 flex-1 space-y-1.5">
            <Input className="h-7 text-sm font-medium" defaultValue="Albert" />
            <div className="truncate font-mono text-[11px] text-muted-foreground">albert</div>
            <Story />
          </div>
        </div>
      </div>
    ),
  ],
} satisfies Meta<typeof AccountBackupSelect>;

export default meta;

type Story = StoryObj<typeof meta>;

export const WithBackup: Story = {};

export const WithoutBackup: Story = { args: { value: null } };
