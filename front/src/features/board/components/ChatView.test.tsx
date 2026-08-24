import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { act } from "react";
import { ChatView } from "@/features/board/components/ChatView";
import { renderApp } from "@/test/render";
import { post } from "@/lib/api";
import type { ChatEvent } from "@/features/board/lib/chat";

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

const mockPost = vi.mocked(post);

/* -------------------------------------------------------- websocket stub */

class FakeSocket {
  static instances: FakeSocket[] = [];
  static OPEN = 1;

  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;

  constructor(public url: string) {
    FakeSocket.instances.push(this);
  }
  send(): void {}
  close(): void {
    this.readyState = 3;
  }

  accept(): void {
    this.readyState = 1;
    act(() => this.onopen?.());
  }
  /** Delivers one transcript event, the way the server frames them. */
  deliver(event: ChatEvent): void {
    act(() => this.onmessage?.({ data: JSON.stringify(event) } as MessageEvent));
  }
  raw(data: string): void {
    act(() => this.onmessage?.({ data } as MessageEvent));
  }
}

const originalWebSocket = globalThis.WebSocket;

beforeEach(() => {
  vi.clearAllMocks();
  mockPost.mockResolvedValue({ ok: true });
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

function renderChat(props: Partial<React.ComponentProps<typeof ChatView>> = {}) {
  return renderApp(<ChatView cardId="c1" working={false} {...props} />);
}

describe("ChatView", () => {
  it("opens the chat socket for the card and reports its state", async () => {
    const onStatus = vi.fn();
    renderChat({ onStatus });
    const ws = await socket();
    expect(ws.url).toContain("/api/cards/c1/chat");
    ws.accept();
    expect(onStatus).toHaveBeenCalledWith("open");
  });

  it("renders the conversation: what was asked, what was answered, and the tools as one line each", async () => {
    renderChat();
    const ws = await socket();
    ws.accept();
    ws.deliver({ id: "u1", kind: "user", at: 1, text: "roda os testes" });
    ws.deliver({ id: "t1", kind: "tool", at: 2, tool: "Bash", text: "Run tests" });
    ws.deliver({ id: "a1", kind: "assistant", at: 3, text: "Tudo **verde**." });

    expect(await screen.findByText("roda os testes")).toBeInTheDocument();
    expect(screen.getByTestId("chat-tool")).toHaveTextContent("Bash");
    expect(screen.getByTestId("chat-tool")).toHaveTextContent("Run tests");
    // Bold is rendered as bold, not as asterisks.
    expect(screen.getByTestId("chat-assistant")).toHaveTextContent("Tudo verde.");
    expect(screen.getByText("verde").tagName).toBe("STRONG");
  });

  it("ignores the heartbeat that keeps the follower alive", async () => {
    renderChat();
    const ws = await socket();
    ws.accept();
    ws.raw("\n");
    expect(screen.getByText(/no messages yet/i)).toBeInTheDocument();
  });

  it("does not duplicate history when the stream replays it (a reconnect)", async () => {
    renderChat();
    const ws = await socket();
    ws.accept();
    ws.deliver({ id: "a1", kind: "assistant", at: 3, text: "uma resposta" });
    ws.deliver({ id: "a1", kind: "assistant", at: 3, text: "uma resposta" });
    expect(await screen.findAllByTestId("chat-assistant")).toHaveLength(1);
  });

  it("sends a message to the SAME session and shows it before the transcript echoes it back", async () => {
    const user = userEvent.setup({ delay: null });
    renderChat();
    const ws = await socket();
    ws.accept();

    await user.type(screen.getByRole("textbox"), "arruma o total{Enter}");

    expect(mockPost).toHaveBeenCalledWith("/cards/c1/chat", { text: "arruma o total" });
    // The optimistic bubble is on screen while the agent has not written the line yet...
    expect(await screen.findByText("arruma o total")).toBeInTheDocument();

    // ...and it does not become a SECOND bubble when the transcript catches up.
    ws.deliver({ id: "u1", kind: "user", at: 9, text: "arruma o total" });
    await waitFor(() => expect(screen.getAllByTestId("chat-user")).toHaveLength(1));
  }, 20_000);

  it("offers Stop only while the agent is working, and Stop presses Escape in the session", async () => {
    const user = userEvent.setup({ delay: null });
    const { rerender } = renderChat({ working: false });
    expect(screen.queryByRole("button", { name: /stop/i })).not.toBeInTheDocument();

    rerender(<ChatView cardId="c1" working />);
    expect(screen.getByTestId("chat-working")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /stop/i }));
    expect(mockPost).toHaveBeenCalledWith("/cards/c1/chat/key", { key: "escape" });
  });

  it("points at the terminal when the agent has been quiet mid-turn — that is where a prompt lives", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const onOpenTerminal = vi.fn();
      renderChat({ working: true, onOpenTerminal });
      (await socket()).accept();
      expect(screen.queryByText(/nothing new for a while/i)).not.toBeInTheDocument();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(70_000);
      });
      expect(screen.getByText(/nothing new for a while/i)).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });
});
