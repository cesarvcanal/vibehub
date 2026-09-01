import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderApp } from "@/test/render";
import { SettingsDialog } from "./SettingsDialog";

const get = vi.fn();
const patch = vi.fn();
const post = vi.fn();
const del = vi.fn();
vi.mock("@/lib/api", () => ({
  get: (...a: unknown[]) => get(...a),
  patch: (...a: unknown[]) => patch(...a),
  post: (...a: unknown[]) => post(...a),
  del: (...a: unknown[]) => del(...a),
}));

const SETTINGS = {
  git: { name: "Ada", email: "ada@example.com" }, autonomous: true, defaultAccountLabel: null,
  setupCompletedAt: null, transcribeLanguage: "pt", runner: { kind: "local", container: "vibehub-runner", image: "x", host: "this machine" },
};

beforeEach(() => {
  vi.clearAllMocks();
  get.mockImplementation(async (url: string) => {
    if (url === "/settings") return SETTINGS;
    if (url === "/github") return { connections: [] };
    if (url === "/transcribe") return { available: false, proofread: false, language: "pt" };
    if (url === "/credentials") return { credentials: [] };
    throw new Error(`unexpected ${url}`);
  });
});

describe("SettingsDialog", () => {
  it("hydrates the form from the server and saves a patch", async () => {
    patch.mockResolvedValue(SETTINGS);
    renderApp(<SettingsDialog open onOpenChange={() => {}} />);
    const name = await screen.findByLabelText("Name");
    await waitFor(() => expect(name).toHaveValue("Ada"));
    await userEvent.clear(name);
    await userEvent.type(name, "Grace");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(patch).toHaveBeenCalledWith("/settings", expect.objectContaining({
      git: { name: "Grace", email: "ada@example.com" }, autonomous: true, transcribeLanguage: "pt",
    })));
  });

  it("shows a refused save INSIDE the form, and clears it on the next attempt", async () => {
    // Regression: a 400 here used to reach only a corner toast — in practice invisible, so the
    // form just looked broken (the seeded `vibehub@localhost` failed the old email validation and
    // NOTHING on this form could be saved, with no visible reason).
    patch.mockRejectedValueOnce({ response: { data: { error: "git email is not a valid address" } } });
    renderApp(<SettingsDialog open onOpenChange={() => {}} />);
    await waitFor(() => expect(screen.getByLabelText("Name")).toHaveValue("Ada"));

    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    const alert = await screen.findByTestId("settings-save-error");
    expect(alert).toHaveTextContent("git email is not a valid address");

    // A later attempt that succeeds takes the message away with it.
    patch.mockResolvedValue(SETTINGS);
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.queryByTestId("settings-save-error")).toBeNull());
  });

  it("tells the truth about voice keys and never renders a stored value", async () => {
    renderApp(<SettingsDialog open onOpenChange={() => {}} />);
    expect(await screen.findByText(/microphone unavailable/)).toBeInTheDocument();
    expect(screen.queryByDisplayValue(/sk-/)).toBeNull();
  });

  it("sends only the keys that were typed", async () => {
    post.mockResolvedValue({ available: true, proofread: false, language: null });
    renderApp(<SettingsDialog open onOpenChange={() => {}} />);
    await screen.findByLabelText("OpenAI API key");
    await userEvent.type(screen.getByLabelText("OpenAI API key"), "sk-openai-123");
    await userEvent.click(screen.getByRole("button", { name: "Save keys" }));
    await waitFor(() => expect(post).toHaveBeenCalledWith("/transcribe/keys", { openaiKey: "sk-openai-123" }));
  });

});

describe("SettingsDialog — GitHub accounts", () => {
  const CONNECTIONS = [
    { id: "OCTOCAT", label: "personal", login: "octocat", scopes: ["repo"], createdAt: 1, ok: true },
    { id: "ACME_INC", label: "acme org", login: "acme-inc", createdAt: 2, ok: true },
  ];

  function serveConnections(connections: unknown[]): void {
    get.mockImplementation(async (url: string) => {
      if (url === "/settings") return SETTINGS;
      if (url === "/github") return { connections };
      if (url === "/transcribe") return { available: false, proofread: false, language: "pt" };
      if (url === "/credentials") return { credentials: [] };
      throw new Error(`unexpected ${url}`);
    });
  }

  it("says out loud that connecting means PASTING a token, not logging in", async () => {
    renderApp(<SettingsDialog open onOpenChange={() => {}} />);
    expect(await screen.findByText(/Paste a token — no login needed/i)).toBeInTheDocument();
    expect(screen.getByText(/Fine-grained PAT with Contents read\/write/i)).toBeInTheDocument();
    expect(screen.getByText(/classic token with/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /github.com\/settings\/tokens/i })).toHaveAttribute(
      "href", "https://github.com/settings/tokens",
    );
  });

  it("lists every connected account with its login and scopes", async () => {
    serveConnections(CONNECTIONS);
    renderApp(<SettingsDialog open onOpenChange={() => {}} />);
    const list = await screen.findByTestId("github-connections");
    expect(list).toHaveTextContent("personal");
    expect(list).toHaveTextContent("octocat");
    expect(list).toHaveTextContent("repo");
    expect(list).toHaveTextContent("acme org");
    // a fine-grained token reports no scopes — say so rather than leaving a blank
    expect(list).toHaveTextContent("fine-grained");
  });

  it("surfaces an account whose token stopped working", async () => {
    serveConnections([{ ...CONNECTIONS[0], ok: false, error: "GitHub rejected this token (401)" }]);
    renderApp(<SettingsDialog open onOpenChange={() => {}} />);
    expect(await screen.findByText(/GitHub rejected this token \(401\)/)).toBeInTheDocument();
  });

  it("adds an account with a label and a pasted token, then clears both fields", async () => {
    post.mockResolvedValue({ connection: { id: "OCTOCAT", label: "personal", login: "octocat", createdAt: 1 } });
    renderApp(<SettingsDialog open onOpenChange={() => {}} />);
    const label = await screen.findByLabelText("Account label");
    const token = screen.getByLabelText("GitHub token");
    await userEvent.type(label, "personal");
    await userEvent.type(token, "ghp_abc");
    await userEvent.click(screen.getByRole("button", { name: "Add account" }));
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith("/github/connections", { label: "personal", token: "ghp_abc" }),
    );
    await waitFor(() => expect(token).toHaveValue(""));
    expect(label).toHaveValue("");
  });

  it("will not add an account without a token", async () => {
    renderApp(<SettingsDialog open onOpenChange={() => {}} />);
    expect(await screen.findByRole("button", { name: "Add account" })).toBeDisabled();
  });

  it("removes the account the button belongs to", async () => {
    serveConnections(CONNECTIONS);
    del.mockResolvedValue({ ok: true });
    renderApp(<SettingsDialog open onOpenChange={() => {}} />);
    await userEvent.click(await screen.findByRole("button", { name: "Remove acme org" }));
    await waitFor(() => expect(del).toHaveBeenCalledWith("/github/connections/ACME_INC"));
  });

  it("never renders a stored token", async () => {
    serveConnections(CONNECTIONS);
    renderApp(<SettingsDialog open onOpenChange={() => {}} />);
    await screen.findByTestId("github-connections");
    expect(screen.queryByDisplayValue(/ghp_/)).toBeNull();
  });
});

describe("SettingsDialog — Cofre", () => {
  function serveCredentials(credentials: unknown[]): void {
    get.mockImplementation(async (url: string) => {
      if (url === "/settings") return SETTINGS;
      if (url === "/github") return { connections: [] };
      if (url === "/transcribe") return { available: false, proofread: false, language: "pt" };
      if (url === "/credentials") return { credentials };
      throw new Error(`unexpected ${url}`);
    });
  }

  it("lists saved credentials by name and type, never a value", async () => {
    serveCredentials([{ id: "aa11", name: "erp-prod", type: "userpass", createdAt: 1 }]);
    renderApp(<SettingsDialog open onOpenChange={() => {}} />);
    const list = await screen.findByTestId("cofre-list");
    expect(list).toHaveTextContent("erp-prod");
    expect(list).toHaveTextContent("User + password");
    expect(screen.queryByDisplayValue(/erp-prod/)).toBeNull();
  });

  it("adds a userpass credential and clears the fields", async () => {
    serveCredentials([]);
    post.mockResolvedValue({ credential: { id: "x", name: "erp", type: "userpass", createdAt: 1 } });
    renderApp(<SettingsDialog open onOpenChange={() => {}} />);
    await userEvent.type(await screen.findByLabelText("Credential name"), "erp");
    const user = screen.getByLabelText("Username");
    const pass = screen.getByLabelText("Password");
    await userEvent.type(user, "ada");
    await userEvent.type(pass, "s3cr3t");
    await userEvent.click(screen.getByRole("button", { name: "Add credential" }));
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith("/credentials", { name: "erp", type: "userpass", username: "ada", password: "s3cr3t" }),
    );
    await waitFor(() => expect(pass).toHaveValue(""));
  });

  it("switches to a single value field for a token credential", async () => {
    serveCredentials([]);
    post.mockResolvedValue({ credential: { id: "x", name: "tok", type: "token", createdAt: 1 } });
    renderApp(<SettingsDialog open onOpenChange={() => {}} />);
    await userEvent.type(await screen.findByLabelText("Credential name"), "tok");
    await userEvent.selectOptions(screen.getByLabelText("Type"), "token");
    await userEvent.type(screen.getByLabelText("Value"), "tok_123");
    await userEvent.click(screen.getByRole("button", { name: "Add credential" }));
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith("/credentials", { name: "tok", type: "token", value: "tok_123" }),
    );
  });

  it("removes a credential", async () => {
    serveCredentials([{ id: "aa11", name: "gone", type: "token", createdAt: 1 }]);
    del.mockResolvedValue({ ok: true });
    renderApp(<SettingsDialog open onOpenChange={() => {}} />);
    await userEvent.click(await screen.findByRole("button", { name: "Remove credential gone" }));
    await waitFor(() => expect(del).toHaveBeenCalledWith("/credentials/aa11"));
  });
});
