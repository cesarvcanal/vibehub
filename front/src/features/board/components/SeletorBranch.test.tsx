import { describe, expect, it } from "vitest";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import SeletorBranch from "@/features/board/components/SeletorBranch";
import { renderApp } from "@/test/render";

const LONGA = "card/nome-de-branch-muito-longo-que-trunca-no-dialogo-1234";

function renderSeletor(valor: string) {
  return renderApp(
    <SeletorBranch
      id="teste-branch"
      valor={valor}
      aoEscolher={() => {}}
      branches={["main", LONGA]}
      branchPadrao="main"
      atualizando={false}
      falhouAoAtualizar={false}
      truncada={false}
      aoAbrir={() => {}}
      aoAtualizar={() => {}}
    />,
  );
}

describe("SeletorBranch", () => {
  it("shows the full branch name in a tooltip when hovering an option", async () => {
    const user = userEvent.setup();
    renderSeletor("main");

    await user.click(screen.getByRole("combobox"));
    const opcao = screen.getByRole("option", { name: LONGA });
    await user.hover(within(opcao).getByText(LONGA));

    expect(await screen.findByRole("tooltip")).toHaveTextContent(LONGA);
  });

  it("shows the full name of the selected branch in a tooltip on the closed trigger", async () => {
    const user = userEvent.setup();
    renderSeletor(LONGA);

    await user.hover(within(screen.getByRole("combobox")).getByText(LONGA));

    expect(await screen.findByRole("tooltip")).toHaveTextContent(LONGA);
  });
});
