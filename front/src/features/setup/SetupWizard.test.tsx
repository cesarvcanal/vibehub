import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route, Routes } from "react-router-dom";
import { SetupWizard } from "@/features/setup/SetupWizard";
import { apiReject, freshState, renderApp, setupState } from "@/test/render";
import { get, patch, post } from "@/lib/api";
import type { SetupState } from "@/api/types";

vi.mock("@/lib/api", () => ({
  api: { interceptors: { response: { use: vi.fn() } } },
  setUnauthorizedHandler: vi.fn(),
  get: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
  del: vi.fn(),
}));

vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }) }));

const mockGet = vi.mocked(get);
const mockPost = vi.mocked(post);
const mockPatch = vi.mocked(patch);

/**
 * Serve one setup state to every probe. `read()` counts calls, which is how the resumability
 * tests prove the wizard re-derives its step from the server rather than remembering one.
 */
function serve(state: SetupState, { signedIn = false } = {}) {
  const calls = { setup: 0 };
  mockGet.mockImplementation((url: string) => {
    if (url === "/setup/state") {
      calls.setup += 1;
      return Promise.resolve(state);
    }
    if (url === "/auth/me") {
      return signedIn
        ? Promise.resolve({ user: { id: "1", username: "operator", role: "owner" } })
        : Promise.reject(apiReject(401, "no session"));
    }
    if (url === "/github") return Promise.resolve({ connected: false });
    return Promise.reject(new Error(`unexpected GET ${url}`));
  });
  return calls;
}

function partial(steps: Partial<SetupState["steps"]>): SetupState {
  return setupState({
    fresh: false,
    steps: { owner: false, runner: false, claude: false, github: false, ...steps },
  });
}

describe("SetupWizard — which step is current", () => {
  beforeEach(() => vi.resetAllMocks());

  it("starts on the owner step for a fresh install", async () => {
    serve(freshState());
    renderApp(<SetupWizard />, { route: "/setup" });

    expect(
      await screen.findByRole("heading", { name: "Create the owner account", level: 2 }),
    ).toBeInTheDocument();
  });

  it("shows the runner step once an owner exists", async () => {
    serve(partial({ owner: true }));
    renderApp(<SetupWizard />, { route: "/setup" });

    expect(
      await screen.findByRole("heading", { name: "Choose where the runner lives", level: 2 }),
    ).toBeInTheDocument();
  });

  it("shows the GitHub step once the runner is up", async () => {
    serve(partial({ owner: true, runner: true }));
    renderApp(<SetupWizard />, { route: "/setup" });

    expect(
      await screen.findByRole("heading", { name: "Connect GitHub", level: 2 }),
    ).toBeInTheDocument();
  });

  it("shows the Claude step once GitHub is connected", async () => {
    serve(partial({ owner: true, runner: true, github: true }));
    renderApp(<SetupWizard />, { route: "/setup" });

    expect(
      await screen.findByRole("heading", { name: "Sign in to Claude", level: 2 }),
    ).toBeInTheDocument();
  });

  it("explains why every step exists", async () => {
    serve(freshState());
    renderApp(<SetupWizard />, { route: "/setup" });

    await screen.findByRole("heading", { name: "Create the owner account", level: 2 });
    expect(screen.getByText(/This first account owns the install/i)).toBeInTheDocument();
  });

  it("renders the rail with every step and marks the current one", async () => {
    serve(partial({ owner: true, runner: true }));
    renderApp(<SetupWizard />, { route: "/setup" });

    const rail = await screen.findByRole("list", { name: "Setup steps" });
    expect(rail).toHaveTextContent("Create the owner account");
    expect(rail).toHaveTextContent("Sign in to Claude");
    const current = rail.querySelector('[aria-current="step"]');
    expect(current).toHaveTextContent("Connect GitHub");
  });
});

describe("SetupWizard — resumability", () => {
  beforeEach(() => vi.resetAllMocks());

  it("lands on the same step after a refresh, because the step comes from the server", async () => {
    const state = partial({ owner: true, runner: true, github: true });
    serve(state);

    const first = renderApp(<SetupWizard />, { route: "/setup" });
    await screen.findByRole("heading", { name: "Sign in to Claude", level: 2 });
    first.unmount();

    // A refresh throws away every scrap of client state — new query cache, new provider tree.
    renderApp(<SetupWizard />, { route: "/setup" });
    expect(
      await screen.findByRole("heading", { name: "Sign in to Claude", level: 2 }),
    ).toBeInTheDocument();
  });

  it("re-reads /api/setup/state on mount rather than trusting a stored step", async () => {
    const calls = serve(partial({ owner: true }));
    renderApp(<SetupWizard />, { route: "/setup" });

    await screen.findByRole("heading", { name: "Choose where the runner lives", level: 2 });
    expect(calls.setup).toBeGreaterThan(0);
  });

  it("advances when the refreshed state reports the previous step is done", async () => {
    const user = userEvent.setup();
    let state = freshState();
    mockGet.mockImplementation((url: string) => {
      if (url === "/setup/state") return Promise.resolve(state);
      if (url === "/auth/me") return Promise.reject(apiReject(401, "no session"));
      return Promise.reject(new Error(`unexpected GET ${url}`));
    });
    // Creating the owner flips the server's answer; the wizard re-reads and moves on.
    mockPost.mockImplementation((url: string) => {
      if (url === "/setup/owner") {
        state = partial({ owner: true });
        return Promise.resolve({});
      }
      return Promise.reject(new Error(`unexpected POST ${url}`));
    });

    renderApp(<SetupWizard />, { route: "/setup" });
    await screen.findByRole("heading", { name: "Create the owner account", level: 2 });

    await user.type(screen.getByLabelText("Username"), "operator");
    await user.type(screen.getByLabelText("Password"), "hunter2hunter2");
    await user.type(screen.getByLabelText("Confirm password"), "hunter2hunter2");
    await user.click(screen.getByRole("button", { name: "Create account and continue" }));

    await waitFor(() =>
      expect(mockPost).toHaveBeenCalledWith("/setup/owner", {
        username: "operator",
        password: "hunter2hunter2",
      }),
    );
    expect(
      await screen.findByRole("heading", { name: "Choose where the runner lives", level: 2 }),
    ).toBeInTheDocument();
  });

  it("skips a finished install straight to the board", async () => {
    serve(setupState(), { signedIn: true });
    renderApp(
      <Routes>
        <Route path="/setup" element={<SetupWizard />} />
        <Route path="/" element={<div>board</div>} />
      </Routes>,
      { route: "/setup" },
    );

    expect(await screen.findByText("board")).toBeInTheDocument();
  });
});

describe("SetupWizard — owner step validation", () => {
  beforeEach(() => vi.resetAllMocks());

  it("refuses to submit until the passwords match and are long enough", async () => {
    const user = userEvent.setup();
    serve(freshState());
    renderApp(<SetupWizard />, { route: "/setup" });

    await screen.findByRole("heading", { name: "Create the owner account", level: 2 });
    const submit = screen.getByRole("button", { name: "Create account and continue" });
    expect(submit).toBeDisabled();

    await user.type(screen.getByLabelText("Username"), "operator");
    await user.type(screen.getByLabelText("Password"), "short");
    await user.type(screen.getByLabelText("Confirm password"), "short");
    expect(submit).toBeDisabled();
    expect(screen.getByText("At least 8 characters.")).toBeInTheDocument();

    await user.clear(screen.getByLabelText("Password"));
    await user.type(screen.getByLabelText("Password"), "hunter2hunter2");
    expect(screen.getByText("The passwords do not match.")).toBeInTheDocument();
    expect(submit).toBeDisabled();

    await user.clear(screen.getByLabelText("Confirm password"));
    await user.type(screen.getByLabelText("Confirm password"), "hunter2hunter2");
    expect(submit).toBeEnabled();
  });

  it("surfaces the server's error and stays on the step", async () => {
    const user = userEvent.setup();
    serve(freshState());
    mockPost.mockRejectedValue(apiReject(409, "an owner already exists"));
    renderApp(<SetupWizard />, { route: "/setup" });

    await screen.findByRole("heading", { name: "Create the owner account", level: 2 });
    await user.type(screen.getByLabelText("Username"), "operator");
    await user.type(screen.getByLabelText("Password"), "hunter2hunter2");
    await user.type(screen.getByLabelText("Confirm password"), "hunter2hunter2");
    await user.click(screen.getByRole("button", { name: "Create account and continue" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("an owner already exists");
    expect(
      screen.getByRole("heading", { name: "Create the owner account", level: 2 }),
    ).toBeInTheDocument();
  });
});

describe("SetupWizard — runner step", () => {
  beforeEach(() => vi.resetAllMocks());

  it("only asks for SSH details when a remote host is chosen", async () => {
    const user = userEvent.setup();
    serve(partial({ owner: true }));
    renderApp(<SetupWizard />, { route: "/setup" });

    await screen.findByRole("heading", { name: "Choose where the runner lives", level: 2 });
    expect(screen.queryByLabelText("Host")).not.toBeInTheDocument();

    await user.click(screen.getByRole("radio", { name: /remote host over SSH/i }));
    expect(await screen.findByLabelText("Host")).toBeInTheDocument();
    // No host typed yet, so there is nothing to provision.
    expect(screen.getByRole("button", { name: "Provision the runner" })).toBeDisabled();
  });

  it("saves the runner location, provisions, then advances on a good re-read", async () => {
    const user = userEvent.setup();
    let state = partial({ owner: true });
    mockGet.mockImplementation((url: string) => {
      if (url === "/setup/state") return Promise.resolve(state);
      if (url === "/auth/me") return Promise.resolve({ user: { id: "1", username: "operator", role: "owner" } });
      return Promise.reject(new Error(`unexpected GET ${url}`));
    });
    mockPatch.mockResolvedValue({});
    mockPost.mockImplementation((url: string) => {
      if (url === "/runner/provision") {
        state = partial({ owner: true, runner: true });
        return Promise.resolve({ ok: true });
      }
      return Promise.reject(new Error(`unexpected POST ${url}`));
    });

    renderApp(<SetupWizard />, { route: "/setup" });
    await screen.findByRole("heading", { name: "Choose where the runner lives", level: 2 });
    await user.click(screen.getByRole("button", { name: "Provision the runner" }));

    await waitFor(() =>
      expect(mockPatch).toHaveBeenCalledWith("/settings", { runner: { kind: "local" } }),
    );
    expect(mockPost).toHaveBeenCalledWith("/runner/provision");
    expect(
      await screen.findByRole("heading", { name: "Connect GitHub", level: 2 }),
    ).toBeInTheDocument();
  });

  it("reports the server's detail when the runner does not come up", async () => {
    const user = userEvent.setup();
    const stuck = setupState({
      fresh: false,
      steps: { owner: true, runner: false, claude: false, github: false },
      runner: {
        running: false,
        exists: false,
        claudeInstalled: false,
        dockerReachable: false,
        container: "vibehub-runner",
        detail: "cannot connect to the Docker daemon",
      },
    });
    serve(stuck, { signedIn: true });
    mockPatch.mockResolvedValue({});
    mockPost.mockResolvedValue({ ok: true });

    renderApp(<SetupWizard />, { route: "/setup" });
    await screen.findByRole("heading", { name: "Choose where the runner lives", level: 2 });
    await user.click(screen.getByRole("button", { name: "Provision the runner" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "cannot connect to the Docker daemon",
    );
  });
});

describe("SetupWizard — GitHub step", () => {
  beforeEach(() => vi.resetAllMocks());

  it("says out loud that connecting means PASTING a token, not logging in", async () => {
    serve(partial({ owner: true, runner: true }));
    renderApp(<SetupWizard />, { route: "/setup" });

    await screen.findByRole("heading", { name: "Connect GitHub", level: 2 });
    expect(screen.getByText(/Paste a token — no login needed/i)).toBeInTheDocument();
    expect(screen.getByText(/Fine-grained PAT with Contents read\/write/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /github.com\/settings\/tokens/i })).toHaveAttribute(
      "href", "https://github.com/settings/tokens",
    );
  });

  it("is skippable and moves on to Claude", async () => {
    const user = userEvent.setup();
    serve(partial({ owner: true, runner: true }));
    renderApp(<SetupWizard />, { route: "/setup" });

    await screen.findByRole("heading", { name: "Connect GitHub", level: 2 });
    await user.click(screen.getByRole("button", { name: "Skip for now" }));

    expect(
      await screen.findByRole("heading", { name: "Sign in to Claude", level: 2 }),
    ).toBeInTheDocument();
  });

  it("stores the token and shows the login it resolves to", async () => {
    const user = userEvent.setup();
    let state = partial({ owner: true, runner: true });
    mockGet.mockImplementation((url: string) => {
      if (url === "/setup/state") return Promise.resolve(state);
      if (url === "/auth/me") return Promise.resolve({ user: { id: "1", username: "operator", role: "owner" } });
      if (url === "/github") {
        return Promise.resolve({
          connections: [{ id: "OCTO_DEV", label: "personal", login: "octo-dev", createdAt: 1, ok: true }],
        });
      }
      return Promise.reject(new Error(`unexpected GET ${url}`));
    });
    mockPost.mockImplementation((url: string) => {
      if (url === "/github/token") {
        state = partial({ owner: true, runner: true, github: true });
        return Promise.resolve({});
      }
      return Promise.reject(new Error(`unexpected POST ${url}`));
    });

    renderApp(<SetupWizard />, { route: "/setup" });
    await screen.findByRole("heading", { name: "Connect GitHub", level: 2 });
    await user.type(screen.getByLabelText("Account name"), "personal");
    await user.type(screen.getByLabelText("Access token"), "ghp_example_token");
    await user.click(screen.getByRole("button", { name: "Connect" }));

    await waitFor(() =>
      expect(mockPost).toHaveBeenCalledWith("/github/token", { token: "ghp_example_token", label: "personal" }),
    );
    expect(
      await screen.findByRole("heading", { name: "Sign in to Claude", level: 2 }),
    ).toBeInTheDocument();
  });

  it("keeps you on the step when GitHub rejects the token", async () => {
    const user = userEvent.setup();
    serve(partial({ owner: true, runner: true }));
    mockPost.mockRejectedValue(apiReject(400, "bad credentials"));

    renderApp(<SetupWizard />, { route: "/setup" });
    await screen.findByRole("heading", { name: "Connect GitHub", level: 2 });
    await user.type(screen.getByLabelText("Access token"), "ghp_nope");
    await user.click(screen.getByRole("button", { name: "Connect" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("bad credentials");
    expect(screen.getByRole("heading", { name: "Connect GitHub", level: 2 })).toBeInTheDocument();
  });
});

describe("SetupWizard — Claude step", () => {
  beforeEach(() => vi.resetAllMocks());

  it("names the actual runner container in the instructions", async () => {
    serve(
      setupState({
        fresh: false,
        steps: { owner: true, runner: true, github: true, claude: false },
        runner: {
          running: true,
          exists: true,
          claudeInstalled: true,
          dockerReachable: true,
          container: "my-runner",
        },
      }),
    );
    renderApp(<SetupWizard />, { route: "/setup" });

    await screen.findByRole("heading", { name: "Sign in to Claude", level: 2 });
    expect(screen.getByText(/docker exec -it my-runner claude/)).toBeInTheDocument();
    expect(screen.getByText(/long-lived token per account/i)).toBeInTheDocument();
  });

  it("says so when the re-check still finds nobody signed in", async () => {
    const user = userEvent.setup();
    serve(partial({ owner: true, runner: true, github: true }), { signedIn: true });

    renderApp(<SetupWizard />, { route: "/setup" });
    await screen.findByRole("heading", { name: "Sign in to Claude", level: 2 });
    await user.click(screen.getByRole("button", { name: /check again/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Still not signed in");
  });
});
