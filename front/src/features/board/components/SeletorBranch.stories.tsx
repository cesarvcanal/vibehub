import * as React from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import SeletorBranch from "@/features/board/components/SeletorBranch";

const BRANCHES = ["main", "prod", "dev", "feat/pdv", "feat/conciliacao-qive", "fix/caixa-fechamento", "card/ajuste-layout-240c"];

function SeletorControlado(props: Partial<React.ComponentProps<typeof SeletorBranch>>) {
  const [valor, setValor] = React.useState(props.valor ?? "");
  return (
    <SeletorBranch
      id="historia-branch"
      branches={BRANCHES}
      branchPadrao="main"
      atualizando={false}
      aoAbrir={() => {}}
      aoAtualizar={() => {}}
      {...props}
      valor={valor}
      aoEscolher={setValor}
    />
  );
}

const meta = {
  title: "Board/Seletor de branch",
  component: SeletorControlado,
  decorators: [(Story) => <div className="max-w-md p-4"><Story /></div>],
} satisfies Meta<typeof SeletorControlado>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Fechado: Story = { args: { valor: "prod" } };
export const HerdandoDoProjeto: Story = { name: "Herdando do projeto", args: { rotuloSemEscolha: "A do projeto (dev)" } };
export const Atualizando: Story = { args: { valor: "main", atualizando: true } };
