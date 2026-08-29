import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  PreviewMenu,
  PreviewChip,
  previewUrl,
  parsePortInput,
  previewName,
  previewState,
  sortPreviews,
} from "@/features/board/components/PreviewMenu";
import { renderApp } from "@/test/render";
import { get, post, del } from "@/lib/api";

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
const mockPost = vi.mocked(post);
const mockDel = vi.mocked(del);
let opened: string[] = [];

beforeEach(() => {
  mockGet.mockReset();
  mockPost.mockReset();
  mockDel.mockReset();
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
    const { rerender } = renderApp(<PreviewChip cardId="c1" previews={[]} />);
    expect(screen.queryByTestId("preview-chip")).not.toBeInTheDocument();

    rerender(
      <PreviewChip
        cardId="c1"
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
    renderApp(<PreviewMenu cardId="c1" />);
    expect(mockGet).not.toHaveBeenCalledWith("/preview/ports");

    await user.click(screen.getByRole("button", { name: "Preview" }));
    expect(await screen.findByText(":3000")).toBeInTheDocument();
    expect(screen.getByText(":5173")).toBeInTheDocument();
    expect(screen.getByText("vite")).toBeInTheDocument();
  });

  it("opens a detected port in a new tab at the proxy URL", async () => {
    const user = userEvent.setup();
    renderApp(<PreviewMenu cardId="c1" />);
    await user.click(screen.getByRole("button", { name: "Preview" }));
    await user.click(await screen.findByText(":5173"));
    expect(opened).toEqual(["/preview/5173/"]);
  });

  it("opens a manually typed port on Enter", async () => {
    const user = userEvent.setup();
    renderApp(<PreviewMenu cardId="c1" />);
    await user.click(screen.getByRole("button", { name: "Preview" }));
    const input = await screen.findByLabelText("Port");
    await user.type(input, "8080{Enter}");
    expect(opened).toEqual(["/preview/8080/"]);
  });

  it("refuses to open garbage from the manual field", async () => {
    const user = userEvent.setup();
    renderApp(<PreviewMenu cardId="c1" />);
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
        cardId="c1"
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
    renderApp(<PreviewMenu cardId="c1" />);
    await user.click(screen.getByRole("button", { name: "Preview" }));
    await waitFor(() =>
      expect(screen.getByText("Nothing listening — start a server in the terminal first")).toBeInTheDocument(),
    );
  });

  it("stops a registered preview from its row (kill + chip removal on the server)", async () => {
    mockDel.mockResolvedValue({ stopped: true, port: 5173 });
    const user = userEvent.setup();
    renderApp(
      <PreviewMenu cardId="c1" previews={[{ port: 5173, label: "front", command: "npm run dev", createdAt: 1 }]} />,
    );
    await user.click(screen.getByRole("button", { name: "Preview" }));
    await user.click(await screen.findByRole("button", { name: "Stop preview" }));
    await waitFor(() => expect(mockDel).toHaveBeenCalledWith("/cards/c1/previews/5173"));
    expect(opened).toEqual([]); // stopping never opens a tab
  });
});

describe("previewState (pure)", () => {
  it("up when the scan lists the port, down when it does not, unknown before any scan", () => {
    expect(previewState(5173, [{ port: 5173 }])).toBe("up");
    expect(previewState(5173, [{ port: 3000 }])).toBe("down");
    expect(previewState(5173, [])).toBe("down");
    expect(previewState(5173, undefined)).toBe("unknown");
  });
});

describe("stopped preview → restart dialog", () => {
  const stoppedPreview = { port: 4999, label: "front", command: "npm run dev", createdAt: 1 };

  it("chip shows 'stopped' and the click opens the dialog instead of a dead tab", async () => {
    const user = userEvent.setup();
    renderApp(<PreviewChip cardId="c1" previews={[stoppedPreview]} />);
    const chip = screen.getByTestId("preview-chip");
    // The scan (3000/5173) does not list 4999 → the chip flips to stopped.
    await waitFor(() => expect(chip).toHaveTextContent("Preview: front — stopped"));

    await user.click(chip);
    expect(opened).toEqual([]);
    expect(await screen.findByText('Preview "front" stopped')).toBeInTheDocument();
    expect(screen.getByText("npm run dev")).toBeInTheDocument();
  });

  it("Restart relaunches on the server, THEN opens the tab and closes the dialog", async () => {
    mockPost.mockResolvedValue({ restarted: true, port: 4999, path: "/preview/4999/", url: "http://x/preview/4999/" });
    const user = userEvent.setup();
    renderApp(<PreviewChip cardId="c1" previews={[stoppedPreview]} />);
    await waitFor(() => expect(screen.getByTestId("preview-chip")).toHaveTextContent("stopped"));
    await user.click(screen.getByTestId("preview-chip"));
    await user.click(await screen.findByRole("button", { name: "Restart" }));

    await waitFor(() => expect(mockPost).toHaveBeenCalledWith("/cards/c1/previews/4999/restart"));
    await waitFor(() => expect(opened).toEqual(["/preview/4999/"]));
    await waitFor(() => expect(screen.queryByText('Preview "front" stopped')).not.toBeInTheDocument());
  });

  it("a failed restart keeps the dialog open and shows the server's message", async () => {
    mockPost.mockRejectedValue({ response: { data: { error: "the preview did not start listening on port 4999" } } });
    const user = userEvent.setup();
    renderApp(<PreviewChip cardId="c1" previews={[stoppedPreview]} />);
    await waitFor(() => expect(screen.getByTestId("preview-chip")).toHaveTextContent("stopped"));
    await user.click(screen.getByTestId("preview-chip"));
    await user.click(await screen.findByRole("button", { name: "Restart" }));

    expect(await screen.findByText(/did not start listening/)).toBeInTheDocument();
    expect(opened).toEqual([]);
  });

  it("without a stored command there is no Restart — only the 'ask the agent' guidance", async () => {
    const user = userEvent.setup();
    renderApp(<PreviewChip cardId="c1" previews={[{ port: 4999, label: "old", createdAt: 1 }]} />);
    await waitFor(() => expect(screen.getByTestId("preview-chip")).toHaveTextContent("stopped"));
    await user.click(screen.getByTestId("preview-chip"));

    expect(await screen.findByText(/ask the card's agent/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Restart" })).not.toBeInTheDocument();
    // Stop still works from here: the dead chip can be dismissed.
    expect(screen.getByRole("button", { name: "Stop preview" })).toBeInTheDocument();
  });
});
