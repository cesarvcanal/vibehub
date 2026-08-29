import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  PreviewMenu,
  PreviewChip,
  previewUrl,
  parsePortInput,
  previewName,
  sortPreviews,
} from "@/features/board/components/PreviewMenu";
import { renderApp } from "@/test/render";
import { get } from "@/lib/api";

/**
 * The Preview menu: the scan happens when the menu opens, a detected port opens the proxy URL in a
 * NEW tab, and the manual field covers the port the scan cannot guess. The URL is the contract with
 * the back-end proxy — same origin, `/preview/<port>/`, trailing slash included.
 */

vi.mock("@/lib/api", () => ({
  api: { interceptors: { response: { use: vi.fn() } } },
  setUnauthorizedHandler: vi.fn(),
  get: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
  del: vi.fn(),
}));

const mockGet = vi.mocked(get);
let opened: string[] = [];

beforeEach(() => {
  mockGet.mockReset();
  opened = [];
  vi.spyOn(window, "open").mockImplementation((url) => {
    opened.push(String(url));
    return null;
  });
  mockGet.mockImplementation((url: string) => {
    if (url === "/auth/me") return Promise.resolve({ user: { id: "1", username: "op", role: "owner" } });
    if (url === "/preview/ports") {
      return Promise.resolve({
        ports: [
          { port: 3000, address: "all", process: "node" },
          { port: 5173, address: "loopback", process: "vite" },
        ],
      });
    }
    return Promise.resolve({});
  });
});

describe("previewUrl / parsePortInput", () => {
  it("builds the proxy URL with the trailing slash relative assets depend on", () => {
    expect(previewUrl(5173)).toBe("/preview/5173/");
  });

  it("accepts only a real TCP port", () => {
    expect(parsePortInput("5173")).toBe(5173);
    expect(parsePortInput(" 80 ")).toBe(80);
    for (const raw of ["", "abc", "0", "65536", "12.5", "-1", "5173/x"]) {
      expect(parsePortInput(raw)).toBeNull();
    }
  });
});

describe("previewName / sortPreviews", () => {
  it("names a preview by its label, falling back to the port", () => {
    expect(previewName({ port: 5173, label: "front" })).toBe("front");
    expect(previewName({ port: 5173, label: "  " })).toBe(":5173");
    expect(previewName({ port: 5173 })).toBe(":5173");
  });

  it("sorts newest first without mutating the input; tolerates undefined", () => {
    const list = [
      { port: 3000, createdAt: 1 },
      { port: 5173, createdAt: 2 },
    ];
    expect(sortPreviews(list).map((p) => p.port)).toEqual([5173, 3000]);
    expect(list[0]!.port).toBe(3000);
    expect(sortPreviews(undefined)).toEqual([]);
  });
});

describe("PreviewChip", () => {
  it("renders nothing without previews; shows the LATEST one and opens it in a new tab", async () => {
    const user = userEvent.setup();
    const { rerender } = renderApp(<PreviewChip previews={[]} />);
    expect(screen.queryByTestId("preview-chip")).not.toBeInTheDocument();

    rerender(
      <PreviewChip
        previews={[
          { port: 3000, label: "api", createdAt: 1 },
          { port: 5173, label: "front", createdAt: 2 },
        ]}
      />,
    );
    const chip = screen.getByTestId("preview-chip");
    expect(chip).toHaveTextContent("Preview: front");
    await user.click(chip);
    expect(opened).toEqual(["/preview/5173/"]);
  });
});

describe("PreviewMenu", () => {
  it("scans on open and lists what is listening, with the process name", async () => {
    const user = userEvent.setup();
    renderApp(<PreviewMenu />);
    expect(mockGet).not.toHaveBeenCalledWith("/preview/ports");

    await user.click(screen.getByRole("button", { name: "Preview" }));
    expect(await screen.findByText(":3000")).toBeInTheDocument();
    expect(screen.getByText(":5173")).toBeInTheDocument();
    expect(screen.getByText("vite")).toBeInTheDocument();
  });

  it("opens a detected port in a new tab at the proxy URL", async () => {
    const user = userEvent.setup();
    renderApp(<PreviewMenu />);
    await user.click(screen.getByRole("button", { name: "Preview" }));
    await user.click(await screen.findByText(":5173"));
    expect(opened).toEqual(["/preview/5173/"]);
  });

  it("opens a manually typed port on Enter", async () => {
    const user = userEvent.setup();
    renderApp(<PreviewMenu />);
    await user.click(screen.getByRole("button", { name: "Preview" }));
    const input = await screen.findByLabelText("Port");
    await user.type(input, "8080{Enter}");
    expect(opened).toEqual(["/preview/8080/"]);
  });

  it("refuses to open garbage from the manual field", async () => {
    const user = userEvent.setup();
    renderApp(<PreviewMenu />);
    await user.click(screen.getByRole("button", { name: "Preview" }));
    const input = await screen.findByLabelText("Port");
    await user.type(input, "99999{Enter}");
    expect(opened).toEqual([]);
    expect(screen.getByRole("button", { name: "Open" })).toBeDisabled();
  });

  it("lists registered previews FIRST (label + port) and hides them from the scan section", async () => {
    const user = userEvent.setup();
    renderApp(
      <PreviewMenu
        previews={[
          { port: 5173, label: "front", createdAt: 2 },
          { port: 4000, createdAt: 1 },
        ]}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Preview" }));
    expect(await screen.findByText("Announced by the agent")).toBeInTheDocument();
    expect(screen.getByText("front")).toBeInTheDocument();
    // 5173 is registered, so the scan section keeps only 3000; the registered row shows :5173.
    expect(screen.getByText(":5173")).toBeInTheDocument();
    expect(screen.getByText(":3000")).toBeInTheDocument();
    expect(screen.queryByText("vite")).not.toBeInTheDocument();

    await user.click(screen.getByText("front"));
    expect(opened).toEqual(["/preview/5173/"]);
  });

  it("says so when nothing is listening", async () => {
    mockGet.mockImplementation((url: string) => {
      if (url === "/auth/me") return Promise.resolve({ user: { id: "1", username: "op", role: "owner" } });
      return Promise.resolve(url === "/preview/ports" ? { ports: [] } : {});
    });
    const user = userEvent.setup();
    renderApp(<PreviewMenu />);
    await user.click(screen.getByRole("button", { name: "Preview" }));
    await waitFor(() =>
      expect(screen.getByText("Nothing listening — start a server in the terminal first")).toBeInTheDocument(),
    );
  });
});
