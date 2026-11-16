import { describe, it, expect, vi, beforeEach } from "vitest";
import { configure, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderApp, setupState } from "@/test/render";
import type { ProjectPull } from "@/api/types";
import { ProjectPrsDialog } from "./ProjectPrsDialog";

vi.setConfig({ testTimeout: 30_000 });
configure({ asyncUtilTimeout: 8_000 });

const get = vi.fn();
const post = vi.fn();
vi.mock("@/lib/api", () => ({
  get: (...a: unknown[]) => get(...a),
  post: (...a: unknown[]) => post(...a),
  del: vi.fn(),
  patch: vi.fn(),
}));

const OWNER = { id: "u1", username: "sam", role: "owner" };
const pull = (n: number, extra: Partial<ProjectPull> = {}): ProjectPull => ({
  number: n, title: `Conciliação ${n}`, url: `https://github.com/acme/erp/pull/${n}`, author: "albert-gh",
  branch: `feat/${n}`, base: "dev", fromFork: false, draft: false, updatedAt: "2026-11-16T12:00:00Z", ...extra,
});

function serve(pulls: ProjectPull[] | Error) {
  get.mockImplementation(async (url: string) => {
    if (url === "/auth/me") return { user: OWNER };
    if (url === "/setup/state") return setupState();
    if (url === "/projects/p1/prs") {
      if (pulls instanceof Error) throw pulls;
      return { pulls };
    }
    throw new Error(`unexpected ${url}`);
  });
}

function open(onOpenCard = vi.fn()) {
  renderApp(<ProjectPrsDialog projectId="p1" projectName="erp" open onOpenChange={() => {}} onOpenCard={onOpenCard} />);
  return onOpenCard;
}

beforeEach(() => vi.clearAllMocks());

describe("ProjectPrsDialog", () => {
  it("lists the open PRs read from GitHub", async () => {
    serve([pull(636), pull(640)]);
    open();
    expect(await screen.findByText("Conciliação 636")).toBeInTheDocument();
    expect(screen.getByText("Conciliação 640")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /Analyse/ })).toHaveLength(2);
  });

  it("analyses a PR and opens its card", async () => {
    serve([pull(636)]);
    post.mockResolvedValue({ card: { id: "c9", projectId: "p1" }, created: true });
    const onOpenCard = open();
    await userEvent.click(await screen.findByRole("button", { name: "Analyse PR #636" }));
    await waitFor(() => expect(post).toHaveBeenCalledWith("/projects/p1/prs/636/analysis", {}));
    await waitFor(() => expect(onOpenCard).toHaveBeenCalledWith("c9"));
  });

  it("a second click while the first is on its way sends nothing", async () => {
    serve([pull(636)]);
    post.mockReturnValue(new Promise(() => {}));
    open();
    const button = await screen.findByRole("button", { name: "Analyse PR #636" });
    await userEvent.click(button);
    await userEvent.click(button);
    expect(post).toHaveBeenCalledTimes(1);
    expect(button).toBeDisabled();
  });

  it("a PR already under analysis offers its card, and a fork cannot be analysed", async () => {
    serve([pull(636, { analysisCardId: "c7" }), pull(641, { fromFork: true })]);
    const onOpenCard = open();
    await userEvent.click(await screen.findByRole("button", { name: "Open analysis of PR #636" }));
    expect(onOpenCard).toHaveBeenCalledWith("c7");
    expect(screen.getByRole("button", { name: "Analyse PR #641" })).toBeDisabled();
    expect(screen.getByText("From a fork: the fixes would have nowhere to go")).toBeInTheDocument();
    expect(post).not.toHaveBeenCalled();
  });

  it("says when there are no open PRs, and shows GitHub's failure instead of an empty list", async () => {
    serve([]);
    open();
    expect(await screen.findByText("No open pull requests in this repository.")).toBeInTheDocument();
  });

  it("shows the error when GitHub does not answer", async () => {
    serve(new Error("GitHub returned 502 while listing pull requests"));
    open();
    expect(await screen.findByText(/GitHub returned 502/)).toBeInTheDocument();
  });
});
