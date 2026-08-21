import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { McpManager, splitArgs } from "@/features/board/components/McpManager";
import { renderApp } from "@/test/render";
import { get, post } from "@/lib/api";
import type { BoardMcp } from "@/features/board/api";

vi.mock("@/lib/api", () => ({
  api: { interceptors: { response: { use: vi.fn() } } },
  setUnauthorizedHandler: vi.fn(),
  get: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
  del: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), {
    success: vi.fn(),
    error: vi.fn(),
    message: vi.fn(),
    loading: vi.fn(),
    dismiss: vi.fn(),
  }),
}));

const mockGet = vi.mocked(get);
const mockPost = vi.mocked(post);

const mcps: BoardMcp[] = [
  { id: "m1", name: "linear", kind: "http", url: "https://mcp.example/linear", headerKeys: ["Authorization"] },
  { id: "m2", name: "files", kind: "stdio", command: "npx", args: ["-y", "server-filesystem"], envKeys: ["ROOT", "TOKEN"] },
  { id: "m3", name: "plain", kind: "stdio", command: "echo" },
];

/** `byMcp`: m1 fully configured, m2 missing TOKEN, m3 declares nothing. */
function serve(byMcp: Record<string, Record<string, boolean>> = { m1: { Authorization: true }, m2: { ROOT: true } }) {
  mockGet.mockImplementation((url: string) => {
    if (url === "/mcps") return Promise.resolve({ mcps });
    if (url === "/mcps/secrets") return Promise.resolve({ byMcp });
    return Promise.resolve({});
  });
}

async function openDialog() {
  const user = userEvent.setup();
  renderApp(<McpManager />);
  await user.click(screen.getByRole("button", { name: "MCP" }));
  await screen.findByText("linear");
  return user;
}

beforeEach(() => {
  vi.resetAllMocks();
  serve();
});

describe("splitArgs", () => {
  it("splits on whitespace and drops the blanks — there is no shell on the other end", () => {
    expect(splitArgs("  -y   @scope/server  /work ")).toEqual(["-y", "@scope/server", "/work"]);
    expect(splitArgs("   ")).toEqual([]);
  });
});

describe("McpManager — secret status", () => {
  it("reads the status route once the dialog is open", async () => {
    await openDialog();
    await waitFor(() => expect(mockGet).toHaveBeenCalledWith("/mcps/secrets"));
  });

  it("says a fully configured server is configured, counting its secrets", async () => {
    await openDialog();
    expect(await screen.findByText("1 secret configured")).toBeInTheDocument();
  });

  it("names exactly the value that is missing, rather than listing every key neutrally", async () => {
    await openDialog();
    // The old UI showed ROOT and TOKEN as identical grey badges — this is the whole point.
    expect(await screen.findByText("missing a value: TOKEN")).toBeInTheDocument();
  });

  it("shows no status line at all for a server that takes no secrets", async () => {
    await openDialog();
    const rows = screen.getAllByText(/configured|missing a value/);
    expect(rows).toHaveLength(2); // m1 and m2 only — never a green tick for m3.
  });

  it("treats an unanswered server as missing, not as fine", async () => {
    serve({});
    await openDialog();
    expect(await screen.findByText("missing a value: Authorization")).toBeInTheDocument();
  });
});

describe("McpManager — editing values in place", () => {
  it("offers a pencil only where there is something to edit", async () => {
    await openDialog();
    expect(screen.getByRole("button", { name: "Edit values for linear" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Edit values for plain" })).not.toBeInTheDocument();
  });

  it("opens fields that start EMPTY — the browser never receives a stored value", async () => {
    const user = await openDialog();
    await user.click(screen.getByRole("button", { name: "Edit values for files" }));

    const root = screen.getByLabelText("New value for ROOT") as HTMLInputElement;
    expect(root.value).toBe("");
    expect(root.type).toBe("password");
    // The placeholder is what tells them apart: one is set, one is not.
    expect(root.placeholder).toMatch(/configured/);
    expect((screen.getByLabelText("New value for TOKEN") as HTMLInputElement).placeholder).toMatch(/missing/);
  });

  it("writes ONLY the fields that were filled in, so a blank keeps what is in the vault", async () => {
    mockPost.mockResolvedValue({ ok: true });
    const user = await openDialog();
    await user.click(screen.getByRole("button", { name: "Edit values for files" }));

    // Rotate TOKEN and leave ROOT alone — the reason this editor exists.
    await user.type(screen.getByLabelText("New value for TOKEN"), "sk-new");
    await user.click(screen.getByRole("button", { name: "Save values" }));

    await waitFor(() => expect(mockPost).toHaveBeenCalledWith("/mcps/m2/secret", { key: "TOKEN", value: "sk-new" }));
    expect(mockPost).not.toHaveBeenCalledWith("/mcps/m2/secret", expect.objectContaining({ key: "ROOT" }));
  });

  it("keeps Save disabled while every field is still blank", async () => {
    const user = await openDialog();
    await user.click(screen.getByRole("button", { name: "Edit values for files" }));
    expect((screen.getByRole("button", { name: "Save values" }) as HTMLButtonElement).disabled).toBe(true);

    await user.type(screen.getByLabelText("New value for ROOT"), "x");
    expect((screen.getByRole("button", { name: "Save values" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("opens one editor at a time", async () => {
    const user = await openDialog();
    await user.click(screen.getByRole("button", { name: "Edit values for files" }));
    expect(screen.getByLabelText("New value for ROOT")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Edit values for linear" }));
    expect(screen.queryByLabelText("New value for ROOT")).not.toBeInTheDocument();
    expect(screen.getByLabelText("New value for Authorization")).toBeInTheDocument();
  });

  it("closes the editor again on a second click of the pencil", async () => {
    const user = await openDialog();
    const pencil = screen.getByRole("button", { name: "Edit values for files" });
    await user.click(pencil);
    expect(screen.getByLabelText("New value for ROOT")).toBeInTheDocument();
    await user.click(pencil);
    expect(screen.queryByLabelText("New value for ROOT")).not.toBeInTheDocument();
  });

  it("re-reads the status after saving, so the amber line turns green", async () => {
    mockPost.mockResolvedValue({ ok: true });
    const user = await openDialog();
    await user.click(screen.getByRole("button", { name: "Edit values for files" }));
    await user.type(screen.getByLabelText("New value for TOKEN"), "sk-new");
    await user.click(screen.getByRole("button", { name: "Save values" }));

    await waitFor(() => expect(mockGet.mock.calls.filter(([u]) => u === "/mcps/secrets").length).toBeGreaterThan(1));
  });
});

describe("McpManager — apply", () => {
  it("restarts the idle terminals alongside the injection by default", async () => {
    mockPost.mockResolvedValue({ ok: true, restarted: 2, skipped: 1 });
    const user = await openDialog();

    await user.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(mockPost).toHaveBeenCalledWith("/mcps/apply"));
    await waitFor(() => expect(mockPost).toHaveBeenCalledWith("/cards/restart-all"));
  });

  it("injects without touching running terminals when the switch is off", async () => {
    mockPost.mockResolvedValue({ ok: true });
    const user = await openDialog();

    await user.click(within(screen.getByRole("dialog")).getByRole("switch", { name: "Restart idle terminals" }));
    await user.click(screen.getByRole("button", { name: "Apply" }));

    await waitFor(() => expect(mockPost).toHaveBeenCalledWith("/mcps/apply"));
    expect(mockPost).not.toHaveBeenCalledWith("/cards/restart-all");
  });
});
