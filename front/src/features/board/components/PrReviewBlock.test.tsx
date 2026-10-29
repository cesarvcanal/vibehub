import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { cleanup, configure, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderApp, setupState } from "@/test/render";
import { PrReviewBlock, PrReviewBlocks } from "./PrReviewBlock";
import { LANGUAGE_KEY, setLanguage } from "@/i18n";
import type { CardPr, ReviewSummary } from "@/api/types";

vi.setConfig({ testTimeout: 30_000 });
configure({ asyncUtilTimeout: 8_000 });

const get = vi.fn();
vi.mock("@/lib/api", () => ({
  get: (...a: unknown[]) => get(...a),
  post: vi.fn(),
  del: vi.fn(),
  patch: vi.fn(),
}));
vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }) }));

const PR: CardPr = {
  number: 553, url: "https://github.com/acme/erp/pull/553", base: "dev", branch: "card/pedidos", openedAt: 1,
};

function reviewOf(overrides: Partial<ReviewSummary> = {}): ReviewSummary {
  return { id: "r1", prNumber: 553, phase: "fixing", round: 2, ...overrides };
}

beforeEach(() => {
  vi.clearAllMocks();
  setLanguage("pt-BR");
  get.mockImplementation(async (url: string) => {
    if (url === "/auth/me") return { user: { id: "u1", username: "mussa", role: "member" } };
    if (url === "/setup/state") return setupState();
    if (url === "/cards/c1/people") return { people: [{ id: "u1", username: "mussa", canReview: true }] };
    throw new Error(`unexpected ${url}`);
  });
});
afterEach(() => {
  // Unmount BEFORE the language flips back: a mounted `useT()` would re-render outside act().
  cleanup();
  setLanguage("en");
  localStorage.removeItem(LANGUAGE_KEY);
});

describe("PrReviewBlock", () => {
  it("sem revisão mostra Pedir revisão", async () => {
    renderApp(<PrReviewBlock cardId="c1" pr={PR} onOpenPanel={() => {}} />);

    expect(screen.getByText("PR #553")).toBeInTheDocument();
    expect(screen.getByText("card/pedidos → dev")).toBeInTheDocument();
    expect(screen.getByText("sem revisão")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Pedir revisão" })).toBeInTheDocument();
    // The PR number is a way out to GitHub, not the way into a panel that does not exist yet.
    expect(screen.getByRole("link", { name: /GitHub/ })).toHaveAttribute("href", PR.url);
  });

  it("Pedir revisão abre a janela de papéis para este PR", async () => {
    renderApp(<PrReviewBlock cardId="c1" pr={PR} onOpenPanel={() => {}} />);
    expect(screen.queryByRole("dialog")).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "Pedir revisão" }));

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Pedir revisão do PR #553")).toBeInTheDocument();
  });

  it("fechar a janela volta ao bloco, que continua pedindo revisão", async () => {
    renderApp(<PrReviewBlock cardId="c1" pr={PR} onOpenPanel={() => {}} />);
    await userEvent.click(screen.getByRole("button", { name: "Pedir revisão" }));
    const dialog = await screen.findByRole("dialog");

    await userEvent.click(within(dialog).getByRole("button", { name: "Cancelar" }));

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("button", { name: "Pedir revisão" })).toBeInTheDocument();
  });

  it("em revisão mostra rodada 2/3 e abre o painel ao clicar", async () => {
    const onOpenPanel = vi.fn();
    renderApp(<PrReviewBlock cardId="c1" pr={PR} review={reviewOf()} onOpenPanel={onOpenPanel} />);

    expect(screen.getByText("rodada 2/3")).toBeInTheDocument();
    // A review already runs: the button to start one is gone, so there is no second review to ask for.
    expect(screen.queryByRole("button", { name: "Pedir revisão" })).toBeNull();
    expect(screen.queryByText("sem revisão")).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: /PR #553/ }));
    expect(onOpenPanel).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("a keyboard opens the panel too", async () => {
    const onOpenPanel = vi.fn();
    renderApp(<PrReviewBlock cardId="c1" pr={PR} review={reviewOf()} onOpenPanel={onOpenPanel} />);

    screen.getByRole("button", { name: /PR #553/ }).focus();
    await userEvent.keyboard("{Enter}");

    expect(onOpenPanel).toHaveBeenCalledTimes(1);
  });

  it("the GitHub link does not open the panel", async () => {
    const onOpenPanel = vi.fn();
    renderApp(<PrReviewBlock cardId="c1" pr={PR} review={reviewOf()} onOpenPanel={onOpenPanel} />);

    const link = screen.getByRole("link", { name: /GitHub/ });
    link.addEventListener("click", (e) => e.preventDefault()); // jsdom cannot navigate
    await userEvent.click(link);

    expect(onOpenPanel).not.toHaveBeenCalled();
  });

  it.each([
    [{ phase: "reviewing", round: 1 }, "rodada 1/3"],
    [{ phase: "ready", round: 2 }, "pronto pra merge"],
    [{ phase: "impasse", round: 3 }, "impasse"],
    [{ phase: "merged", round: 2 }, "mergeado"],
  ] as const)("the pill reads %j as %s", (state, label) => {
    renderApp(<PrReviewBlock cardId="c1" pr={PR} review={reviewOf(state)} onOpenPanel={() => {}} />);
    expect(screen.getByText(label)).toBeInTheDocument();
  });

  it("a cancelled review in a stale cache is no review: the block asks for one again", () => {
    renderApp(<PrReviewBlock cardId="c1" pr={PR} review={reviewOf({ phase: "cancelled" })} onOpenPanel={() => {}} />);
    expect(screen.getByText("sem revisão")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Pedir revisão" })).toBeInTheDocument();
  });

  it("an English install reads the same pills in English", () => {
    setLanguage("en");
    renderApp(<PrReviewBlock cardId="c1" pr={PR} review={reviewOf({ phase: "ready" })} onOpenPanel={() => {}} />);
    expect(screen.getByText("ready to merge")).toBeInTheDocument();
  });
});

describe("PrReviewBlocks", () => {
  const prs: CardPr[] = [
    { number: 10, url: "u10", base: "dev", branch: "card/a", openedAt: 100 },
    { number: 12, url: "u12", base: "prod", branch: "card/a", openedAt: 300 },
  ];

  it("renders nothing for a card with no PR", () => {
    const { container } = renderApp(<PrReviewBlocks card={{ id: "c1" }} onOpenPanel={() => {}} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("one block per PR, the newest first", () => {
    renderApp(<PrReviewBlocks card={{ id: "c1", prs }} onOpenPanel={() => {}} />);
    const blocks = screen.getAllByTestId("pr-review-block");
    expect(blocks.map((b) => b.getAttribute("data-pr"))).toEqual(["12", "10"]);
  });

  it("the review pill goes to the PR it is about and only that one", () => {
    renderApp(
      <PrReviewBlocks card={{ id: "c1", prs, review: reviewOf({ prNumber: 10 }) }} onOpenPanel={() => {}} />,
    );
    const [newer, older] = screen.getAllByTestId("pr-review-block");
    expect(within(newer).getByText("sem revisão")).toBeInTheDocument();
    expect(within(newer).getByRole("button", { name: "Pedir revisão" })).toBeInTheDocument();
    expect(within(older).getByText("rodada 2/3")).toBeInTheDocument();
  });

  it("a merged PR leaves the chat — what is left is what still needs a decision", () => {
    renderApp(
      <PrReviewBlocks
        card={{ id: "c1", prs, review: reviewOf({ prNumber: 10, phase: "merged" }) }}
        onOpenPanel={() => {}}
      />,
    );
    expect(screen.getAllByTestId("pr-review-block").map((b) => b.getAttribute("data-pr"))).toEqual(["12"]);
  });

  it("hands the card's actor to the dialog as the suggested author", async () => {
    get.mockImplementation(async (url: string) => {
      if (url === "/auth/me") return { user: { id: "u1", username: "mussa", role: "member" } };
      if (url === "/setup/state") return setupState();
      if (url === "/cards/c1/people") {
        return { people: [{ id: "u1", username: "mussa", canReview: true }, { id: "u2", username: "albert", canReview: true }] };
      }
      throw new Error(`unexpected ${url}`);
    });
    renderApp(<PrReviewBlocks card={{ id: "c1", prs: [prs[1]], actorUserId: "u2" }} onOpenPanel={() => {}} />);

    await userEvent.click(screen.getByRole("button", { name: "Pedir revisão" }));
    const author = (await screen.findByLabelText(/^Quem corrige/)) as HTMLSelectElement;
    await vi.waitFor(() => expect(author.value).toBe("u2"));
  });
});
