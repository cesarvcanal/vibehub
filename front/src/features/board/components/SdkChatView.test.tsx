import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { act } from "react";
import { SdkChatView } from "@/features/board/components/SdkChatView";
import { renderApp } from "@/test/render";
import type { SdkEvent } from "@/features/board/lib/sdkChat";

vi.mock("@/lib/api", () => ({
  api: { interceptors: { response: { use: vi.fn() } } },
  setUnauthorizedHandler: vi.fn(),
  get: vi.fn(() => Promise.resolve({ available: false, proofread: false, language: null })),
  post: vi.fn(() => Promise.resolve({ ok: true })),
  patch: vi.fn(),
  del: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), {
    success: vi.fn(),
    error: vi.fn(),
    message: vi.fn(),
    loading: vi.fn(() => "toast-id"),
    dismiss: vi.fn(),
  }),
}));

/* -------------------------------------------------------- websocket stub */

class FakeSocket {
  static instances: FakeSocket[] = [];
  static OPEN = 1;

  readyState = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;

  constructor(public url: string) {
    FakeSocket.instances.push(this);
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.readyState = 3;
  }

  accept(): void {
    this.readyState = 1;
    act(() => this.onopen?.());
  }
  deliver(event: SdkEvent): void {
    act(() => this.onmessage?.({ data: JSON.stringify(event) } as MessageEvent));
  }
}

const originalWebSocket = globalThis.WebSocket;

beforeEach(() => {
  vi.clearAllMocks();
  FakeSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeSocket);
});

afterEach(() => {
  vi.unstubAllGlobals();
  globalThis.WebSocket = originalWebSocket;
});

async function socket(): Promise<FakeSocket> {
  await waitFor(() => expect(FakeSocket.instances.length).toBeGreaterThan(0));
  return FakeSocket.instances[0] as FakeSocket;
}

function renderSdkChat(props: Partial<React.ComponentProps<typeof SdkChatView>> = {}) {
  return renderApp(<SdkChatView cardId="c1" {...props} />);
}

describe("SdkChatView", () => {
  it("opens the SDK socket for the card and reports its state", async () => {
    const onStatus = vi.fn();
    renderSdkChat({ onStatus });
    const ws = await socket();
    expect(ws.url).toContain("/api/cards/c1/sdk");
    ws.accept();
    expect(onStatus).toHaveBeenCalledWith("open");
  });

  it("renders the streamed answer and the tool calls as compact lines", async () => {
    renderSdkChat();
    const ws = await socket();
    ws.accept();
    ws.deliver({ type: "ready" });
    ws.deliver({ type: "assistant_delta", text: "Rodando os " });
    ws.deliver({ type: "assistant_delta", text: "testes…" });
    ws.deliver({ type: "tool_use", id: "t1", name: "Bash", input: { command: "npm test" } });
    ws.deliver({ type: "assistant_text", text: "Tudo **verde**." });
    ws.deliver({ type: "result", isError: false, sessionId: "0d1b3864-4870-4141-8451-79d73de0bd96" });

    expect(screen.getByTestId("sdk-tool")).toHaveTextContent("Bash");
    expect(screen.getByTestId("sdk-tool")).toHaveTextContent("npm test");
    const answers = screen.getAllByTestId("sdk-assistant");
    expect(answers[answers.length - 1]).toHaveTextContent("Tudo verde.");
    expect(screen.getByText("verde").tagName).toBe("STRONG");
    // the footer shows the session (resume key)
    expect(screen.getByTestId("sdk-chat-footer")).toHaveTextContent("0d1b3864");
  });

  it("sends the composed message over the socket and draws it as sent", async () => {
    renderSdkChat();
    const ws = await socket();
    ws.accept();
    ws.deliver({ type: "ready" });

    const box = screen.getByRole("textbox");
    await userEvent.type(box, "roda os testes{Enter}");

    await waitFor(() => expect(ws.sent.length).toBe(1));
    expect(JSON.parse(ws.sent[0]!)).toEqual({ type: "user", text: "roda os testes" });
    expect(screen.getByTestId("sdk-user")).toHaveTextContent("roda os testes");
  });

  it("a URL in a user message is clickable; javascript: never becomes a link", async () => {
    renderSdkChat();
    const ws = await socket();
    ws.accept();
    ws.deliver({ type: "ready" });

    const box = screen.getByRole("textbox");
    await userEvent.type(box, "abre /preview/3100/ ou javascript:alert(1){Enter}");

    const bubble = await screen.findByTestId("sdk-user");
    const anchors = bubble.querySelectorAll("a");
    expect(anchors).toHaveLength(1);
    expect(anchors[0]).toHaveAttribute("href", "/preview/3100/");
    expect(anchors[0]).toHaveAttribute("target", "_blank");
    expect(anchors[0]?.getAttribute("rel")).toContain("noopener");
    expect(bubble).toHaveTextContent("javascript:alert(1)");
  });

  it("a permission request shows Allow/Deny; Allow sends the decision and settles the card", async () => {
    renderSdkChat();
    const ws = await socket();
    ws.accept();
    ws.deliver({ type: "ready" });
    ws.deliver({ type: "permission_request", id: "perm_1", tool: "Bash", input: { command: "rm -rf ." } });

    const card = screen.getByTestId("sdk-permission");
    expect(card).toHaveAttribute("data-outcome", "pending");
    expect(card).toHaveTextContent("rm -rf .");

    await userEvent.click(screen.getByTestId("sdk-permission-allow"));
    await waitFor(() => expect(ws.sent.length).toBe(1));
    expect(JSON.parse(ws.sent[0]!)).toEqual({ type: "permission_decision", id: "perm_1", allow: true });
    expect(screen.getByTestId("sdk-permission")).toHaveAttribute("data-outcome", "allowed");
    // the buttons are gone — no second answer
    expect(screen.queryByTestId("sdk-permission-allow")).toBeNull();
  });

  it("Deny sends allow:false", async () => {
    renderSdkChat();
    const ws = await socket();
    ws.accept();
    ws.deliver({ type: "permission_request", id: "perm_2", tool: "KillShell" });

    await userEvent.click(screen.getByTestId("sdk-permission-deny"));
    expect(JSON.parse(ws.sent[0]!)).toEqual({ type: "permission_decision", id: "perm_2", allow: false });
    expect(screen.getByTestId("sdk-permission")).toHaveAttribute("data-outcome", "denied");
  });

  it("the interrupt button appears while a turn runs and sends the interrupt", async () => {
    renderSdkChat();
    const ws = await socket();
    ws.accept();
    expect(screen.queryByTestId("sdk-interrupt")).toBeNull();
    ws.deliver({ type: "assistant_delta", text: "trabalhando…" });

    await userEvent.click(screen.getByTestId("sdk-interrupt"));
    expect(JSON.parse(ws.sent[0]!)).toEqual({ type: "interrupt" });

    ws.deliver({ type: "result", isError: false });
    expect(screen.queryByTestId("sdk-interrupt")).toBeNull();
  });

  it("draws the server's replay — the conversation survives a remount instead of 'sumindo'", async () => {
    renderSdkChat();
    const ws = await socket();
    ws.accept();
    // What the back replays from the per-card history log (and the TUI transcript) on connect:
    ws.deliver({ type: "user", text: "manda a primeira" });
    ws.deliver({ type: "tool_use", id: "t1", name: "Bash", input: { command: "npm test" } });
    ws.deliver({ type: "assistant_text", text: "Feito." });
    ws.deliver({ type: "ready", resume: "bfe63d25-95df-4c86-bf34-047b1366cc02" });

    expect(screen.getByTestId("sdk-user")).toHaveTextContent("manda a primeira");
    expect(screen.getByTestId("sdk-assistant")).toHaveTextContent("Feito.");
    // a replayed tail never leaves the working spinner on: the fresh driver runs nothing yet
    expect(screen.queryByTestId("sdk-chat-working")).toBeNull();
  });

  it("resets the slate on every open — a reconnect's full replay is drawn once, not twice", async () => {
    renderSdkChat();
    const ws = await socket();
    ws.accept();
    ws.deliver({ type: "user", text: "manda a primeira" });
    ws.deliver({ type: "assistant_text", text: "Feito." });
    expect(screen.getAllByTestId("sdk-user")).toHaveLength(1);

    // the socket re-opens (reconnect): the server replays the WHOLE history again
    ws.accept();
    ws.deliver({ type: "user", text: "manda a primeira" });
    ws.deliver({ type: "assistant_text", text: "Feito." });
    ws.deliver({ type: "ready" });

    expect(screen.getAllByTestId("sdk-user")).toHaveLength(1);
    expect(screen.getAllByTestId("sdk-assistant")).toHaveLength(1);
  });

  it("a driver error is visible — including the flag-off refusal, translated", async () => {
    renderSdkChat();
    const ws = await socket();
    ws.accept();
    ws.deliver({ type: "error", message: "the SDK driver is off (enable the sdkDriver setting)" });
    expect(screen.getByTestId("sdk-error")).toHaveTextContent(/SDK driver is off/i);
  });
});
