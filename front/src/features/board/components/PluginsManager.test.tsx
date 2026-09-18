import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PluginsManager, filterPlugins, formatInstalls } from "@/features/board/components/PluginsManager";
import { renderApp } from "@/test/render";
import { get, post, del } from "@/lib/api";
import type { PluginEntry } from "@/api/types";

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

const CATALOGUE: PluginEntry[] = [
  { name: "superpowers", description: "Brainstorming, systematic debugging and TDD", installs: 1_126_764, installed: false, enabled: false },
  { name: "code-review", description: "Automated code review for pull requests", installs: 482_222, installed: true, enabled: true },
  { name: "code-simplifier", description: "Simplifies and refines code for clarity", installs: 376_034, installed: false, enabled: false },
];

function serve(plugins: PluginEntry[] = CATALOGUE) {
  mockGet.mockImplementation((url: string) => {
    if (url === "/plugins") return Promise.resolve({ marketplace: "claude-plugins-official", plugins });
    return Promise.resolve({});
  });
}

async function openDialog() {
  const user = userEvent.setup();
  renderApp(<PluginsManager />);
  await user.click(screen.getByRole("button", { name: "Skills" }));
  await screen.findByText("superpowers");
  return user;
}

beforeEach(() => {
  vi.resetAllMocks();
  serve();
});

describe("filterPlugins", () => {
  it("puts what the install uses first, then the most installed", () => {
    expect(filterPlugins(CATALOGUE, "").map((p) => p.name)).toEqual(["code-review", "superpowers", "code-simplifier"]);
  });

  it("searches the description too — you rarely remember the plugin's name", () => {
    expect(filterPlugins(CATALOGUE, "debugging").map((p) => p.name)).toEqual(["superpowers"]);
    expect(filterPlugins(CATALOGUE, "CODE").map((p) => p.name)).toEqual(["code-review", "code-simplifier"]);
    expect(filterPlugins(CATALOGUE, "nothing here")).toEqual([]);
  });

  it("caps the list — the catalogue is hundreds long", () => {
    expect(filterPlugins(CATALOGUE, "", 2)).toHaveLength(2);
  });
});

describe("formatInstalls", () => {
  it("reads at a glance", () => {
    expect(formatInstalls(1_126_764)).toBe("1.1M");
    expect(formatInstalls(482_222)).toBe("482k");
    expect(formatInstalls(37)).toBe("37");
    expect(formatInstalls(undefined)).toBe("");
  });
});

describe("the Skills screen", () => {
  it("reads the catalogue from the runner and says what is already in use", async () => {
    await openDialog();
    const rows = screen.getAllByTestId("plugins-item");
    expect(within(rows[0]!).getByText("code-review")).toBeTruthy();
    expect(rows[0]!.getAttribute("data-enabled")).toBe("true");
    expect(within(rows[0]!).getByTestId("plugins-remove")).toBeTruthy();
    expect(within(rows[1]!).getByTestId("plugins-install")).toBeTruthy();
  });

  it("installs one plugin — everywhere, by name", async () => {
    mockPost.mockResolvedValue({ enabled: ["code-review", "superpowers"], applied: true, restarted: 2, pending: 0 });
    const user = await openDialog();
    const superpowers = screen.getAllByTestId("plugins-item").find((el) => el.textContent?.includes("superpowers"))!;
    await user.click(within(superpowers).getByTestId("plugins-install"));
    await waitFor(() => expect(mockPost).toHaveBeenCalledWith("/plugins/superpowers"));
  });

  it("removing one goes through DELETE, not another install", async () => {
    mockDel.mockResolvedValue({ enabled: [], applied: true, restarted: 1, pending: 0 });
    const user = await openDialog();
    const review = screen.getAllByTestId("plugins-item").find((el) => el.textContent?.includes("code-review"))!;
    await user.click(within(review).getByTestId("plugins-remove"));
    await waitFor(() => expect(mockDel).toHaveBeenCalledWith("/plugins/code-review"));
    expect(mockPost).not.toHaveBeenCalled();
  });

  it("filters as you type", async () => {
    const user = await openDialog();
    await user.type(screen.getByTestId("plugins-search"), "simplif");
    await waitFor(() => expect(screen.getAllByTestId("plugins-item")).toHaveLength(1));
    expect(screen.getByText("code-simplifier")).toBeTruthy();
  });

  it("says when a plugin is wanted but is NOT on the runner — that is what 'apply' fixes", async () => {
    serve([{ name: "superpowers", installs: 10, installed: false, enabled: true }]);
    await openDialog();
    expect(screen.getByTestId("plugins-pending")).toBeTruthy();
  });

  it("a runner that cannot answer says so instead of looking like an empty marketplace", async () => {
    mockGet.mockRejectedValue(new Error("the runner is not running"));
    const user = userEvent.setup();
    renderApp(<PluginsManager />);
    await user.click(screen.getByRole("button", { name: "Skills" }));
    expect(await screen.findByTestId("plugins-error")).toBeTruthy();
  });
});
