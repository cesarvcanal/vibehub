import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { VncPanel } from "@/features/board/components/VncPanel";
import { renderApp } from "@/test/render";
import { post } from "@/lib/api";
import { ChunkLoadFailure } from "@/lib/lazyChunk";
import { reloadHeld, resetReloadHoldsForTesting } from "@/lib/versionCheck";

/**
 * The Navegador pane, where the whole question is WHOSE HANDS ARE ON THE BROWSER:
 *
 *  - you arrive as a SPECTATOR (`viewOnly` on the RFB client). Sharing the wheel with the agent was
 *    tried and it does not work — two pointers in one Chromium click over each other — so input is
 *    off until you ask for it;
 *  - "Assumir controle" / "Devolver ao agente" is server state (the agent side asks the same
 *    question before driving), applied LIVE on the connection: nobody reconnects;
 *  - "Ajustar" / "Tamanho real": `scaleViewport`/`clipViewport`, also live, remembered in
 *    localStorage per browser.
 */

const ME = "operator";

/** The browser-status route, which the pane polls and the control buttons write. */
let status = { live: true, busy: false, control: "agent" as "agent" | "human", controlBy: null as string | null };

vi.mock("@/lib/api", () => ({
  api: { interceptors: { response: { use: vi.fn() } } },
  setUnauthorizedHandler: vi.fn(),
  get: vi.fn((url: string) => {
    if (url === "/auth/me") return Promise.resolve({ user: { id: "1", username: ME, role: "owner" } });
    if (url === "/cards/c1/browser") return Promise.resolve(status);
    return Promise.reject(new Error(`unexpected GET ${url}`));
  }),
  post: vi.fn((url: string) => {
    if (url === "/cards/c1/browser/control") {
      status = { ...status, control: "human", controlBy: ME };
      return Promise.resolve(status);
    }
    return Promise.resolve({});
  }),
  patch: vi.fn(() => Promise.resolve({})),
  del: vi.fn((url: string) => {
    if (url === "/cards/c1/browser/control") {
      status = { ...status, control: "agent", controlBy: null };
      return Promise.resolve(status);
    }
    return Promise.resolve({});
  }),
}));

// The RFB client is a heavy browser-only bundle; what the pane sets ON it is the whole contract.
const { instances, FakeRfb } = vi.hoisted(() => {
  class FakeRfb extends EventTarget {
    viewOnly = false;
    scaleViewport = false;
    clipViewport = false;
    resizeSession = false;
    focusOnClick = false;
    background = "";
    url: string;
    constructor(_target: HTMLElement, url: string) {
      super();
      this.url = url;
      instances.push(this);
    }
    disconnect(): void {
      /* noop */
    }
  }
  const instances: InstanceType<typeof FakeRfb>[] = [];
  return { instances, FakeRfb };
});
vi.mock("@novnc/novnc", () => ({ default: FakeRfb }));

// The chunk loader is real by default (it just calls the import above); a test swaps it to play a
// deploy happening under the pane.
const chunk = vi.hoisted(() => ({ override: null as null | (() => Promise<unknown>) }));
vi.mock("@/lib/lazyChunk", async (orig) => {
  const actual = await orig<typeof import("@/lib/lazyChunk")>();
  return {
    ...actual,
    importChunk: (load: () => Promise<unknown>, deps?: unknown) =>
      chunk.override ? chunk.override() : actual.importChunk(load, deps as never),
  };
});

beforeEach(() => {
  chunk.override = null;
  resetReloadHoldsForTesting();
  instances.length = 0;
  window.localStorage.clear();
  status = { live: true, busy: false, control: "agent", controlBy: null };
});
afterEach(() => {
  vi.clearAllMocks();
});

async function renderLive() {
  renderApp(<VncPanel cardId="c1" onClose={() => undefined} />);
  await waitFor(() => expect(instances.length).toBe(1));
  const rfb = instances[0]!;
  rfb.dispatchEvent(new CustomEvent("connect"));
  return rfb;
}

describe("VncPanel — spectator by default", () => {
  it("connects VIEW-ONLY: you watch, and your mouse never reaches the page the agent is driving", async () => {
    const rfb = await renderLive();
    expect(rfb.viewOnly).toBe(true);
    expect(screen.getByTestId("vnc-control-toggle")).toHaveTextContent(/take control/i);
    expect(screen.getByTestId("vnc-control-toggle")).toHaveAttribute("aria-pressed", "false");
  });

  it("takes and gives back the wheel LIVE — the same connection, input on and off again", async () => {
    const rfb = await renderLive();

    await userEvent.click(screen.getByTestId("vnc-control-toggle"));
    await waitFor(() => expect(rfb.viewOnly).toBe(false));
    expect(instances.length).toBe(1); // flipped on the LIVE client, nobody reconnected
    expect(screen.getByTestId("vnc-control-toggle")).toHaveTextContent(/give it back/i);
    expect(screen.getByTestId("vnc-control-toggle")).toHaveAttribute("aria-pressed", "true");

    await userEvent.click(screen.getByTestId("vnc-control-toggle"));
    await waitFor(() => expect(rfb.viewOnly).toBe(true));
    expect(instances.length).toBe(1);
  });

  it("leaves someone else's hold alone: a name, a disabled button, and still view-only", async () => {
    status = { live: true, busy: false, control: "human", controlBy: "mussa" };
    const rfb = await renderLive();
    await waitFor(() => expect(screen.getByTestId("vnc-control-toggle")).toHaveTextContent(/mussa is driving/i));
    expect(screen.getByTestId("vnc-control-toggle")).toBeDisabled();
    expect(rfb.viewOnly).toBe(true);
  });
});

describe("VncPanel — display mode", () => {
  it("defaults to 'Ajustar' (scale to fit) and flips to real size live, persisting the choice", async () => {
    const rfb = await renderLive();
    expect(rfb.scaleViewport).toBe(true);
    expect(rfb.clipViewport).toBe(false);
    expect(screen.getByTestId("vnc-display-toggle")).toHaveTextContent(/fit/i);

    await userEvent.click(screen.getByTestId("vnc-display-toggle"));
    expect(rfb.scaleViewport).toBe(false); // 1:1 — the Chromium's own resolution
    expect(rfb.clipViewport).toBe(true); // pan inside the pane instead of overflowing the layout
    expect(instances.length).toBe(1); // live property, no reconnect
    expect(screen.getByTestId("vnc-display-toggle")).toHaveTextContent(/real size/i);
    expect(window.localStorage.getItem("vibehub.vnc.display")).toBe("real");
  });

  it("remembers 'Tamanho real' across mounts (localStorage)", async () => {
    window.localStorage.setItem("vibehub.vnc.display", "real");
    const rfb = await renderLive();
    expect(rfb.scaleViewport).toBe(false);
    expect(rfb.clipViewport).toBe(true);
    expect(screen.getByTestId("vnc-display-toggle")).toHaveTextContent(/real size/i);
  });
});

describe("VncPanel — one client per pane", () => {
  // StrictMode (on in main.tsx) mounts, unmounts and mounts again while the first connect is still
  // awaiting the runner. Both attempts used to reach `new RFB(...)` on the same screen: two
  // sockets, and the first one leaked open with nobody holding it.
  it("a connect overtaken by a remount never builds its own RFB client", async () => {
    // The runner answers each start when the test says so, one attempt at a time.
    const starts: (() => void)[] = [];
    const routes = vi.mocked(post).getMockImplementation();
    onTestFinished(() => {
      if (routes) vi.mocked(post).mockImplementation(routes);
    });
    vi.mocked(post).mockImplementation((url: string, body?: unknown) =>
      url === "/cards/c1/browser"
        ? new Promise((resolve) => starts.push(() => resolve({})))
        : (routes?.(url, body) ?? Promise.resolve({})),
    );
    renderApp(
      <StrictMode>
        <VncPanel cardId="c1" onClose={() => undefined} />
      </StrictMode>,
    );
    await waitFor(() => expect(starts).toHaveLength(2)); // mounted, unmounted, mounted again

    // The overtaken attempt lands first and gets every chance to build a client...
    await act(async () => {
      starts[0]!();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(instances).toHaveLength(0);

    // ...and only the current one does.
    await act(async () => starts[1]!());
    await waitFor(() => expect(instances).toHaveLength(1));
  });
});

describe("VncPanel — a deploy under the pane", () => {
  // Production, 2026-10-19: the pane loaded noVNC while the vibehub restarted for a deploy, showed
  // "Failed to fetch dynamically imported module" and its "Try again" could never work (the browser
  // caches the failed import). The loader now recovers by itself; what is left for the pane is to
  // say what happened in words and offer the one thing that still helps.
  it("the new version renamed the chunk: says so and offers a page reload", async () => {
    chunk.override = () => Promise.reject(new ChunkLoadFailure("stale"));
    const reload = vi.fn();
    vi.stubGlobal("location", { ...window.location, reload });
    onTestFinished(() => {
      vi.unstubAllGlobals();
    });
    renderApp(<VncPanel cardId="c1" onClose={() => undefined} />);
    expect(await screen.findByText(/new version/i)).toBeInTheDocument();
    expect(screen.queryByText(/Failed to fetch/i)).not.toBeInTheDocument();
    await userEvent.click(screen.getByTestId("vnc-reload-page"));
    expect(reload).toHaveBeenCalledOnce();
  });

  it("the server did not come back: says it is restarting, and Try again stays", async () => {
    chunk.override = () => Promise.reject(new ChunkLoadFailure("server_down"));
    renderApp(<VncPanel cardId="c1" onClose={() => undefined} />);
    expect(await screen.findByText(/restarting/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /try again/i })).toBeInTheDocument();
    expect(screen.queryByTestId("vnc-reload-page")).not.toBeInTheDocument();

    chunk.override = null; // back up: Try again now connects
    await userEvent.click(screen.getByRole("button", { name: /try again/i }));
    await waitFor(() => expect(instances).toHaveLength(1));
  });
});

describe("VncPanel — the new-version reload never closes a browser someone is driving", () => {
  // The version watcher reloads an idle tab by itself after a deploy. A reload closes this pane and
  // kills the session on screen — in the middle of a login being typed by hand, that is lost work.
  it("holds the automatic reload while you have control, and lets it go when you give it back", async () => {
    await renderLive();
    expect(reloadHeld()).toBe(false); // only watching: a reload costs nothing

    await userEvent.click(screen.getByTestId("vnc-control-toggle"));
    await waitFor(() => expect(reloadHeld()).toBe(true));

    await userEvent.click(screen.getByTestId("vnc-control-toggle"));
    await waitFor(() => expect(reloadHeld()).toBe(false));
  });
});
