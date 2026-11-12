import { describe, expect, it } from "vitest";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import BranchPicker from "@/features/board/components/BranchPicker";
import { renderApp } from "@/test/render";

const LONG_NAME = "card/nome-de-branch-muito-longo-que-trunca-no-dialogo-1234";

function renderPicker(value: string) {
  return renderApp(
    <BranchPicker
      id="teste-branch"
      value={value}
      onSelect={() => {}}
      branches={["main", LONG_NAME]}
      defaultBranch="main"
      refreshing={false}
      refreshFailed={false}
      truncated={false}
      onOpen={() => {}}
      onRefresh={() => {}}
    />,
  );
}

describe("BranchPicker", () => {
  it("shows the full branch name in a tooltip when hovering an option", async () => {
    const user = userEvent.setup();
    renderPicker("main");

    await user.click(screen.getByRole("combobox"));
    const option = screen.getByRole("option", { name: LONG_NAME });
    await user.hover(within(option).getByText(LONG_NAME));

    expect(await screen.findByRole("tooltip")).toHaveTextContent(LONG_NAME);
  });

  it("shows the full name of the selected branch in a tooltip on the closed trigger", async () => {
    const user = userEvent.setup();
    renderPicker(LONG_NAME);

    await user.hover(within(screen.getByRole("combobox")).getByText(LONG_NAME));

    expect(await screen.findByRole("tooltip")).toHaveTextContent(LONG_NAME);
  });
});
