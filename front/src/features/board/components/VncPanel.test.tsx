import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { VncPanel } from "@/features/board/components/VncPanel";
import { renderApp } from "@/test/render";

/**
 * The Navegador pane's two live switches:
 *
 *  - "Só assistir" / "Pilotar junto": `viewOnly` on the LIVE RFB connection. Watching is the
 *    default — the user's mouse must never bump the agent's cursor by accident — and flipping it
 *    NEVER reconnects (the agent drives the same Chromium over CDP, a separate channel).
 *  - "Ajustar" / "Tamanho real": `scaleViewport`/`clipViewport`, also live, remembered in
 *    localStorage per browser.
 */

vi.mock("@/lib/api", () => ({
  api: { interceptors: { response: { use: vi.fn() } } },
  setUnauthorizedHandler: vi.fn(),
  get: vi.fn((url: string) =>
    url === "/auth/me"
      ? Promise.resolve({ user: { id: "1", username: "operator", role: "owner" } })
      : Promise.reject(new Error(`unexpected GET ${url}`)),
  ),
  post: vi.fn(() => Promise.resolve({})),
  patch: vi.fn(() => Promise.resolve({})),
  del: vi.fn(() => Promise.resolve({})),
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

beforeEach(() => {
  instances.length = 0;
  window.localStorage.clear();
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

describe("VncPanel — watch/pilot", () => {
  it("connects VIEW-ONLY by default: watching must not interfere with the agent", async () => {
    const rfb = await renderLive();
    expect(rfb.viewOnly).toBe(true);
    expect(screen.getByTestId("vnc-input-toggle")).toHaveTextContent(/watch only/i);
    expect(screen.getByTestId("vnc-input-toggle")).toHaveAttribute("aria-pressed", "false");
  });

  it("toggles to 'Pilotar junto' LIVE — the same connection, input now enabled — and back", async () => {
    const rfb = await renderLive();
    await userEvent.click(screen.getByTestId("vnc-input-toggle"));
    expect(rfb.viewOnly).toBe(false); // flipped on the LIVE client, nobody reconnected
    expect(instances.length).toBe(1);
    expect(screen.getByTestId("vnc-input-toggle")).toHaveTextContent(/co-pilot/i);
    expect(screen.getByTestId("vnc-input-toggle")).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(screen.getByTestId("vnc-input-toggle"));
    expect(rfb.viewOnly).toBe(true);
    expect(instances.length).toBe(1);
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
