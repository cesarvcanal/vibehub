import { describe, it, expect, vi, beforeEach } from "vitest";
import { configure, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderApp, setupState } from "@/test/render";
import { ShareDialog } from "./ShareDialog";

// Two queries stand between opening this dialog and its first row, on a machine shared with the
// rest of the suite.
vi.setConfig({ testTimeout: 30_000 });
configure({ asyncUtilTimeout: 8_000 });

const get = vi.fn();
const post = vi.fn();
const del = vi.fn();
vi.mock("@/lib/api", () => ({
  get: (...a: unknown[]) => get(...a),
  post: (...a: unknown[]) => post(...a),
  del: (...a: unknown[]) => del(...a),
  patch: vi.fn(),
}));

const OWNER = { id: "u1", username: "cesar", role: "owner" };
const MUSSA = { id: "u2", username: "mussa", role: "member" };
const PAMELA = { id: "u3", username: "pamela", role: "member" };

function serve(shares: unknown[] = [], users = [OWNER, MUSSA, PAMELA]) {
  get.mockImplementation(async (url: string) => {
    if (url === "/auth/me") return { user: OWNER };
    if (url === "/setup/state") return setupState();
    if (url === "/users") return { users };
    if (url === "/cards/c1/shares") return { shares };
    throw new Error(`unexpected ${url}`);
  });
}

beforeEach(() => vi.clearAllMocks());

describe("ShareDialog", () => {
  it("lists the members — never the owner, who already sees everything", async () => {
    serve();
    renderApp(<ShareDialog kind="card" targetId="c1" title="conciliação" open onOpenChange={() => {}} />);
    expect(await screen.findByText("mussa")).toBeInTheDocument();
    expect(screen.getByText("pamela")).toBeInTheDocument();
    expect(screen.queryByText("cesar")).toBeNull();
  });

  it("shares at 'can work' — the level that means come and do this with me", async () => {
    serve();
    post.mockResolvedValue({ share: { userId: "u2", username: "mussa", level: "work" } });
    renderApp(<ShareDialog kind="card" targetId="c1" title="conciliação" open onOpenChange={() => {}} />);
    await screen.findByText("mussa");

    await userEvent.selectOptions(screen.getByLabelText("mussa's access"), "work");
    await waitFor(() => expect(post).toHaveBeenCalledWith("/cards/c1/shares", { userId: "u2", level: "work" }));
  });

  it("shows what is already shared, and takes it back", async () => {
    serve([{ kind: "card", targetId: "c1", userId: "u2", username: "mussa", level: "work", createdAt: 1 }]);
    del.mockResolvedValue({ ok: true });
    renderApp(<ShareDialog kind="card" targetId="c1" title="conciliação" open onOpenChange={() => {}} />);

    const select = (await screen.findByLabelText("mussa's access")) as HTMLSelectElement;
    expect(select.value).toBe("work");

    await userEvent.selectOptions(select, "none");
    await waitFor(() => expect(del).toHaveBeenCalledWith("/cards/c1/shares/u2"));
  });

  it("says which step is missing when there is nobody to share with", async () => {
    serve([], [OWNER]);
    renderApp(<ShareDialog kind="card" targetId="c1" title="conciliação" open onOpenChange={() => {}} />);
    expect(await screen.findByText(/Create an account first/)).toBeInTheDocument();
    expect(screen.queryByRole("combobox")).toBeNull();
  });
});
