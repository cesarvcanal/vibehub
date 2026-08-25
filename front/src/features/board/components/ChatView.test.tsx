import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, fireEvent } from "@testing-library/react";
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

  it("copies a message's SOURCE text with its copy button", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    renderChat();
    const ws = await socket();
    ws.accept();
    ws.deliver({ id: "a1", kind: "assistant", at: 1, text: "Tudo **verde**." });
    await screen.findByTestId("chat-assistant");
    // The rendered markdown shows "verde" without the asterisks; the copy carries the SOURCE.
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("Tudo **verde**."));
  });

  it("draws a system notification as a muted event, never as the user's message", async () => {
    renderChat();
    const ws = await socket();
    ws.accept();
    ws.deliver({ id: "s1", kind: "system", at: 1, text: "Vigiar reconexão da Z-API completed" });

    const note = await screen.findByTestId("chat-system");
    expect(note).toHaveTextContent("Vigiar reconexão da Z-API completed");
    // The important part: it is NOT a user bubble (that was the bug).
    expect(screen.queryByTestId("chat-user")).not.toBeInTheDocument();
  });

  it("folds a run of tool calls into one block, and opens it in place", async () => {
    // A turn is mostly tools. Rendered flat, fifteen `Read` lines push the two sentences you came
    // for off the screen.
    const user = userEvent.setup({ delay: null });
    renderChat();
    const ws = await socket();
    ws.accept();
    ws.deliver({ id: "a1", kind: "assistant", at: 1, text: "vou olhar" });
    for (let i = 0; i < 5; i += 1) {
      ws.deliver({ id: `t${i}`, kind: "tool", at: 2 + i, tool: "Bash", text: `step ${i}` });
    }

    const group = await screen.findByTestId("chat-tool-group");
    expect(group).toHaveAttribute("data-count", "5");
    expect(group).toHaveTextContent("5 actions");
    // Folded: the LAST call is the one shown, because it is what the agent is doing now.
    expect(group).toHaveTextContent("step 4");
    expect(screen.queryAllByTestId("chat-tool")).toHaveLength(0);
    // The message it interrupted is still a message, not part of the block.
    expect(screen.getByTestId("chat-assistant")).toHaveTextContent("vou olhar");

    await user.click(screen.getByRole("button", { name: /show these 5 actions/i }));
    expect(screen.getAllByTestId("chat-tool")).toHaveLength(5);

    await user.click(screen.getByRole("button", { name: /fold these 5 actions away/i }));
    expect(screen.queryAllByTestId("chat-tool")).toHaveLength(0);
  });

  it("leaves a short run as plain lines — folding one Read is a click that buys nothing", async () => {
    renderChat();
    const ws = await socket();
    ws.accept();
    ws.deliver({ id: "t1", kind: "tool", at: 1, tool: "Read", text: "api.ts" });
    ws.deliver({ id: "t2", kind: "tool", at: 2, tool: "Read", text: "board.ts" });

    await waitFor(() => expect(screen.getAllByTestId("chat-tool")).toHaveLength(2));
    expect(screen.queryByTestId("chat-tool-group")).not.toBeInTheDocument();
  });

  it("ignores the heartbeat that keeps the follower alive", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      renderChat();
      const ws = await socket();
      ws.accept();
      ws.raw("\n");
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_000);
      });
      expect(screen.getByText(/no messages yet/i)).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("says it is LOADING before it says a card is empty — the stream replays on connect", async () => {
    // "No messages yet" in the first instant of every card is a lie that lasts exactly as long as
    // the thing you are waiting for.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      renderChat();
      expect(screen.getByTestId("chat-loading")).toBeInTheDocument();
      expect(screen.queryByText(/no messages yet/i)).not.toBeInTheDocument();

      const ws = await socket();
      ws.accept();
      ws.deliver({ id: "a1", kind: "assistant", at: 1, text: "aqui está" });

      expect(await screen.findByTestId("chat-assistant")).toHaveTextContent("aqui está");
      expect(screen.queryByTestId("chat-loading")).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does call an empty card empty, once the replay has had its moment", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      renderChat();
      (await socket()).accept();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_000);
      });
      expect(screen.getByText(/no messages yet/i)).toBeInTheDocument();
      expect(screen.queryByTestId("chat-loading")).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
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
