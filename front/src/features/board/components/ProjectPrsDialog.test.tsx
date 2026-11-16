import { describe, it, expect, vi, beforeEach } from "vitest";
import { configure, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderApp, setupState } from "@/test/render";
import type { ProjectPull } from "@/api/types";
import { toast } from "sonner";
import { ProjectPrsDialog } from "./ProjectPrsDialog";

vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }) }));

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
/** Sam is signed in; Albert opened the PRs on GitHub (`albert-gh`). */
const PEOPLE = [
  { id: "u1", username: "sam", githubLogin: "sam-gh" },
  { id: "u2", username: "albert", githubLogin: "albert-gh" },
  { id: "u3", username: "mussa", githubLogin: "mussa-gh" },
];
const pull = (n: number, extra: Partial<ProjectPull> = {}): ProjectPull => ({
  number: n, title: `Conciliação ${n}`, url: `https://github.com/acme/erp/pull/${n}`, author: "albert-gh",
  branch: `feat/${n}`, base: "dev", fromFork: false, draft: false, updatedAt: "2026-11-16T12:00:00Z", ...extra,
});

function serve(pulls: ProjectPull[] | Error) {
  get.mockImplementation(async (url: string) => {
    if (url === "/auth/me") return { user: OWNER };
    if (url === "/setup/state") return setupState();
    if (url === "/projects/p1/analysis-people") return { people: PEOPLE };
    if (url === "/projects/p1/prs") {
      if (pulls instanceof Error) throw pulls;
      return { pulls };
    }
    throw new Error(`unexpected ${url}`);
  });
}

function open(onOpenCard = vi.fn()) {
  renderApp(<ProjectPrsDialog projectId="p1" open onOpenChange={() => {}} onOpenCard={onOpenCard} />);
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

  it("Analyse asks for the reviewer and the co-author, then starts and keeps the list open", async () => {
    serve([pull(636), pull(640)]);
    post.mockResolvedValue({ card: { id: "c9", projectId: "p1" }, created: true });
    const onOpenCard = open();
    await userEvent.click(await screen.findByRole("button", { name: "Analyse PR #636" }));
    const reviewer = await screen.findByLabelText("Reviewer");
    // the one signed in comes picked; whoever opened the PR cannot review it
    expect(reviewer).toHaveValue("u1");
    expect(within(reviewer).getByRole("option", { name: /albert/ })).toBeDisabled();
    await userEvent.selectOptions(screen.getByLabelText("Co-author"), "u3");
    await userEvent.click(screen.getByRole("button", { name: "Start analysis" }));
    await waitFor(() => expect(post).toHaveBeenCalledWith("/projects/p1/prs/636/analysis", { reviewerUserId: "u1", coauthorUserId: "u3" }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Analysis of PR #636 started", expect.anything()));
    // the dialog stays: the next PR can be started right away
    expect(screen.getByTestId("project-prs-dialog")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Analyse PR #640" })).toBeEnabled();
    expect(onOpenCard).not.toHaveBeenCalled();
    const { action } = vi.mocked(toast.success).mock.calls[0]![1] as unknown as { action: { onClick: () => void } };
    action.onClick();
    expect(onOpenCard).toHaveBeenCalledWith("c9");
  });

  it("without a co-author the request carries only the reviewer", async () => {
    serve([pull(636)]);
    post.mockResolvedValue({ card: { id: "c9", projectId: "p1" }, created: true });
    open();
    await userEvent.click(await screen.findByRole("button", { name: "Analyse PR #636" }));
    await userEvent.click(await screen.findByRole("button", { name: "Start analysis" }));
    await waitFor(() => expect(post).toHaveBeenCalledWith("/projects/p1/prs/636/analysis", { reviewerUserId: "u1" }));
  });

  it("the author of the PR cannot be picked as reviewer: nothing is preselected and Start waits", async () => {
    serve([pull(636, { author: "sam-gh" })]);
    open();
    await userEvent.click(await screen.findByRole("button", { name: "Analyse PR #636" }));
    expect(await screen.findByLabelText("Reviewer")).toHaveValue("");
    expect(screen.getByRole("button", { name: "Start analysis" })).toBeDisabled();
    await userEvent.selectOptions(screen.getByLabelText("Reviewer"), "u3");
    expect(screen.getByRole("button", { name: "Start analysis" })).toBeEnabled();
  });

  it("only the PR being started waits: the others stay clickable, and a second click on it sends nothing", async () => {
    serve([pull(636), pull(640)]);
    post.mockReturnValue(new Promise(() => {}));
    open();
    await userEvent.click(await screen.findByRole("button", { name: "Analyse PR #636" }));
    const start = await screen.findByRole("button", { name: "Start analysis" });
    await userEvent.click(start);
    await userEvent.click(start);
    expect(post).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Starting…")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Analyse PR #640" })).toBeEnabled();
  });

  it("a PR already under analysis offers its card, and a fork cannot be analysed", async () => {
    serve([pull(636, { analysisCardId: "c7" }), pull(641, { fromFork: true })]);
    const onOpenCard = open();
    await userEvent.click(await screen.findByRole("button", { name: "Open analysis of PR #636" }));
    expect(onOpenCard).toHaveBeenCalledWith("c7");
    expect(screen.getByRole("button", { name: "Analyse PR #641" })).toBeDisabled();
    expect(screen.getByText("Comes from a fork")).toBeInTheDocument();
    expect(screen.getByText("Analysing")).toBeInTheDocument();
    expect(post).not.toHaveBeenCalled();
  });

  it("a PR whose branch name vibehub refuses cannot be analysed, and says why", async () => {
    serve([pull(642, { branch: "feat/ação-estoque", unsupportedBranch: true })]);
    open();
    expect(await screen.findByRole("button", { name: "Analyse PR #642" })).toBeDisabled();
    expect(screen.getByText("Branch name not supported")).toBeInTheDocument();
  });

  it("says when there are no open PRs, and shows GitHub's failure instead of an empty list", async () => {
    serve([]);
    open();
    expect(await screen.findByText("No open pull requests")).toBeInTheDocument();
    // empty is a moment to act: the list can be read again without closing
    await userEvent.click(screen.getByRole("button", { name: "Refresh list" }));
    await waitFor(() => expect(get.mock.calls.filter(([url]) => url === "/projects/p1/prs")).toHaveLength(2));
  });

  it("shows the error when GitHub does not answer", async () => {
    serve(new Error("GitHub returned 502 while listing pull requests"));
    open();
    expect(await screen.findByText(/GitHub returned 502/)).toBeInTheDocument();
  });
});
