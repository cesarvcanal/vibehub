import * as React from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import BranchPicker from "@/features/board/components/BranchPicker";

const BRANCHES = ["main", "prod", "dev", "feat/pdv", "feat/conciliacao-qive", "fix/caixa-fechamento", "card/ajuste-layout-240c"];

function ControlledPicker(props: Partial<React.ComponentProps<typeof BranchPicker>>) {
  const [value, setValue] = React.useState(props.value ?? "");
  return (
    <BranchPicker
      id="historia-branch"
      branches={BRANCHES}
      defaultBranch="main"
      refreshing={false}
      refreshFailed={false}
      truncated={false}
      onOpen={() => {}}
      onRefresh={() => {}}
      {...props}
      value={value}
      onSelect={setValue}
    />
  );
}

const meta = {
  title: "Board/Seletor de branch",
  component: ControlledPicker,
  decorators: [(Story) => <div className="max-w-md p-4"><Story /></div>],
} satisfies Meta<typeof ControlledPicker>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Closed: Story = { name: "Fechado", args: { value: "prod" } };
export const InheritingFromProject: Story = { name: "Herdando do projeto", args: { noChoiceLabel: "A do projeto (dev)" } };
export const Refreshing: Story = { name: "Atualizando", args: { value: "main", refreshing: true } };
