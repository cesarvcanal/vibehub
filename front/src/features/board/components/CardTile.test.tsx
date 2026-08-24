import { describe, expect, it, vi } from "vitest";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CardTile } from "@/features/board/components/CardTile";
import { renderApp } from "@/test/render";
import type { BoardCard } from "@/features/board/api";

// The shell's auth probe would otherwise reach for a real XHR under jsdom.
vi.mock("@/lib/api", () => ({
  api: { interceptors: { response: { use: vi.fn() } } },
  setUnauthorizedHandler: vi.fn(),
  get: vi.fn().mockResolvedValue({}),
  post: vi.fn(),
  patch: vi.fn(),
  del: vi.fn(),
}));

function card(overrides: Partial<BoardCard> = {}): BoardCard {
  return {
    id: "c1",
    projectId: "p1",
    title: "fix the totals",
    column: "working",
    position: 0,
    tmuxSession: "card-c1",
    worktreeSlug: "fix-the-totals-c1",
    createdAt: 1,
    ...overrides,
  };
}

describe("CardTile — what the card says", () => {
  it("does not repeat the column it is sitting in", () => {
    // "Working" under a card in the Working column is a word that has already been read.
    renderApp(<CardTile card={card({ status: "working" })} onOpen={vi.fn()} />);
    const tile = screen.getByRole("link", { name: "fix the totals" });
    expect(within(tile).queryByText("Working")).not.toBeInTheDocument();
    expect(within(tile).queryByText("Waiting for you")).not.toBeInTheDocument();
  });

  it("still carries the status on the dot, for anyone who cannot see colour", () => {
    renderApp(<CardTile card={card({ status: "waiting", column: "waiting" })} onOpen={vi.fn()} />);
    expect(screen.getByRole("status", { name: "Waiting for you" })).toBeInTheDocument();
  });

  it("says a pause is waiting for the turn to end — something no column shows", () => {
    renderApp(<CardTile card={card({ column: "paused", openedAt: 5 })} onOpen={vi.fn()} />);
    expect(screen.getByText("Pausing when idle…")).toBeInTheDocument();
  });

  it("says a configuration change will land when the card finishes", () => {
    renderApp(
      <CardTile card={card({ openedAt: 5, restartPendingAt: 111, restartReason: "brain" })} onOpen={vi.fn()} />,
    );
    expect(screen.getByText("Updating when it finishes…")).toBeInTheDocument();
  });

  it("lets a pending pause win over a pending update — the server resolves it that way", () => {
    renderApp(
      <CardTile card={card({ column: "paused", openedAt: 5, restartPendingAt: 111 })} onOpen={vi.fn()} />,
    );
    expect(screen.getByText("Pausing when idle…")).toBeInTheDocument();
    expect(screen.queryByText("Updating when it finishes…")).not.toBeInTheDocument();
  });

  it("says nothing extra once the card is actually paused", () => {
    renderApp(<CardTile card={card({ column: "paused", pausedAt: 9, restartPendingAt: 111 })} onOpen={vi.fn()} />);
    expect(screen.queryByText(/Pausing when idle/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Updating when it finishes/)).not.toBeInTheDocument();
  });
});

describe("CardTile — right-click", () => {
  const handlers = () => ({ onPause: vi.fn(), onRestart: vi.fn(), onDone: vi.fn() });

  it("offers Pause, Restart and Finish, in that order", async () => {
    const user = userEvent.setup();
    renderApp(<CardTile card={card({ openedAt: 5 })} onOpen={vi.fn()} {...handlers()} />);

    await user.pointer({ keys: "[MouseRight]", target: screen.getByRole("link", { name: "fix the totals" }) });
    const items = within(screen.getByRole("menu")).getAllByRole("menuitem");
    expect(items.map((i) => i.textContent)).toEqual(["Pause", "Restart", "Finish"]);
  });

  it("runs the action without also opening the card", async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();
    const h = handlers();
    renderApp(<CardTile card={card({ openedAt: 5 })} onOpen={onOpen} {...h} />);

    await user.pointer({ keys: "[MouseRight]", target: screen.getByRole("link", { name: "fix the totals" }) });
    await user.click(screen.getByRole("menuitem", { name: "Restart" }));

    expect(h.onRestart).toHaveBeenCalledWith(expect.objectContaining({ id: "c1" }));
    // The panel is a DOM child of the tile: without stopping propagation this would open it too.
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("closes after choosing", async () => {
    const user = userEvent.setup();
    renderApp(<CardTile card={card({ openedAt: 5 })} onOpen={vi.fn()} {...handlers()} />);
    await user.pointer({ keys: "[MouseRight]", target: screen.getByRole("link", { name: "fix the totals" }) });
    await user.click(screen.getByRole("menuitem", { name: "Pause" }));
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("closes on Escape", async () => {
    const user = userEvent.setup();
    renderApp(<CardTile card={card({ openedAt: 5 })} onOpen={vi.fn()} {...handlers()} />);
    await user.pointer({ keys: "[MouseRight]", target: screen.getByRole("link", { name: "fix the totals" }) });
    expect(screen.getByRole("menu")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("hides Pause and Restart on a card that has never been opened — there is no session yet", async () => {
    const user = userEvent.setup();
    renderApp(<CardTile card={card({ column: "backlog" })} onOpen={vi.fn()} {...handlers()} />);

    await user.pointer({ keys: "[MouseRight]", target: screen.getByRole("link", { name: "fix the totals" }) });
    const items = within(screen.getByRole("menu")).getAllByRole("menuitem");
    expect(items.map((i) => i.textContent)).toEqual(["Finish"]);
  });

  it("drops Finish on a card that is already done", async () => {
    const user = userEvent.setup();
    renderApp(<CardTile card={card({ column: "done", openedAt: 5 })} onOpen={vi.fn()} {...handlers()} />);

    await user.pointer({ keys: "[MouseRight]", target: screen.getByRole("link", { name: "fix the totals" }) });
    const items = within(screen.getByRole("menu")).getAllByRole("menuitem");
    expect(items.map((i) => i.textContent)).toEqual(["Pause", "Restart"]);
  });

  it("leaves the browser's own menu alone when there is no action to offer", async () => {
    const user = userEvent.setup();
    // A read-only tile: no handlers at all, so suppressing the native menu would give nothing back.
    renderApp(<CardTile card={card({ column: "done" })} onOpen={vi.fn()} />);
    await user.pointer({ keys: "[MouseRight]", target: screen.getByRole("link", { name: "fix the totals" }) });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });
});

describe("CardTile — the card is a link", () => {
  it("carries the href of its own card, so the browser's habits work", () => {
    renderApp(<CardTile card={card()} onOpen={vi.fn()} />);
    expect(screen.getByRole("link", { name: "fix the totals" })).toHaveAttribute(
      "href",
      "?project=p1&card=c1",
    );
  });

  it("handles a plain click itself", async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();
    renderApp(<CardTile card={card()} onOpen={onOpen} />);
    await user.click(screen.getByRole("link", { name: "fix the totals" }));
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ id: "c1" }));
  });

  it("gets out of the way of a modified click — that one belongs to the browser", async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();
    renderApp(<CardTile card={card()} onOpen={onOpen} />);

    const tile = screen.getByRole("link", { name: "fix the totals" });
    // Cmd-click (and Ctrl/Shift/middle): the router must not intercept it, or "open in a new tab"
    // would silently navigate this one instead.
    await user.keyboard("{Meta>}");
    await user.click(tile);
    await user.keyboard("{/Meta}");

    expect(onOpen).not.toHaveBeenCalled();
  });
});

describe("CardTile — the ⋯ menu", () => {
  it("offers card management, in order, behind one trigger", async () => {
    const user = userEvent.setup();
    renderApp(
      <CardTile
        card={card({ openedAt: 5 })}
        onOpen={vi.fn()}
        onDone={vi.fn()}
        onPause={vi.fn()}
        onAccount={vi.fn()}
        onDelete={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Actions for fix the totals" }));
    const items = await screen.findAllByRole("menuitem");
    expect(items.map((i) => i.textContent)).toEqual([
      "Finish (move to Done)",
      "Pause (ends the session)",
      "Claude account…",
      "Delete card",
    ]);
  });

  it("runs an action without also opening the card", async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();
    const onDelete = vi.fn();
    renderApp(<CardTile card={card()} onOpen={onOpen} onDelete={onDelete} />);

    await user.click(screen.getByRole("button", { name: "Actions for fix the totals" }));
    await user.click(await screen.findByRole("menuitem", { name: "Delete card" }));

    expect(onDelete).toHaveBeenCalledWith(expect.objectContaining({ id: "c1" }));
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("has no trigger at all where the board offers no actions", () => {
    renderApp(<CardTile card={card()} onOpen={vi.fn()} />);
    expect(screen.queryByRole("button", { name: /Actions for/ })).not.toBeInTheDocument();
  });
});

describe("CardTile — the chips", () => {
  it("shows the card's OWN account and never the one it merely inherits", () => {
    renderApp(<CardTile card={card({ accountSlug: "personal" })} onOpen={vi.fn()} />);
    expect(screen.getByText("personal")).toBeInTheDocument();
  });

  it("says nothing about the model — that is a setting, not news", () => {
    renderApp(<CardTile card={card({ model: "claude-opus-5" })} onOpen={vi.fn()} />);
    expect(screen.queryByText(/opus/i)).not.toBeInTheDocument();
  });

  it("renders no dot placeholder for a card the runner has said nothing about", () => {
    renderApp(<CardTile card={card({ status: undefined, column: "backlog" })} onOpen={vi.fn()} />);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("shows the agent's declared state as a chip, with the summary in the tooltip", () => {
    renderApp(
      <CardTile card={card({ declaredState: "needs_me", declaredSummary: "which currency for the totals?" })} onOpen={vi.fn()} />,
    );
    const chip = screen.getByText("Needs you");
    expect(chip).toBeInTheDocument();
    expect(chip).toHaveAttribute("title", "which currency for the totals?");
  });

  it("shows no state chip when the agent has declared nothing", () => {
    renderApp(<CardTile card={card()} onOpen={vi.fn()} />);
    for (const label of ["On it", "Ready", "Needs you", "Blocked"]) {
      expect(screen.queryByText(label)).not.toBeInTheDocument();
    }
  });
});
