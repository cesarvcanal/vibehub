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
    if (url === "/github") return { connected: false };
    if (url === "/transcribe") return { available: false, proofread: false, language: "pt" };
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

  it("connects GitHub with the pasted token and clears the field", async () => {
    post.mockResolvedValue({ connected: true, login: "octocat" });
    renderApp(<SettingsDialog open onOpenChange={() => {}} />);
    const field = await screen.findByLabelText("GitHub token");
    await userEvent.type(field, "ghp_abc");
    await userEvent.click(screen.getByRole("button", { name: "Connect" }));
    await waitFor(() => expect(post).toHaveBeenCalledWith("/github/token", { token: "ghp_abc" }));
    await waitFor(() => expect(field).toHaveValue(""));
  });
});
