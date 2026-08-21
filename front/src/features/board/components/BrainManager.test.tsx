import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { BrainManager, formatBrainStamp } from "@/features/board/components/BrainManager";
import { renderApp } from "@/test/render";
import { del, get, post } from "@/lib/api";
import { toast } from "sonner";

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
const mockDel = vi.mocked(del);

const BRAIN = {
  text: "# House rules\nBe brief.",
  defaultText: "# Default\n",
  updatedAt: "2026-08-20T12:00:00.000Z",
};

async function openDialog() {
  const user = userEvent.setup();
  renderApp(<BrainManager />);
  await user.click(screen.getByRole("button", { name: "Brain" }));
  await screen.findByLabelText("Brain text");
  return user;
}

beforeEach(() => {
  vi.resetAllMocks();
  mockGet.mockResolvedValue(BRAIN);
});

describe("formatBrainStamp", () => {
  it("says the default is in use when nothing has ever been saved", () => {
    expect(formatBrainStamp(undefined)).toMatch(/built-in default/i);
  });

  it("stamps a real save with its time", () => {
    expect(formatBrainStamp("2026-08-20T12:00:00.000Z")).toMatch(/^saved /);
  });

  it("does not render Invalid Date when the server sends something unparseable", () => {
    expect(formatBrainStamp("not a date")).toBe("saved");
  });
});

describe("BrainManager", () => {
  it("does not read the brain until the dialog is opened", async () => {
    renderApp(<BrainManager />);
    expect(screen.getByRole("button", { name: "Brain" })).toBeInTheDocument();
    // The shell's own probes are expected; the brain itself is not fetched to render a button.
    expect(mockGet).not.toHaveBeenCalledWith("/brain");
  });

  it("seeds the editor from the server and shows when it was saved", async () => {
    await openDialog();
    await waitFor(() => expect(mockGet).toHaveBeenCalledWith("/brain"));
    expect((screen.getByLabelText("Brain text") as HTMLTextAreaElement).value).toBe(BRAIN.text);
    expect(screen.getByText(/^saved /)).toBeInTheDocument();
  });

  it("keeps Save disabled until the text actually changes", async () => {
    const user = await openDialog();
    const save = () => screen.getByRole("button", { name: /save/i }) as HTMLButtonElement;
    await waitFor(() => expect(save().disabled).toBe(true));

    await user.type(screen.getByLabelText("Brain text"), " More.");
    expect(save().disabled).toBe(false);
  });

  it("saves the edited text and reports what restarted now and what will restart later", async () => {
    mockPost.mockResolvedValue({ ...BRAIN, text: "new", applied: true, restarted: 2, pending: 1 });
    const user = await openDialog();

    const textarea = screen.getByLabelText("Brain text");
    await waitFor(() => expect((textarea as HTMLTextAreaElement).value).toBe(BRAIN.text));
    await user.clear(textarea);
    await user.type(textarea, "new");
    await user.click(screen.getByRole("button", { name: /save/i }));

    await waitFor(() => expect(mockPost).toHaveBeenCalledWith("/brain", { text: "new" }));
    // The deferred restart is the part that would otherwise be invisible.
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith(
        "Brain saved — applied to 2 terminals, 1 will update when it finishes.",
      ),
    );
  });

  it("points at the manual re-push when the server saved but could not apply", async () => {
    mockPost.mockResolvedValue({ ...BRAIN, applied: false, restarted: 0, pending: 0 });
    const user = await openDialog();
    const textarea = screen.getByLabelText("Brain text");
    await waitFor(() => expect((textarea as HTMLTextAreaElement).value).toBe(BRAIN.text));
    await user.type(textarea, "x");
    await user.click(screen.getByRole("button", { name: /save/i }));
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith(expect.stringMatching(/Apply everywhere/)),
    );
  });

  it("resets to the built-in default through the server, not by clearing the box", async () => {
    mockDel.mockResolvedValue({ ...BRAIN, text: BRAIN.defaultText, applied: true, restarted: 1, pending: 0 });
    const user = await openDialog();
    await waitFor(() => expect(mockGet).toHaveBeenCalled());

    await user.click(screen.getByRole("button", { name: /reset to default/i }));
    await waitFor(() => expect(mockDel).toHaveBeenCalledWith("/brain"));
    await waitFor(() =>
      expect((screen.getByLabelText("Brain text") as HTMLTextAreaElement).value).toBe(BRAIN.defaultText),
    );
  });

  it("disables Reset once the text already is the default", async () => {
    mockGet.mockResolvedValue({ ...BRAIN, text: BRAIN.defaultText });
    await openDialog();
    await waitFor(() =>
      expect((screen.getByRole("button", { name: /reset to default/i }) as HTMLButtonElement).disabled).toBe(
        true,
      ),
    );
  });

  it("applies to every runner and restarts the idle terminals when the switch is on", async () => {
    mockPost.mockImplementation((url: string) =>
      url === "/brain/apply"
        ? Promise.resolve({ ok: true, runners: 3 })
        : Promise.resolve({ restarted: 2, skipped: 1 }),
    );
    const user = await openDialog();

    await user.click(screen.getByRole("button", { name: /apply everywhere/i }));
    await waitFor(() => expect(mockPost).toHaveBeenCalledWith("/brain/apply"));
    // The switch defaults to on: a brain nobody re-reads is a brain that changed nothing.
    await waitFor(() => expect(mockPost).toHaveBeenCalledWith("/cards/restart-all"));
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith(
        "Applied to 3 profile(s). 2 terminal(s) restarted, 1 left working.",
      ),
    );
  });

  it("leaves running terminals alone when the restart switch is off", async () => {
    mockPost.mockResolvedValue({ ok: true, runners: 1 });
    const user = await openDialog();

    await user.click(screen.getByRole("switch", { name: "Restart idle terminals" }));
    await user.click(screen.getByRole("button", { name: /apply everywhere/i }));

    await waitFor(() => expect(mockPost).toHaveBeenCalledWith("/brain/apply"));
    expect(mockPost).not.toHaveBeenCalledWith("/cards/restart-all");
  });

  it("surfaces a server error as a toast instead of a broken dialog", async () => {
    mockPost.mockRejectedValue(
      Object.assign(new Error("boom"), { response: { status: 400, data: { error: "brain is too long" } } }),
    );
    const user = await openDialog();
    await user.click(screen.getByRole("button", { name: /apply everywhere/i }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(expect.stringMatching(/brain is too long/)),
    );
  });

  it("re-seeds from the server on reopen, dropping an abandoned draft", async () => {
    const user = await openDialog();
    const textarea = screen.getByLabelText("Brain text");
    await waitFor(() => expect((textarea as HTMLTextAreaElement).value).toBe(BRAIN.text));
    await user.type(textarea, " scribble");

    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByLabelText("Brain text")).not.toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Brain" }));
    const reopened = await screen.findByLabelText("Brain text");
    await waitFor(() => expect((reopened as HTMLTextAreaElement).value).toBe(BRAIN.text));
  });
});
