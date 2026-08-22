import { describe, expect, it, vi, beforeEach } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ProjectFormDialog } from "@/features/board/components/ProjectFormDialog";
import { renderApp } from "@/test/render";
import type { GithubConnection, GithubRepo, Project } from "@/api/types";

const get = vi.fn();
const post = vi.fn();
const patch = vi.fn();
const del = vi.fn();
vi.mock("@/lib/api", () => ({
  api: { interceptors: { response: { use: vi.fn() } } },
  setUnauthorizedHandler: vi.fn(),
  get: (...a: unknown[]) => get(...a),
  post: (...a: unknown[]) => post(...a),
  patch: (...a: unknown[]) => patch(...a),
  del: (...a: unknown[]) => del(...a),
}));

const PERSONAL: GithubConnection = { id: "OCTOCAT", label: "personal", login: "octocat", createdAt: 1, ok: true };
const ORG: GithubConnection = { id: "ACME_INC", label: "acme org", login: "acme-inc", createdAt: 2, ok: true };

function repo(fullName: string): GithubRepo {
  return {
    fullName,
    cloneUrl: `https://github.com/${fullName}.git`,
    private: true,
    defaultBranch: "main",
    updatedAt: "2026-08-01T00:00:00Z",
  };
}

/** Each account owns different repositories — that is the whole point of the picker. */
const REPOS: Record<string, GithubRepo[]> = {
  "": [repo("octocat/hello")],
  OCTOCAT: [repo("octocat/hello")],
  ACME_INC: [repo("acme-inc/erp-aux")],
};

/** Records every `/github/repos` request so a test can assert which account was read through. */
const reposCalls: (string | undefined)[] = [];

function serve(connections: GithubConnection[]): void {
  get.mockImplementation(async (url: string, config?: { params?: Record<string, string> }) => {
    if (url === "/github") return { connections };
    if (url === "/github/repos") {
      const connection = config?.params?.connection;
      reposCalls.push(connection);
      return { repos: REPOS[connection ?? ""] ?? [] };
    }
    if (url.includes("/branches")) return { branches: ["dev", "main"] };
    if (url === "/accounts") return { accounts: [], defaultLabel: "" };
    if (url === "/auth/me") return { user: { id: "1", username: "operator" } };
    return {};
  });
}

/** The repository <select>. "Repository" also labels the search box above it, hence the tag filter. */
function repoSelect(): HTMLSelectElement {
  const select = screen.getAllByLabelText("Repository").find((el) => el.tagName === "SELECT");
  if (!select) throw new Error("repository select not rendered");
  return select as HTMLSelectElement;
}

beforeEach(() => {
  vi.clearAllMocks();
  reposCalls.length = 0;
  serve([PERSONAL, ORG]);
});

describe("ProjectFormDialog — GitHub account picker", () => {
  it("asks which account when there is more than one, listing label and login", async () => {
    renderApp(<ProjectFormDialog open onOpenChange={() => {}} />);
    const picker = await screen.findByLabelText("GitHub account");
    expect(within(picker).getByRole("option", { name: "personal · octocat" })).toBeInTheDocument();
    expect(within(picker).getByRole("option", { name: "acme org · acme-inc" })).toBeInTheDocument();
    // it comes BEFORE the repository picker — you cannot search until you know where to search
    const repoSearch = repoSelect();
    expect(picker.compareDocumentPosition(repoSearch) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("does NOT ask when there is a single account — nothing to decide", async () => {
    serve([PERSONAL]);
    renderApp(<ProjectFormDialog open onOpenChange={() => {}} />);
    await waitFor(() => expect(repoSelect()).toBeInTheDocument());
    expect(screen.queryByLabelText("GitHub account")).toBeNull();
  });

  it("searches repositories through the account that is selected", async () => {
    renderApp(<ProjectFormDialog open onOpenChange={() => {}} />);
    const picker = await screen.findByLabelText("GitHub account");
    // the first account is what the server would default to, so that is what is read first
    await waitFor(() => expect(reposCalls).toContain("OCTOCAT"));
    await waitFor(() =>
      expect(within(repoSelect()).getByRole("option", { name: /octocat\/hello/ })).toBeInTheDocument(),
    );

    await userEvent.selectOptions(picker, "ACME_INC");
    await waitFor(() => expect(reposCalls).toContain("ACME_INC"));
    await waitFor(() =>
      expect(within(repoSelect()).getByRole("option", { name: /acme-inc\/erp-aux/ })).toBeInTheDocument(),
    );
  });

  it("drops the repository when the account changes — a repo belongs to ONE account", async () => {
    renderApp(<ProjectFormDialog open onOpenChange={() => {}} />);
    const picker = await screen.findByLabelText("GitHub account");
    await waitFor(() => expect(repoSelect()).toBeInTheDocument());
    await waitFor(() =>
      expect(within(repoSelect()).getByRole("option", { name: /octocat\/hello/ })).toBeInTheDocument(),
    );
    await userEvent.selectOptions(repoSelect(), "octocat/hello");
    expect(repoSelect()).toHaveValue("octocat/hello");

    await userEvent.selectOptions(picker, "ACME_INC");
    await waitFor(() => expect(repoSelect()).toHaveValue(""));
  });

  it("creates the project with the chosen account", async () => {
    post.mockResolvedValue({ project: { id: "p1", name: "erp-aux" } });
    renderApp(<ProjectFormDialog open onOpenChange={() => {}} />);
    await userEvent.selectOptions(await screen.findByLabelText("GitHub account"), "ACME_INC");
    await userEvent.type(screen.getByLabelText("Name"), "erp-aux");
    await userEvent.click(screen.getByRole("button", { name: "Create project" }));

    await waitFor(() =>
      expect(post).toHaveBeenCalledWith("/projects", expect.objectContaining({
        name: "erp-aux",
        githubConnectionId: "ACME_INC",
      })),
    );
  });

  it("stores NO account reference on a single-account install", async () => {
    serve([PERSONAL]);
    post.mockResolvedValue({ project: { id: "p1", name: "hello" } });
    renderApp(<ProjectFormDialog open onOpenChange={() => {}} />);
    await userEvent.type(await screen.findByLabelText("Name"), "hello");
    await userEvent.click(screen.getByRole("button", { name: "Create project" }));

    await waitFor(() =>
      expect(post).toHaveBeenCalledWith("/projects", expect.objectContaining({ githubConnectionId: undefined })),
    );
  });

  it("points at Settings, and says it is a token, when no account is connected", async () => {
    serve([]);
    renderApp(<ProjectFormDialog open onOpenChange={() => {}} />);
    expect(await screen.findByLabelText("Clone URL")).toBeInTheDocument();
    expect(screen.getByText(/pasted token, not a login/i)).toBeInTheDocument();
  });
});

describe("ProjectFormDialog — editing", () => {
  const PROJECT: Project = {
    id: "p1",
    name: "erp-aux",
    repoFullName: "acme-inc/erp-aux",
    cloneUrl: "https://github.com/acme-inc/erp-aux.git",
    baseBranch: "dev",
    githubConnectionId: "ACME_INC",
    position: 0,
    createdAt: 1,
  };

  it("opens on the project's current account", async () => {
    renderApp(<ProjectFormDialog open onOpenChange={() => {}} project={PROJECT} />);
    await waitFor(() => expect(screen.getByLabelText("GitHub account")).toHaveValue("ACME_INC"));
    expect(screen.getByLabelText("Name")).toHaveValue("erp-aux");
  });

  it("moves the project to another account with a PATCH", async () => {
    patch.mockResolvedValue({ project: { ...PROJECT, githubConnectionId: "OCTOCAT" } });
    renderApp(<ProjectFormDialog open onOpenChange={() => {}} project={PROJECT} />);
    await userEvent.selectOptions(await screen.findByLabelText("GitHub account"), "OCTOCAT");
    await userEvent.click(screen.getByRole("button", { name: "Save project" }));

    await waitFor(() =>
      expect(patch).toHaveBeenCalledWith("/projects/p1", expect.objectContaining({
        name: "erp-aux",
        githubConnectionId: "OCTOCAT",
      })),
    );
  });
});
