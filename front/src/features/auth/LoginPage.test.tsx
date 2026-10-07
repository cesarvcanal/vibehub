import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { LoginPage } from "@/features/auth/LoginPage";
import { apiReject, renderApp, setupState } from "@/test/render";
import { get, post } from "@/lib/api";
import { setLanguage } from "@/i18n";

vi.mock("@/lib/api", () => ({
  api: { interceptors: { response: { use: vi.fn() } } },
  setUnauthorizedHandler: vi.fn(),
  get: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
  del: vi.fn(),
}));

const mockGet = vi.mocked(get);
const mockPost = vi.mocked(post);

/** Signed out, but the install itself is configured. */
function signedOut() {
  mockGet.mockImplementation((url: string) => {
    if (url === "/setup/state") return Promise.resolve(setupState());
    if (url === "/auth/me") return Promise.reject(apiReject(401, "no session"));
    return Promise.reject(new Error(`unexpected GET ${url}`));
  });
}

describe("LoginPage", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    signedOut();
  });

  it("renders the form", async () => {
    renderApp(<LoginPage />);
    expect(await screen.findByLabelText("Username")).toBeInTheDocument();
    expect(screen.getByLabelText("Password")).toBeInTheDocument();
  });

  it("keeps submit disabled until both fields are filled", async () => {
    const user = userEvent.setup();
    renderApp(<LoginPage />);

    const submit = await screen.findByRole("button", { name: "Sign in" });
    expect(submit).toBeDisabled();

    await user.type(screen.getByLabelText("Username"), "operator");
    expect(submit).toBeDisabled();

    await user.type(screen.getByLabelText("Password"), "hunter2hunter2");
    expect(submit).toBeEnabled();
  });

  it("posts the trimmed credentials on the happy path", async () => {
    const user = userEvent.setup();
    mockPost.mockResolvedValue({});
    renderApp(<LoginPage />);

    await user.type(await screen.findByLabelText("Username"), "  operator  ");
    await user.type(screen.getByLabelText("Password"), "hunter2hunter2");
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() =>
      expect(mockPost).toHaveBeenCalledWith("/auth/login", {
        username: "operator",
        password: "hunter2hunter2",
      }),
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("shows the server's message when the credentials are rejected", async () => {
    const user = userEvent.setup();
    mockPost.mockRejectedValue(apiReject(401, "Invalid username or password"));
    renderApp(<LoginPage />);

    await user.type(await screen.findByLabelText("Username"), "operator");
    await user.type(screen.getByLabelText("Password"), "wrong-password");
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Invalid username or password");
  });

  it("re-enables the form after a failure so you can try again", async () => {
    const user = userEvent.setup();
    mockPost.mockRejectedValueOnce(apiReject(401, "Invalid username or password"));
    renderApp(<LoginPage />);

    await user.type(await screen.findByLabelText("Username"), "operator");
    await user.type(screen.getByLabelText("Password"), "wrong-password");
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    await screen.findByRole("alert");
    expect(screen.getByRole("button", { name: "Sign in" })).toBeEnabled();
    expect(screen.getByLabelText("Username")).toBeEnabled();
  });

  it("falls back to a generic message when the server says nothing useful", async () => {
    const user = userEvent.setup();
    mockPost.mockRejectedValue(new Error("Network Error"));
    renderApp(<LoginPage />);

    await user.type(await screen.findByLabelText("Username"), "operator");
    await user.type(screen.getByLabelText("Password"), "hunter2hunter2");
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Invalid username or password");
  });

  /**
   * The sign-in door is throttled: past a few tries the server answers 429 with a `Retry-After` (in
   * seconds) and stops hashing passwords at all. Showing that as "Invalid username or password"
   * — or the server's English sentence on a Portuguese screen — sends a person who typed the RIGHT
   * password back to retyping it, each try resetting nothing. The page says what happened, and for
   * how long, in the page's language.
   */
  describe("throttled (429)", () => {
    afterEach(() => setLanguage("en"));

    function throttled(retryAfter?: string) {
      const err = apiReject(429, "too many attempts — wait a few minutes and try again");
      Object.assign(err.response, { headers: retryAfter === undefined ? {} : { "retry-after": retryAfter } });
      mockPost.mockRejectedValue(err);
    }

    async function signIn() {
      const user = userEvent.setup();
      renderApp(<LoginPage />);
      await user.type(await screen.findByLabelText(/Username|Usuário/), "operator");
      await user.type(screen.getByLabelText(/Password|Senha/), "hunter2hunter2");
      await user.click(screen.getByRole("button", { name: /Sign in|Entrar/ }));
      return screen.findByRole("alert");
    }

    it("says how long to wait, rounded up to whole minutes", async () => {
      throttled("290");
      expect(await signIn()).toHaveTextContent("Too many sign-in attempts. Try again in 5 minutes.");
    });

    it("says it in Portuguese on a Portuguese screen", async () => {
      setLanguage("pt-BR");
      throttled("60");
      expect(await signIn()).toHaveTextContent("Muitas tentativas de entrar. Tente de novo em 1 minuto.");
    });

    it("still says what happened when the server gives no usable Retry-After", async () => {
      throttled();
      expect(await signIn()).toHaveTextContent("Too many sign-in attempts. Wait a few minutes and try again.");
    });
  });
});
