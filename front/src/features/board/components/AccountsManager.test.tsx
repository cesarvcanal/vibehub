import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AccountsManager } from "@/features/board/components/AccountsManager";
import { renderApp, testQueryClient } from "@/test/render";
import { get } from "@/lib/api";
import { ACCOUNT_TOKENS_KEY, ACCOUNT_USAGE_KEY } from "@/features/board/api";

/**
 * The accounts dialog is where an account is BORN, and until now the last step of that birth —
 * `claude /login` in the right profile — happened over SSH, by hand, outside the product. These
 * tests pin the screen-only path: a button per row, a terminal already inside that profile, and a
 * close that refreshes everything the login just changed.
 */

vi.mock("@/lib/api", () => ({
  api: { interceptors: { response: { use: vi.fn() } } },
  setUnauthorizedHandler: vi.fn(),
  get: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
  del: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
}));

// The real xterm needs a canvas and a WebSocket; what matters here is WHERE it is pointed.
vi.mock("@/features/board/components/XTerminal", () => ({
  XTerminal: ({ wsPath, ariaLabel }: { wsPath: string; ariaLabel?: string }) => (
    <div data-testid="xterm" data-ws={wsPath} aria-label={ariaLabel} />
  ),
}));

const mockGet = vi.mocked(get);

/** `tech` has never logged in; the built-in profile has, and reports its usage. */
function serve() {
  mockGet.mockImplementation((url: string) => {
    if (url === "/auth/me") return Promise.resolve({ user: { id: "1", username: "operator", role: "owner" } });
    if (url === "/accounts") {
      return Promise.resolve({ accounts: [{ slug: "tech", name: "Tech", createdAt: 1 }], defaultLabel: "Main" });
    }
    if (url === "/accounts/tokens") return Promise.resolve({ bySlug: { tech: false }, defaultHasToken: true });
    if (url === "/accounts/usage") {
      return Promise.resolve({
        bySlug: {
          default: { available: true, fiveHour: { utilization: 31, resetsAt: null }, fetchedAt: 1 },
          tech: { available: false, error: "no_credentials", fetchedAt: 1 },
        },
        fetchedAt: 1,
      });
    }
    return Promise.resolve({});
  });
}

/** Opens the dialog the way the board does — the icon button in the bar. */
async function openDialog(user: ReturnType<typeof userEvent.setup>) {
  const client = testQueryClient();
  const view = renderApp(<AccountsManager />, { queryClient: client });
  await user.click(screen.getByRole("button", { name: "Claude accounts" }));
  await screen.findByText("Tech");
  return { ...view, client };
}

beforeEach(() => {
  vi.resetAllMocks();
  serve();
});

describe("AccountsManager — signing a profile in", () => {
  it("offers Sign in on every row, the built-in profile included", async () => {
    const user = userEvent.setup();
    await openDialog(user);

    expect(screen.getByRole("button", { name: "Sign in — Main" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign in — Tech" })).toBeInTheDocument();
  });

  it("makes the button primary on the account that has no login — there it IS the fix", async () => {
    const user = userEvent.setup();
    await openDialog(user);

    // The row with no credentials shows the labelled, filled button…
    const needsIt = await screen.findByRole("button", { name: "Sign in — Tech" });
    await waitFor(() => expect(needsIt).toHaveTextContent("Sign in"));
    // …while the signed-in profile keeps a quiet icon next to the token key.
    expect(screen.getByRole("button", { name: "Sign in — Main" })).not.toHaveTextContent("Sign in");
  });

  it("opens a terminal already inside THAT account's profile", async () => {
    const user = userEvent.setup();
    await openDialog(user);

    await user.click(screen.getByRole("button", { name: "Sign in — Tech" }));
    const term = await screen.findByTestId("xterm");
    expect(term).toHaveAttribute("data-ws", "/api/accounts/tech/login-terminal");
    expect(term).toHaveAttribute("aria-label", "Claude login terminal — Tech");
    // The instruction is on screen, because the OAuth link opens outside the terminal.
    expect(screen.getByText(/Cmd-click the link/i)).toBeInTheDocument();
  });

  it("addresses the built-in profile by the slug the routes accept", async () => {
    const user = userEvent.setup();
    await openDialog(user);

    await user.click(screen.getByRole("button", { name: "Sign in — Main" }));
    expect(await screen.findByTestId("xterm")).toHaveAttribute(
      "data-ws",
      "/api/accounts/default/login-terminal",
    );
  });

  it("re-reads the tokens AND the usage on close, so the bars light up right there", async () => {
    const user = userEvent.setup();
    const { client } = await openDialog(user);
    const invalidate = vi.spyOn(client, "invalidateQueries");

    await user.click(screen.getByRole("button", { name: "Sign in — Tech" }));
    await screen.findByTestId("xterm");
    await user.keyboard("{Escape}");

    await waitFor(() => expect(screen.queryByTestId("xterm")).not.toBeInTheDocument());
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ACCOUNT_TOKENS_KEY });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ACCOUNT_USAGE_KEY });
  });

  it("still shows each account's plan usage next to its name", async () => {
    const user = userEvent.setup();
    await openDialog(user);

    // The built-in profile has numbers…
    await waitFor(() => expect(screen.getByRole("progressbar", { name: "5h session" })).toBeInTheDocument());
    // …and the one that never logged in says what to do instead of showing an empty bar.
    const rows = screen.getByText("Tech").closest("div")?.parentElement as HTMLElement;
    expect(within(rows).getByText(/no interactive login on the runner/i)).toHaveTextContent(
      "/root/.claude-profiles/tech",
    );
  });
});
