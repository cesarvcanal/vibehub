import { describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NewCardDialog } from "@/features/board/components/NewCardDialog";
import { renderApp } from "@/test/render";

// The shell's auth probe would otherwise reach for a real XHR under jsdom.
vi.mock("@/lib/api", () => ({
  api: { interceptors: { response: { use: vi.fn() } } },
  setUnauthorizedHandler: vi.fn(),
  get: vi.fn().mockResolvedValue({}),
  post: vi.fn(),
  patch: vi.fn(),
  del: vi.fn(),
}));

function setup(overrides: Partial<React.ComponentProps<typeof NewCardDialog>> = {}) {
  const onSubmit = vi.fn();
  const onOpenChange = vi.fn();
  const user = userEvent.setup();
  renderApp(
    <NewCardDialog
      open
      onOpenChange={onOpenChange}
      projectId="p1"
      accounts={[{ slug: "personal", name: "Personal" }]}
      defaultAccountLabel="the runner default"
      defaultBranch="dev"
      onSubmit={onSubmit}
      {...overrides}
    />,
  );
  return { user, onSubmit, onOpenChange };
}

describe("NewCardDialog", () => {
  it("closes on submit instead of waiting for the server", async () => {
    // Creating a card can mean cloning a repository. Blocking on that turned "spin up four cards"
    // into four separate waits.
    const { user, onSubmit, onOpenChange } = setup();

    await user.type(screen.getByLabelText("Title"), "fix the totals");
    await user.click(screen.getByRole("button", { name: "Create card" }));

    expect(onSubmit).toHaveBeenCalledWith({ projectId: "p1", title: "fix the totals" });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("closes on Enter too, so a card is a type-and-go", async () => {
    const { user, onSubmit, onOpenChange } = setup();
    await user.type(screen.getByLabelText("Title"), "chase the flake{Enter}");
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("clears the form on submit, so reopening does not show the last card's title", async () => {
    const { user } = setup();
    const title = screen.getByLabelText("Title") as HTMLInputElement;
    await user.type(title, "first{Enter}");
    expect(title.value).toBe("");
  });

  it("clears the form on Cancel too, so an abandoned draft does not come back", async () => {
    const { user, onOpenChange } = setup();
    const title = screen.getByLabelText("Title") as HTMLInputElement;
    await user.type(title, "thought better of it");
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(onOpenChange).toHaveBeenCalledWith(false);
    // Cancel used to call onOpenChange directly and skip the reset in the Dialog's own handler.
    expect(title.value).toBe("");
  });

  it("clears the options too, so a branch typed and abandoned cannot ride along next time", async () => {
    const { user } = setup();
    await user.click(screen.getByRole("button", { name: "Options" }));
    await user.type(screen.getByLabelText("Branch"), "feat/oops");
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    // The disclosure closes with them: reopening starts from "whatever the project uses".
    expect(screen.queryByLabelText("Branch")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Options" }));
    expect((screen.getByLabelText("Branch") as HTMLInputElement).value).toBe("");
  });

  it("keeps the options folded away until they are asked for", () => {
    setup();
    // The answer is almost always "whatever the project uses"; a card is meant to be type-and-go.
    expect(screen.queryByLabelText("Claude account")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Options" })).toHaveAttribute("aria-expanded", "false");
  });

  it("refuses an empty or whitespace-only title without closing", async () => {
    const { user, onSubmit, onOpenChange } = setup();
    expect((screen.getByRole("button", { name: "Create card" }) as HTMLButtonElement).disabled).toBe(true);

    await user.type(screen.getByLabelText("Title"), "   {Enter}");
    expect(onSubmit).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("trims the title before sending it", async () => {
    const { user, onSubmit } = setup();
    await user.type(screen.getByLabelText("Title"), "  padded  {Enter}");
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ title: "padded" }));
  });

  it("keeps the richer options — account, model and branch still ride along", async () => {
    const { user, onSubmit } = setup();
    await user.type(screen.getByLabelText("Title"), "with options");
    await user.click(screen.getByRole("button", { name: "Options" }));

    await user.selectOptions(screen.getByLabelText("Claude account"), "personal");
    await user.selectOptions(screen.getByLabelText("Model"), "claude-opus-5");
    await user.type(screen.getByLabelText("Branch"), "feat/totals");
    await user.click(screen.getByRole("button", { name: "Create card" }));

    expect(onSubmit).toHaveBeenCalledWith({
      projectId: "p1",
      title: "with options",
      accountSlug: "personal",
      model: "claude-opus-5",
      branch: "feat/totals",
    });
  });

  it("omits the optional fields entirely when they are left alone", async () => {
    const { user, onSubmit } = setup();
    await user.type(screen.getByLabelText("Title"), "bare{Enter}");
    // Not `accountSlug: ""` — an empty string would pin the card to a nameless account.
    expect(onSubmit).toHaveBeenCalledWith({ projectId: "p1", title: "bare" });
  });
});
