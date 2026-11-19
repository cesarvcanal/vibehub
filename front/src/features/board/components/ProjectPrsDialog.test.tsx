import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, configure, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderApp, setupState } from "@/test/render";
import type { ProjectPull } from "@/api/types";
import { toast } from "sonner";
import { RECONNECT_JITTER, RECONNECT_MAX_MS } from "@/features/board/lib/reconnect";
import { ProjectPrsDialog } from "./ProjectPrsDialog";

vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), info: vi.fn(), error: vi.fn() }) }));

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

function serve(pulls: ProjectPull[] | Error, people: () => unknown = () => ({ people: PEOPLE })) {
  get.mockImplementation(async (url: string) => {
    if (url === "/auth/me") return { user: OWNER };
    if (url === "/setup/state") return setupState();
    if (url === "/projects/p1/analysis-people") return people();
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

class FakeSocket {
  static instances: FakeSocket[] = [];
  static OPEN = 1;

  readyState = 0;
  sent: unknown[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;

  constructor(public url: string) {
    FakeSocket.instances.push(this);
  }
  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }
  close(): void {
    this.readyState = 3;
  }

  accept(): void {
    this.readyState = 1;
    act(() => this.onopen?.());
  }
  deliver(frame: unknown): void {
    act(() => this.onmessage?.({ data: JSON.stringify(frame) } as MessageEvent));
  }
  drop(code = 1006): void {
    this.readyState = 3;
    act(() => this.onclose?.({ code } as CloseEvent));
  }
}

async function liveSocket(index = 0): Promise<FakeSocket> {
  await waitFor(() => expect(FakeSocket.instances.length).toBeGreaterThan(index));
  return FakeSocket.instances[index]!;
}

beforeEach(() => {
  vi.clearAllMocks();
  FakeSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeSocket);
});
afterEach(() => vi.unstubAllGlobals());

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

  it("the reviewer can also be the co-author; whoever opened the PR is neither", async () => {
    serve([pull(636)]);
    post.mockResolvedValue({ card: { id: "c9", projectId: "p1" }, created: true });
    open();
    await userEvent.click(await screen.findByRole("button", { name: "Analyse PR #636" }));
    const coauthor = await screen.findByLabelText("Co-author");
    expect(within(coauthor).getByRole("option", { name: /albert/ })).toBeDisabled();
    expect(within(coauthor).getByRole("option", { name: "sam" })).toBeEnabled();
    await userEvent.selectOptions(coauthor, "u1");
    await userEvent.click(screen.getByRole("button", { name: "Start analysis" }));
    await waitFor(() => expect(post).toHaveBeenCalledWith("/projects/p1/prs/636/analysis", { reviewerUserId: "u1", coauthorUserId: "u1" }));
  });

  it("without a co-author the request carries only the reviewer", async () => {
    serve([pull(636)]);
    post.mockResolvedValue({ card: { id: "c9", projectId: "p1" }, created: true });
    open();
    await userEvent.click(await screen.findByRole("button", { name: "Analyse PR #636" }));
    await userEvent.click(await screen.findByRole("button", { name: "Start analysis" }));
    await waitFor(() => expect(post).toHaveBeenCalledWith("/projects/p1/prs/636/analysis", { reviewerUserId: "u1" }));
  });

  it("a PR already under analysis says so instead of 'started', and that the chosen roles were not applied", async () => {
    serve([pull(636)]);
    post.mockResolvedValue({ card: { id: "c7", projectId: "p1" }, created: false });
    const onOpenCard = open();
    await userEvent.click(await screen.findByRole("button", { name: "Analyse PR #636" }));
    await userEvent.click(await screen.findByRole("button", { name: "Start analysis" }));
    await waitFor(() => expect(toast.info).toHaveBeenCalledWith(
      "PR #636 already has an analysis open; the roles you picked were not applied", expect.anything(),
    ));
    expect(toast.success).not.toHaveBeenCalled();
    const { action } = vi.mocked(toast.info).mock.calls[0]![1] as unknown as { action: { onClick: () => void } };
    action.onClick();
    expect(onOpenCard).toHaveBeenCalledWith("c7");
  });

  it("when the people cannot be loaded, the row says so and can try again", async () => {
    let fail = true;
    serve([pull(636)], () => {
      if (fail) throw new Error("server returned 500");
      return { people: PEOPLE };
    });
    open();
    await userEvent.click(await screen.findByRole("button", { name: "Analyse PR #636" }));
    expect(await screen.findByText(/server returned 500/)).toBeInTheDocument();
    fail = false;
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByLabelText("Reviewer")).toHaveValue("u1");
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

  it("an account without access to the repository is told so, naming the account and the repository", async () => {
    serve(Object.assign(new Error("Request failed with status code 403"), {
      response: {
        status: 403,
        data: { error: "sem_acesso_repo: a conta GitHub albert-gh não tem acesso a acme/erp", login: "albert-gh", repo: "acme/erp" },
      },
    }));
    open();
    expect(await screen.findByText("The GitHub account used on this project cannot see this repository's pull requests")).toBeInTheDocument();
    expect(screen.getByText("The account albert-gh has no access to acme/erp.")).toBeInTheDocument();
    expect(screen.queryByText(/sem_acesso_repo/)).not.toBeInTheDocument();
  });

  it("shows the error when GitHub does not answer", async () => {
    serve(new Error("GitHub returned 502 while listing pull requests"));
    open();
    expect(await screen.findByText(/GitHub returned 502/)).toBeInTheDocument();
  });

  describe("live setup", () => {
    it("holds the PR on the project's live channel while its roles are chosen, and Cancel lets it go", async () => {
      serve([pull(636)]);
      open();
      const ws = await liveSocket();
      expect(ws.url).toContain("/api/projects/p1/prs/live");
      ws.accept();
      await userEvent.click(await screen.findByRole("button", { name: "Analyse PR #636" }));
      expect(ws.sent).toEqual([{ type: "claim", prNumber: 636 }]);
      await userEvent.click(await screen.findByRole("button", { name: "Cancel" }));
      expect(ws.sent).toEqual([{ type: "claim", prNumber: 636 }, { type: "release", prNumber: 636 }]);
    });

    it("a PR somebody else is setting up shows who, and cannot be taken while they are at it", async () => {
      serve([pull(636), pull(640)]);
      open();
      const ws = await liveSocket();
      ws.accept();
      await screen.findByText("Conciliação 636");
      ws.deliver({ type: "claims", claims: [{ prNumber: 636, userId: "u2", username: "albert" }] });
      expect(await screen.findByText("albert is setting it up")).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Analyse PR #636" })).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Analyse PR #640" })).toBeEnabled();
      ws.deliver({ type: "claims", claims: [] });
      expect(await screen.findByRole("button", { name: "Analyse PR #636" })).toBeEnabled();
    });

    it("its own hold does not lock the one holding it", async () => {
      serve([pull(636)]);
      open();
      const ws = await liveSocket();
      ws.accept();
      await userEvent.click(await screen.findByRole("button", { name: "Analyse PR #636" }));
      ws.deliver({ type: "claims", claims: [{ prNumber: 636, userId: "u1", username: "sam" }] });
      expect(screen.getByRole("button", { name: "Start analysis" })).toBeEnabled();
      expect(screen.queryByText("sam is setting it up")).not.toBeInTheDocument();
    });

    it("losing the race for a PR closes its picker and says who has it, and the picker does not reopen when that person lets go", async () => {
      serve([pull(636)]);
      open();
      const ws = await liveSocket();
      ws.accept();
      await userEvent.click(await screen.findByRole("button", { name: "Analyse PR #636" }));
      await screen.findByRole("button", { name: "Start analysis" });
      ws.deliver({ type: "claim-refused", prNumber: 636, username: "albert" });
      await waitFor(() => expect(screen.queryByRole("button", { name: "Start analysis" })).not.toBeInTheDocument());
      expect(toast.info).toHaveBeenCalledWith("albert is already setting up the analysis of PR #636");
      ws.deliver({ type: "claims", claims: [] });
      expect(await screen.findByRole("button", { name: "Analyse PR #636" })).toBeEnabled();
      expect(screen.queryByRole("button", { name: "Start analysis" })).not.toBeInTheDocument();
    });

    it("an analysis somebody else started shows up without reopening the dialog", async () => {
      const pulls = [pull(636)];
      serve(pulls);
      open();
      const ws = await liveSocket();
      ws.accept();
      await screen.findByRole("button", { name: "Analyse PR #636" });
      pulls[0] = pull(636, { analysisCardId: "c7" });
      ws.deliver({ type: "pulls-changed" });
      expect(await screen.findByText("Analysing")).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Analyse PR #636" })).not.toBeInTheDocument();
    });

    it("an analysis started while the channel was down shows up when it reconnects", async () => {
      const pulls = [pull(636)];
      serve(pulls);
      open();
      const first = await liveSocket();
      first.accept();
      await screen.findByRole("button", { name: "Analyse PR #636" });
      expect(get.mock.calls.filter(([url]) => url === "/projects/p1/prs")).toHaveLength(1);
      first.drop();
      pulls[0] = pull(636, { analysisCardId: "c7" });
      const second = await liveSocket(1);
      second.accept();
      expect(await screen.findByText("Analysing")).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Analyse PR #636" })).not.toBeInTheDocument();
    });

    it("the PR stays held until its start settles, then is let go", async () => {
      serve([pull(636)]);
      const answer: { resolve?: (value: unknown) => void } = {};
      post.mockReturnValue(new Promise((resolve) => { answer.resolve = resolve; }));
      open();
      const ws = await liveSocket();
      ws.accept();
      await userEvent.click(await screen.findByRole("button", { name: "Analyse PR #636" }));
      await userEvent.click(await screen.findByRole("button", { name: "Start analysis" }));
      expect(ws.sent).toEqual([{ type: "claim", prNumber: 636 }]);
      await act(async () => answer.resolve?.({ card: { id: "c9", projectId: "p1" }, created: true }));
      await waitFor(() => expect(ws.sent).toEqual([{ type: "claim", prNumber: 636 }, { type: "release", prNumber: 636 }]));
    });

    it("a hold taken before the channel opens is sent when it opens, and again after a reconnect", async () => {
      serve([pull(636)]);
      open();
      const first = await liveSocket();
      await userEvent.click(await screen.findByRole("button", { name: "Analyse PR #636" }));
      expect(first.sent).toEqual([]);
      first.accept();
      expect(first.sent).toEqual([{ type: "claim", prNumber: 636 }]);
      first.drop();
      const second = await liveSocket(1);
      second.accept();
      expect(second.sent).toEqual([{ type: "claim", prNumber: 636 }]);
    });

    it("a start refused because somebody else took the PR is told who, translated, and its picker closes", async () => {
      serve([pull(636)]);
      post.mockRejectedValue(Object.assign(new Error("Request failed with status code 409"), {
        response: { status: 409, data: { error: "pr_em_montagem: albert está montando a análise do PR #636", username: "albert" } },
      }));
      open();
      (await liveSocket()).accept();
      await userEvent.click(await screen.findByRole("button", { name: "Analyse PR #636" }));
      await userEvent.click(await screen.findByRole("button", { name: "Start analysis" }));
      await waitFor(() => expect(toast.info).toHaveBeenCalledWith("albert is already setting up the analysis of PR #636"));
      expect(toast.error).not.toHaveBeenCalled();
      await waitFor(() => expect(screen.queryByRole("button", { name: "Start analysis" })).not.toBeInTheDocument());
    });

    it("a read-only share is told so, translated, and its picker closes", async () => {
      serve([pull(636)]);
      open();
      const ws = await liveSocket();
      ws.accept();
      await userEvent.click(await screen.findByRole("button", { name: "Analyse PR #636" }));
      await screen.findByRole("button", { name: "Start analysis" });
      ws.deliver({ type: "error", code: "read_only" });
      await waitFor(() => expect(screen.queryByRole("button", { name: "Start analysis" })).not.toBeInTheDocument());
      expect(toast.error).toHaveBeenCalledWith("This project is shared with you read-only: you cannot start an analysis");
    });

    it.each([1008, 1011])("a channel the server closes with %i is not reopened, and says live updates stopped", async (code) => {
      serve([pull(636)]);
      open();
      const ws = await liveSocket();
      ws.accept();
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        ws.drop(code);
        act(() => vi.advanceTimersByTime(RECONNECT_MAX_MS * (1 + RECONNECT_JITTER)));
      } finally {
        vi.useRealTimers();
      }
      expect(FakeSocket.instances).toHaveLength(1);
      expect(toast.error).toHaveBeenCalledWith("Live updates of this list stopped; close and reopen it");
    });

    it("closing the dialog closes the channel", async () => {
      serve([pull(636)]);
      const { rerender } = renderApp(<ProjectPrsDialog projectId="p1" open onOpenChange={() => {}} onOpenCard={vi.fn()} />);
      const ws = await liveSocket();
      ws.accept();
      rerender(<ProjectPrsDialog projectId="p1" open={false} onOpenChange={() => {}} onOpenCard={vi.fn()} />);
      expect(ws.readyState).toBe(3);
    });
  });
});
