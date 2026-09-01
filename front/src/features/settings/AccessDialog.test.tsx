import { describe, it, expect, vi, beforeEach } from "vitest";
import { configure, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderApp, setupState } from "@/test/render";
import { AccessDialog } from "./AccessDialog";

// This dialog waits on TWO queries before it draws a row (the session and the user list), and the
// suite shares a loaded machine with the back-end's. The assertions are the point, not the clock.
vi.setConfig({ testTimeout: 30_000 });
configure({ asyncUtilTimeout: 8_000 });

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

const OWNER = { id: "u1", username: "sam", role: "owner", createdAt: "2026-01-01T00:00:00.000Z" };
const MEMBER = { id: "u2", username: "alex", role: "member", createdAt: "2026-02-01T00:00:00.000Z" };

/** Signs the dialog in as `me`, with `users` behind GET /users. */
function serve(me: typeof OWNER | typeof MEMBER, users = [OWNER, MEMBER]) {
  get.mockImplementation(async (url: string) => {
    if (url === "/auth/me") return { user: me };
    if (url === "/setup/state") return setupState();
    if (url === "/users") return { users };
    throw new Error(`unexpected ${url}`);
  });
}

beforeEach(() => vi.clearAllMocks());

describe("AccessDialog as the owner", () => {
  it("lists the people and creates an account", async () => {
    serve(OWNER);
    post.mockResolvedValue({ user: MEMBER });
    renderApp(<AccessDialog open onOpenChange={() => {}} />);

    expect(await screen.findByText("alex")).toBeInTheDocument();

    await userEvent.type(screen.getByLabelText("Username"), "kim");
    await userEvent.type(screen.getByLabelText("Password"), "supersecret");
    await userEvent.click(screen.getByRole("button", { name: /Create account/ }));

    await waitFor(() => expect(post).toHaveBeenCalledWith("/users", {
      username: "kim", password: "supersecret", role: "member",
    }));
  });

  it("refuses to submit a password shorter than the server would accept", async () => {
    serve(OWNER);
    renderApp(<AccessDialog open onOpenChange={() => {}} />);
    await screen.findByText("alex");
    await userEvent.type(screen.getByLabelText("Username"), "kim");
    await userEvent.type(screen.getByLabelText("Password"), "short");
    expect(screen.getByRole("button", { name: /Create account/ })).toBeDisabled();
  });

  it("changes a role through the select", async () => {
    serve(OWNER);
    patch.mockResolvedValue({ user: { ...MEMBER, role: "owner" } });
    renderApp(<AccessDialog open onOpenChange={() => {}} />);
    await screen.findByText("alex");

    // Each row's select names WHOSE role it is, so the test (and a screen reader) can tell the
    // rows apart from each other and from the create form's.
    await userEvent.selectOptions(screen.getByLabelText("Role of alex"), "owner");
    await waitFor(() => expect(patch).toHaveBeenCalledWith("/users/u2", { role: "owner" }));
  });

  it("asks before removing somebody", async () => {
    serve(OWNER);
    del.mockResolvedValue({ ok: true });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    renderApp(<AccessDialog open onOpenChange={() => {}} />);
    await screen.findByText("alex");

    await userEvent.click(screen.getByRole("button", { name: "Remove alex" }));
    expect(confirm).toHaveBeenCalled();
    await waitFor(() => expect(del).toHaveBeenCalledWith("/users/u2"));
    confirm.mockRestore();
  });
});

describe("AccessDialog as a member", () => {
  it("shows only their own password — no list, no create form", async () => {
    serve(MEMBER);
    renderApp(<AccessDialog open onOpenChange={() => {}} />);

    expect(await screen.findByText("Your password")).toBeInTheDocument();
    expect(screen.queryByTestId("access-users")).toBeNull();
    expect(screen.queryByLabelText("Username")).toBeNull();
    // It never even asks the server for the list it is not allowed to see.
    expect(get).not.toHaveBeenCalledWith("/users");
  });

  it("changes their own password", async () => {
    serve(MEMBER);
    post.mockResolvedValue({ ok: true });
    renderApp(<AccessDialog open onOpenChange={() => {}} />);

    await userEvent.type(await screen.findByLabelText("New password"), "anothersecret");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(post).toHaveBeenCalledWith("/auth/password", { password: "anothersecret" }));
  });
});
