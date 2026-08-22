import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import type { ILink, ILinkProvider } from "@xterm/xterm";
import * as React from "react";
import userEvent from "@testing-library/user-event";
import { XTerminal, SUBMIT_AFTER_PASTE_MS, type XTerminalHandle } from "@/features/board/components/XTerminal";

/* ------------------------------------------------------------ xterm stubs */

interface FakeLine {
  text: string;
  isWrapped: boolean;
}

/** Enough of xterm to drive the parts of XTerminal that carry real rules. */
class FakeTerminal {
  static last: FakeTerminal | null = null;

  options: Record<string, unknown>;
  cols = 100;
  rows = 30;
  element: HTMLElement | null = null;
  written: string[] = [];
  pasted: string[] = [];
  disposed = false;
  focused = 0;
  selection = "";
  linkProvider: ILinkProvider | null = null;
  private dataHandlers: ((data: string) => void)[] = [];
  private selectionHandlers: (() => void)[] = [];
  private lines: FakeLine[] = [];
  viewportY = 0;

  constructor(options: Record<string, unknown>) {
    this.options = options;
    FakeTerminal.last = this;
  }

  loadAddon(): void {}
  resize(cols: number, rows: number): void {
    this.cols = cols;
    this.rows = rows;
  }
  keyHandler: ((e: KeyboardEvent) => boolean) | null = null;
  resizeHandlers: ((size: { cols: number; rows: number }) => void)[] = [];
  onResize(handler: (size: { cols: number; rows: number }) => void) {
    this.resizeHandlers.push(handler);
    return { dispose: () => {} };
  }
  emitResize(cols: number, rows: number): void {
    this.cols = cols;
    this.rows = rows;
    for (const h of this.resizeHandlers) h({ cols, rows });
  }
  open(element: HTMLElement): void {
    this.element = element;
  }
  focus(): void {
    this.focused += 1;
  }
  dispose(): void {
    this.disposed = true;
  }
  write(data: string): void {
    this.written.push(data);
  }
  paste(data: string): void {
    this.pasted.push(data);
  }
  hasSelection(): boolean {
    return this.selection.length > 0;
  }
  getSelection(): string {
    return this.selection;
  }
  onData(handler: (data: string) => void) {
    this.dataHandlers.push(handler);
    return { dispose: () => {} };
  }
  onSelectionChange(handler: () => void) {
    this.selectionHandlers.push(handler);
    return { dispose: () => {} };
  }
  registerLinkProvider(provider: ILinkProvider) {
    this.linkProvider = provider;
    return { dispose: () => {} };
  }
  attachCustomKeyEventHandler(handler: (e: KeyboardEvent) => boolean): void {
    this.keyHandler = handler;
  }

  get buffer() {
    const lines = this.lines;
    const viewportY = this.viewportY;
    return {
      active: {
        length: lines.length,
        viewportY,
        getLine: (index: number) => {
          const line = lines[index];
          if (!line) return undefined;
          return {
            isWrapped: line.isWrapped,
            translateToString: (trim: boolean) => (trim ? line.text.trimEnd() : line.text),
          };
        },
      },
    };
  }

  /* test helpers */
  setLines(lines: FakeLine[]): void {
    this.lines = lines;
  }
  type(data: string): void {
    for (const handler of this.dataHandlers) handler(data);
  }
  select(text: string): void {
    this.selection = text;
    for (const handler of this.selectionHandlers) handler();
  }
}

const fitSpy = vi.fn();

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    constructor(options: Record<string, unknown>) {
      return new FakeTerminal(options) as unknown as object;
    }
  },
}));

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    fit = fitSpy;
  },
}));

// The real addon needs a GPU. All the component owes it is the context-loss dance, which is a
// contract with the browser, not something a jsdom test can observe.
vi.mock("@xterm/addon-webgl", () => ({
  WebglAddon: class {
    onContextLoss(): void {}
    dispose(): void {}
  },
}));

vi.mock("@xterm/xterm/css/xterm.css", () => ({}));

/* -------------------------------------------------------- websocket stub */

class FakeSocket {
  static instances: FakeSocket[] = [];
  static OPEN = 1;

  readyState = 0;
  binaryType = "";
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

  /* test helpers */
  accept(): void {
    this.readyState = 1;
    this.onopen?.();
  }
  drop(): void {
    this.readyState = 3;
    this.onclose?.();
  }
}

const originalWebSocket = globalThis.WebSocket;

/** Lets a test replay the resize observation the component listens to. */
let observations: (() => void)[] = [];

beforeEach(() => {
  FakeSocket.instances = [];
  FakeTerminal.last = null;
  observations = [];
  fitSpy.mockReset();
  vi.stubGlobal("WebSocket", FakeSocket);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: () => void) {
        observations.push(callback);
      }
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    },
  );
});

function observeResize(): void {
  for (const callback of observations) callback();
}

afterEach(() => {
  vi.unstubAllGlobals();
  globalThis.WebSocket = originalWebSocket;
  vi.useRealTimers();
});

function term(): FakeTerminal {
  const instance = FakeTerminal.last;
  if (!instance) throw new Error("no terminal was created");
  return instance;
}

/**
 * The socket, once it exists.
 *
 * The component deliberately waits for a real layout — two animation frames and a 90 ms backstop —
 * before connecting, so the pty is born at the size the pane actually is. Nothing socket-shaped
 * exists synchronously after a render.
 */
async function socket(index = 0): Promise<FakeSocket> {
  await waitFor(() => expect(FakeSocket.instances.length).toBeGreaterThan(index));
  return FakeSocket.instances[index] as FakeSocket;
}

/** The same wait, under fake timers. */
async function tickToConnect(): Promise<void> {
  await vi.advanceTimersByTimeAsync(120);
}

/* -------------------------------------------------------------- the tests */

describe("XTerminal — mounting", () => {
  it("opens xterm on an element with no padding or border of its own", () => {
    // The FitAddon divides the holder's box by the cell size and does not subtract padding, so a
    // padded holder reports a row that does not fit and the last line is clipped.
    render(<XTerminal wsPath="/api/cards/c1/terminal" />);
    const host = term().element;
    expect(host).not.toBeNull();
    expect(host?.className).toBe("h-full w-full");
    const frame = screen.getByTestId("terminal-frame");
    expect(frame.className).toContain("p-2");
    expect(frame.className).toContain("bg-[#0b0f14]");
    expect(frame.contains(host as Node)).toBe(true);
  });

  it("turns off the contrast correction that would re-tint the agent's truecolor output", () => {
    render(<XTerminal wsPath="/api/cards/c1/terminal" />);
    expect(term().options.minimumContrastRatio).toBe(1);
    // All sixteen ANSI slots are named, at xterm's own values — the colours an agent's output was
    // calibrated against.
    expect(term().options.theme).toMatchObject({
      background: "#0b0f14",
      foreground: "#ffffff",
      cursor: "#ffffff",
      selectionBackground: "rgba(255, 255, 255, 0.3)",
      red: "#cc0000",
      brightGreen: "#8ae234",
      brightWhite: "#eeeeec",
    });
  });

  it("packs the lines tight and keeps a deep scrollback", () => {
    render(<XTerminal wsPath="/api/cards/c1/terminal" />);
    // Legibility is the font size's job; leading is just lines you cannot see.
    expect(term().options.lineHeight).toBe(1);
    expect(term().options.scrollback).toBe(10_000);
  });

  it("labels the terminal for screen readers", () => {
    render(<XTerminal wsPath="/api/cards/c1/terminal" ariaLabel="Terminal for a card" />);
    expect(screen.getByRole("application", { name: "Terminal for a card" })).toBeInTheDocument();
  });
});

describe("XTerminal — zoom", () => {
  beforeEach(() => localStorage.clear());

  it("starts at the size the reader last chose", () => {
    localStorage.setItem("vibehub.terminalFontSize", "17");
    render(<XTerminal wsPath="/api/cards/c1/terminal" />);
    expect(term().options.fontSize).toBe(17);
  });

  it("Cmd/Ctrl + grows the font, persists it, and swallows the key so the page does not zoom", () => {
    render(<XTerminal wsPath="/api/cards/c1/terminal" />);
    const before = Number(term().options.fontSize ?? 13);
    const event = new KeyboardEvent("keydown", { key: "=", metaKey: true, cancelable: true });
    const handled = term().keyHandler?.(event);
    expect(handled).toBe(false);
    expect(event.defaultPrevented).toBe(true);
    expect(term().options.fontSize).toBe(before + 1);
    expect(localStorage.getItem("vibehub.terminalFontSize")).toBe(String(before + 1));
  });

  it("Cmd/Ctrl 0 goes back to the default", () => {
    localStorage.setItem("vibehub.terminalFontSize", "19");
    render(<XTerminal wsPath="/api/cards/c1/terminal" />);
    term().keyHandler?.(new KeyboardEvent("keydown", { key: "0", ctrlKey: true, cancelable: true }));
    expect(term().options.fontSize).toBe(13);
  });

  it("lets every other key through to the terminal", () => {
    render(<XTerminal wsPath="/api/cards/c1/terminal" />);
    const size = term().options.fontSize;
    expect(term().keyHandler?.(new KeyboardEvent("keydown", { key: "c", ctrlKey: true }))).toBe(true);
    expect(term().options.fontSize).toBe(size);
  });
});

describe("XTerminal — Shift+Enter", () => {
  it("sends the meta-enter sequence instead of submitting the prompt", async () => {
    render(<XTerminal wsPath="/api/cards/c1/terminal" />);
    const ws = await socket();
    ws.accept();

    const event = new KeyboardEvent("keydown", { key: "Enter", shiftKey: true, cancelable: true });
    // Swallowed: xterm would otherwise send a bare \r, which the agent reads as "send".
    expect(term().keyHandler?.(event)).toBe(false);
    expect(event.defaultPrevented).toBe(true);
    expect(ws.sent).toContain("\x1b\r");
  });

  it("does the same for Alt/Option+Enter", async () => {
    render(<XTerminal wsPath="/api/cards/c1/terminal" />);
    const ws = await socket();
    ws.accept();
    term().keyHandler?.(new KeyboardEvent("keydown", { key: "Enter", altKey: true, cancelable: true }));
    expect(ws.sent).toContain("\x1b\r");
  });

  it("leaves a bare Enter alone, so the prompt still submits", async () => {
    render(<XTerminal wsPath="/api/cards/c1/terminal" />);
    const ws = await socket();
    ws.accept();
    expect(term().keyHandler?.(new KeyboardEvent("keydown", { key: "Enter", cancelable: true }))).toBe(true);
    expect(ws.sent).not.toContain("\x1b\r");
  });
});

describe("XTerminal — Cmd+C", () => {
  it("copies the selection instead of sending an interrupt", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    render(<XTerminal wsPath="/api/cards/c1/terminal" />);
    term().selection = "some output";

    expect(term().keyHandler?.(new KeyboardEvent("keydown", { key: "c", metaKey: true }))).toBe(false);
    expect(writeText).toHaveBeenCalledWith("some output");
  });

  it("does nothing without a selection, and never touches Ctrl+C", () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    render(<XTerminal wsPath="/api/cards/c1/terminal" />);

    expect(term().keyHandler?.(new KeyboardEvent("keydown", { key: "c", metaKey: true }))).toBe(true);
    term().selection = "text";
    // Ctrl+C is SIGINT and must reach the pty even with something selected.
    expect(term().keyHandler?.(new KeyboardEvent("keydown", { key: "c", ctrlKey: true }))).toBe(true);
    expect(writeText).not.toHaveBeenCalled();
  });
});

describe("XTerminal — the websocket", () => {
  it("connects to the path it was given and reports the states", async () => {
    const onStatus = vi.fn();
    render(<XTerminal wsPath="/api/cards/c1/terminal?shell=1" onStatus={onStatus} />);
    expect(onStatus).toHaveBeenCalledWith("connecting");

    const ws = await socket();
    expect(ws.url).toContain("/api/cards/c1/terminal?shell=1");

    ws.accept();
    expect(onStatus).toHaveBeenCalledWith("open");
  });

  it("waits for a real fit before connecting, so the pty is born the right shape", async () => {
    render(<XTerminal wsPath="/api/cards/c1/terminal" />);
    // Nothing yet: connecting on the first paint would size the pty from a half-laid-out pane.
    expect(FakeSocket.instances).toHaveLength(0);
    await socket();
    expect(fitSpy).toHaveBeenCalled();
  });

  it("takes the keyboard on every open, reconnects included", async () => {
    render(<XTerminal wsPath="/api/cards/c1/terminal" />);
    const ws = await socket();
    const before = term().focused;
    ws.accept();
    expect(term().focused).toBe(before + 1);

    ws.drop();
    const second = await socket(1);
    second.accept();
    expect(term().focused).toBe(before + 2);
  });

  it("sends a resize frame as soon as it is connected", async () => {
    render(<XTerminal wsPath="/api/cards/c1/terminal" />);
    const ws = await socket();
    ws.accept();
    expect(ws.sent).toContain(JSON.stringify({ type: "resize", cols: 100, rows: 30 }));
  });

  it("forwards keystrokes and writes output", async () => {
    render(<XTerminal wsPath="/api/cards/c1/terminal" localEcho={false} />);
    const ws = await socket();
    ws.accept();

    term().type("ls\r");
    expect(ws.sent).toContain("ls\r");

    ws.onmessage?.({ data: "hello" } as MessageEvent);
    expect(term().written).toContain("hello");
  });

  it("decodes binary frames as UTF-8", async () => {
    render(<XTerminal wsPath="/api/cards/c1/terminal" localEcho={false} />);
    const ws = await socket();
    ws.accept();
    ws.onmessage?.({ data: new TextEncoder().encode("héllo").buffer } as MessageEvent);
    expect(term().written).toContain("héllo");
  });

  it("reconnects by itself after a drop, backing off", async () => {
    vi.useFakeTimers();
    const onStatus = vi.fn();
    render(<XTerminal wsPath="/api/cards/c1/terminal" onStatus={onStatus} />);
    await tickToConnect();
    FakeSocket.instances[0]!.accept();

    FakeSocket.instances[0]!.drop();
    expect(onStatus).toHaveBeenCalledWith("reconnecting");
    expect(FakeSocket.instances).toHaveLength(1);

    // The first retry is fast, so a blip is invisible.
    await vi.advanceTimersByTimeAsync(600);
    expect(FakeSocket.instances).toHaveLength(2);

    // The second one waits longer than the first.
    FakeSocket.instances[1]!.drop();
    await vi.advanceTimersByTimeAsync(400);
    expect(FakeSocket.instances).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1_200);
    expect(FakeSocket.instances).toHaveLength(3);
  });

  it("stops trying once it is unmounted", async () => {
    vi.useFakeTimers();
    const view = render(<XTerminal wsPath="/api/cards/c1/terminal" />);
    await tickToConnect();
    FakeSocket.instances[0]!.accept();
    view.unmount();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(FakeSocket.instances).toHaveLength(1);
    expect(term().disposed).toBe(true);
  });

  it("never opens a socket at all if it is unmounted before the fit settles", async () => {
    vi.useFakeTimers();
    const view = render(<XTerminal wsPath="/api/cards/c1/terminal" />);
    view.unmount();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(FakeSocket.instances).toHaveLength(0);
  });

  it("keeps resizing from the measured cell size when the addon cannot measure", async () => {
    render(<XTerminal wsPath="/api/cards/c1/terminal" />);
    const ws = await socket();
    ws.accept();
    const t = term();

    // A real box on the first fit teaches it the cell size...
    Object.defineProperty(t.element!, "clientWidth", { value: 800, configurable: true });
    Object.defineProperty(t.element!, "clientHeight", { value: 600, configurable: true });
    observeResize();

    // ...so when the addon throws, the frame is computed instead of skipped.
    fitSpy.mockImplementation(() => {
      throw new Error("no renderer");
    });
    ws.sent.length = 0;
    Object.defineProperty(t.element!, "clientHeight", { value: 300, configurable: true });
    observeResize();
    expect(ws.sent.at(-1)).toBe(JSON.stringify({ type: "resize", cols: 100, rows: 15 }));
  });

  it("reconnects when the reconnect key changes", async () => {
    const view = render(<XTerminal wsPath="/api/cards/c1/terminal" reconnectKey="a" />);
    (await socket()).accept();
    view.rerender(<XTerminal wsPath="/api/cards/c1/terminal" reconnectKey="b" />);
    await waitFor(() => expect(FakeSocket.instances).toHaveLength(2));
  });
});

describe("XTerminal — local echo", () => {
  it("paints a keystroke while the server is quiet, and unpaints it when the truth arrives", async () => {
    vi.useFakeTimers();
    render(<XTerminal wsPath="/api/cards/c1/terminal" />);
    await tickToConnect();
    const ws = FakeSocket.instances[0]!;
    ws.accept();

    // The prediction only fires once the server has said nothing for a while — which is exactly the
    // state that matters: the agent is working, the TUI is silent, and the round trip is all there
    // is between you and seeing your own typing.
    await vi.advanceTimersByTimeAsync(200);
    term().type("h");
    expect(term().written).toEqual(["h"]);
    expect(ws.sent).toContain("h"); // the key is sent regardless — the paint is only visual

    ws.onmessage?.({ data: "hello" } as MessageEvent);
    expect(term().written).toEqual(["h", "\b\x1b[K", "hello"]);
  });

  it("predicts nothing when it is switched off", async () => {
    vi.useFakeTimers();
    render(<XTerminal wsPath="/api/cards/c1/terminal" localEcho={false} />);
    await tickToConnect();
    FakeSocket.instances[0]!.accept();
    await vi.advanceTimersByTimeAsync(200);

    term().type("h");
    expect(term().written).toEqual([]);
  });
});

describe("XTerminal — links", () => {
  function provide(): ILink[] {
    let links: ILink[] | undefined;
    term().linkProvider?.provideLinks(1, (result) => {
      links = result;
    });
    return links ?? [];
  }

  it("makes a URL that soft-wrapped across rows ONE link", () => {
    render(<XTerminal wsPath="/api/cards/c1/terminal" />);
    const t = term();
    t.cols = 20;
    t.setLines([
      { text: "https://example.com/", isWrapped: false },
      { text: "a/long/path        ", isWrapped: true },
    ]);

    const links = provide();
    expect(links).toHaveLength(1);
    expect(links[0]?.text).toBe("https://example.com/a/long/path");
    expect(links[0]?.range.start).toEqual({ x: 1, y: 1 });
    expect(links[0]?.range.end.y).toBe(2);
  });

  it("makes a HARD-wrapped URL one link too — the ink TUI case, where isWrapped is false", () => {
    render(<XTerminal wsPath="/api/cards/c1/terminal" />);
    const t = term();
    t.cols = 20;
    // Claude Code measures the width itself and emits a real newline at the margin, so there is no
    // wrap flag to read: the evidence is a row full to the last column resumed by a non-space.
    t.setLines([
      { text: "https://claude.ai/oa", isWrapped: false },
      { text: "uth/authorize?code=a", isWrapped: false },
      { text: "bc123", isWrapped: false },
    ]);

    const links = provide();
    expect(links).toHaveLength(1);
    expect(links[0]?.text).toBe("https://claude.ai/oauth/authorize?code=abc123");
    expect(links[0]?.range.end.y).toBe(3);
  });

  it("does not let a URL swallow the line printed after it", () => {
    render(<XTerminal wsPath="/api/cards/c1/terminal" />);
    const t = term();
    t.cols = 40;
    t.setLines([
      { text: "https://example.com/docs", isWrapped: false },
      { text: "rm -rf /tmp/nope", isWrapped: false },
    ]);
    expect(provide().map((l) => l.text)).toEqual(["https://example.com/docs"]);
  });

  it("returns nothing for ordinary output", () => {
    render(<XTerminal wsPath="/api/cards/c1/terminal" />);
    term().setLines([{ text: "42 tests passed", isWrapped: false }]);
    expect(provide()).toEqual([]);
  });

  it("opens only on Cmd/Ctrl+click — a plain click belongs to the terminal", () => {
    const open = vi.fn();
    vi.stubGlobal("open", open);
    render(<XTerminal wsPath="/api/cards/c1/terminal" />);
    term().setLines([{ text: "https://example.com/docs", isWrapped: false }]);
    const link = provide()[0] as ILink;

    const plain = new MouseEvent("click", { cancelable: true });
    link.activate(plain, link.text);
    expect(open).not.toHaveBeenCalled();
    // Not swallowed either: the click still places the cursor and starts a selection.
    expect(plain.defaultPrevented).toBe(false);

    link.activate(new MouseEvent("click", { metaKey: true, cancelable: true }), link.text);
    expect(open).toHaveBeenCalledWith("https://example.com/docs", "_blank", "noopener,noreferrer");

    link.activate(new MouseEvent("click", { ctrlKey: true, cancelable: true }), link.text);
    expect(open).toHaveBeenCalledTimes(2);
  });
});

describe("XTerminal — clipboard and images", () => {
  it("copies whatever gets selected", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });

    render(<XTerminal wsPath="/api/cards/c1/terminal" />);
    term().select("some output");
    expect(writeText).toHaveBeenCalledWith("some output");
  });

  it("ignores an empty selection", () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    render(<XTerminal wsPath="/api/cards/c1/terminal" />);
    term().select("");
    expect(writeText).not.toHaveBeenCalled();
  });

  it("uploads a pasted image and types the runner path into the prompt", async () => {
    const onUploadImage = vi.fn().mockResolvedValue("/work/.uploads/c1/shot.png");
    render(<XTerminal wsPath="/api/cards/c1/terminal" onUploadImage={onUploadImage} />);

    const file = new File(["binary"], "shot.png", { type: "image/png" });
    const event = new Event("paste", { bubbles: true, cancelable: true }) as Event & {
      clipboardData?: unknown;
    };
    Object.defineProperty(event, "clipboardData", { value: { files: [file], items: [] } });
    term().element?.dispatchEvent(event);

    await waitFor(() => expect(onUploadImage).toHaveBeenCalledWith(file));
    await waitFor(() => expect(term().pasted).toContain("/work/.uploads/c1/shot.png "));
    expect(event.defaultPrevented).toBe(true);
  });

  it("lets a plain text paste through to xterm untouched", () => {
    const onUploadImage = vi.fn();
    render(<XTerminal wsPath="/api/cards/c1/terminal" onUploadImage={onUploadImage} />);
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", { value: { files: [], items: [] } });
    term().element?.dispatchEvent(event);
    expect(onUploadImage).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it("uploads an image dropped onto the terminal", async () => {
    const onUploadImage = vi.fn().mockResolvedValue("/work/.uploads/c1/dropped.png");
    render(<XTerminal wsPath="/api/cards/c1/terminal" onUploadImage={onUploadImage} />);

    const file = new File(["binary"], "dropped.png", { type: "image/png" });
    const event = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "dataTransfer", { value: { files: [file], items: [] } });
    term().element?.dispatchEvent(event);

    await waitFor(() => expect(term().pasted).toContain("/work/.uploads/c1/dropped.png "));
  });
});

describe("XTerminal — handle and zoom control", () => {
  beforeEach(() => localStorage.clear());

  it("exposes sendText that writes to the open socket", async () => {
    const ref = React.createRef<XTerminalHandle>();
    render(<XTerminal ref={ref} wsPath="/api/cards/c1/terminal" />);
    const s = await socket();
    s.accept();
    ref.current?.sendText("hello");
    expect(s.sent).toContain("hello");
  });

  it("renders the zoom control on request and it drives the font size", async () => {
    render(<XTerminal wsPath="/api/cards/c1/terminal" zoomControl />);
    const control = screen.getByTestId("terminal-zoom");
    expect(control).toHaveTextContent("13");
    await userEvent.click(screen.getByRole("button", { name: "Larger text" }));
    expect(term().options.fontSize).toBe(14);
    expect(control).toHaveTextContent("14");
    await userEvent.click(screen.getByRole("button", { name: "Reset text size" }));
    expect(term().options.fontSize).toBe(13);
  });

  it("keeps the control out of the way until the terminal is hovered or focused", () => {
    render(<XTerminal wsPath="/api/cards/c1/terminal" zoomControl />);
    // The corner of a terminal is content; a permanent widget there sits on the agent's output.
    const control = screen.getByTestId("terminal-zoom");
    expect(control.className).toContain("opacity-0");
    expect(control.className).toContain("group-hover:opacity-100");
    expect(control.className).toContain("focus-within:opacity-100");
    expect(screen.getByTestId("terminal-frame").className).toContain("group");
  });

  it("does not render the control unless asked", () => {
    render(<XTerminal wsPath="/api/cards/c1/terminal" />);
    expect(screen.queryByTestId("terminal-zoom")).toBeNull();
  });
});

describe("XTerminal — font measurement", () => {
  it("hands xterm a literal font family — a CSS variable would break canvas measurement", () => {
    render(<XTerminal wsPath="/api/cards/c1/terminal" />);
    const family = String(term().options.fontFamily);
    expect(family).not.toContain("var(");
    expect(family).toContain("JetBrains Mono");
  });
});

describe("XTerminal — submit and resize plumbing", () => {
  it("sends a composed message as body first, then Enter on its own — never as one paste", async () => {
    vi.useFakeTimers();
    try {
      const ref = React.createRef<XTerminalHandle>();
      render(<XTerminal ref={ref} wsPath="/api/cards/c1/terminal" />);
      await tickToConnect();
      const s = FakeSocket.instances[0]!;
      s.accept();
      ref.current?.sendText("run the tests\r");
      expect(s.sent).toContain("run the tests");
      expect(s.sent).not.toContain("run the tests\r");
      expect(s.sent).not.toContain("\r");
      vi.advanceTimersByTime(SUBMIT_AFTER_PASTE_MS + 1);
      expect(s.sent[s.sent.length - 1]).toBe("\r");
    } finally {
      vi.useRealTimers();
    }
  });

  it("a bare Enter goes through untouched", async () => {
    const ref = React.createRef<XTerminalHandle>();
    render(<XTerminal ref={ref} wsPath="/api/cards/c1/terminal" />);
    const s = await socket();
    s.accept();
    ref.current?.sendText("\r");
    expect(s.sent).toContain("\r");
  });

  it("tells the pty about every resize, including a zoom refit", async () => {
    render(<XTerminal wsPath="/api/cards/c1/terminal" zoomControl />);
    const s = await socket();
    s.accept();
    const before = s.sent.length;
    term().emitResize(100, 40);
    const frames = s.sent.slice(before).filter((m) => m.startsWith("{"));
    expect(frames.map((f) => JSON.parse(f))).toContainEqual({ type: "resize", cols: 100, rows: 40 });
  });
});
