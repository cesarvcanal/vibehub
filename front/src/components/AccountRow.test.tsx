import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AccountRow } from "@/components/AccountRow";
import { renderApp, setupState } from "@/test/render";
import { get } from "@/lib/api";

vi.mock("@/lib/api", () => ({
  api: { interceptors: { response: { use: vi.fn() } } },
  setUnauthorizedHandler: vi.fn(),
  get: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
  del: vi.fn(),
}));

const mockGet = vi.mocked(get);

function serveAs(role: "owner" | "member") {
  mockGet.mockImplementation((url: string) => {
    if (url === "/auth/me") return Promise.resolve({ user: { id: "u1", username: "cesar", role } });
    if (url === "/setup/state") return Promise.resolve(setupState());
    return Promise.resolve({});
  });
}

/**
 * The footer's two doors: the GEAR (theme + the install's management, for the owner) and the USER
 * (your own account, sign out). The old cycling theme button read as a status; the old user menu
 * mixed "who am I" with "how the install works".
 */
describe("AccountRow — the gear", () => {
  beforeEach(() => vi.clearAllMocks());

  it("offers the three themes plus Settings and Access to the owner", async () => {
    serveAs("owner");
    renderApp(<AccountRow />);
    await userEvent.click(screen.getByRole("button", { name: "Preferences" }));
    const menu = await screen.findByRole("menu");
    expect(within(menu).getByText("Light")).toBeInTheDocument();
    expect(within(menu).getByText("Dark")).toBeInTheDocument();
    expect(within(menu).getByText("System")).toBeInTheDocument();
    expect(within(menu).getByText("Settings")).toBeInTheDocument();
    expect(within(menu).getByText("Access")).toBeInTheDocument();
  });

  it("ends at the theme for a member — Settings and Access are the install's", async () => {
    serveAs("member");
    renderApp(<AccountRow />);
    await userEvent.click(screen.getByRole("button", { name: "Preferences" }));
    const menu = await screen.findByRole("menu");
    expect(within(menu).getByText("Dark")).toBeInTheDocument();
    expect(within(menu).queryByText("Settings")).not.toBeInTheDocument();
    expect(within(menu).queryByText("Access")).not.toBeInTheDocument();
  });

  it("applies a chosen theme to the document", async () => {
    serveAs("owner");
    renderApp(<AccountRow />);
    await userEvent.click(screen.getByRole("button", { name: "Preferences" }));
    await userEvent.click(await screen.findByText("Light"));
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    // Leave the suite the way it was found.
    document.documentElement.removeAttribute("data-theme");
    localStorage.removeItem("vibehub.theme");
  });
});

describe("AccountRow — the user", () => {
  beforeEach(() => vi.clearAllMocks());

  it("offers exactly Edit user and Sign out", async () => {
    serveAs("member");
    renderApp(<AccountRow />);
    await userEvent.click(await screen.findByRole("button", { name: /cesar/ }));
    const menu = await screen.findByRole("menu");
    const items = within(menu).getAllByRole("menuitem");
    expect(items.map((i) => i.textContent)).toEqual(["Edit user", "Sign out"]);
  });

  it("Edit user opens the own-password form, for a member too", async () => {
    serveAs("member");
    renderApp(<AccountRow />);
    await userEvent.click(await screen.findByRole("button", { name: /cesar/ }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Edit user" }));
    expect(await screen.findByLabelText("New password")).toBeInTheDocument();
  });
});
