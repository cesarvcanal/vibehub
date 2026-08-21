import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import type { ILink, ILinkProvider } from "@xterm/xterm";
import * as React from "react";
import userEvent from "@testing-library/user-event";
import { XTerminal, type XTerminalHandle } from "@/features/board/components/XTerminal";

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
  open(element: HTMLElement): void {
    this.element = element;
  }
  focus(): void {}
  dispose(): void {
    this.disposed = true;
  }
  write(data: string): void {
    this.written.push(data);
  }
  paste(data: string): void {
    this.pasted.push(data);
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
    expect(frame.contains(host as Node)).toBe(true);
  });

  it("turns off the contrast correction that would re-tint the agent's truecolor output", () => {
    render(<XTerminal wsPath="/api/cards/c1/terminal" />);
    expect(term().options.minimumContrastRatio).toBe(1);
    expect(term().options.theme).toMatchObject({ background: expect.any(String), red: expect.any(String) });
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

describe("XTerminal — the websocket", () => {
  it("connects to the path it was given and reports the states", async () => {
    const onStatus = vi.fn();
    render(<XTerminal wsPath="/api/cards/c1/terminal?shell=1" onStatus={onStatus} />);

    const socket = FakeSocket.instances[0]!;
    expect(socket.url).toContain("/api/cards/c1/terminal?shell=1");
    expect(onStatus).toHaveBeenCalledWith("connecting");

    socket.accept();
    expect(onStatus).toHaveBeenCalledWith("open");
  });

  it("sends a resize frame as soon as it is connected", () => {
    render(<XTerminal wsPath="/api/cards/c1/terminal" />);
    const socket = FakeSocket.instances[0]!;
    socket.accept();
    expect(socket.sent).toContain(JSON.stringify({ type: "resize", cols: 100, rows: 30 }));
  });

  it("forwards keystrokes and writes output", () => {
    render(<XTerminal wsPath="/api/cards/c1/terminal" />);
    const socket = FakeSocket.instances[0]!;
    socket.accept();

    term().type("ls\r");
    expect(socket.sent).toContain("ls\r");

    socket.onmessage?.({ data: "hello" } as MessageEvent);
    expect(term().written).toContain("hello");
  });

  it("decodes binary frames as UTF-8", () => {
    render(<XTerminal wsPath="/api/cards/c1/terminal" />);
    const socket = FakeSocket.instances[0]!;
    socket.accept();
    socket.onmessage?.({ data: new TextEncoder().encode("héllo").buffer } as MessageEvent);
    expect(term().written).toContain("héllo");
  });

  it("reconnects by itself after a drop, backing off", async () => {
    vi.useFakeTimers();
    const onStatus = vi.fn();
    render(<XTerminal wsPath="/api/cards/c1/terminal" onStatus={onStatus} />);
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
    FakeSocket.instances[0]!.accept();
    view.unmount();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(FakeSocket.instances).toHaveLength(1);
    expect(term().disposed).toBe(true);
  });

  it("keeps resizing from the measured cell size when the addon cannot measure", () => {
    render(<XTerminal wsPath="/api/cards/c1/terminal" />);
    const socket = FakeSocket.instances[0]!;
    socket.accept();
    const t = term();

    // A real box on the first fit teaches it the cell size...
    Object.defineProperty(t.element!, "clientWidth", { value: 800, configurable: true });
    Object.defineProperty(t.element!, "clientHeight", { value: 600, configurable: true });
    observeResize();

    // ...so when the addon throws, the frame is computed instead of skipped.
    fitSpy.mockImplementation(() => {
      throw new Error("no renderer");
    });
    socket.sent.length = 0;
    Object.defineProperty(t.element!, "clientHeight", { value: 300, configurable: true });
    observeResize();
    expect(socket.sent.at(-1)).toBe(JSON.stringify({ type: "resize", cols: 100, rows: 15 }));
  });

  it("reconnects when the reconnect key changes", async () => {
    const view = render(<XTerminal wsPath="/api/cards/c1/terminal" reconnectKey="a" />);
    FakeSocket.instances[0]!.accept();
    view.rerender(<XTerminal wsPath="/api/cards/c1/terminal" reconnectKey="b" />);
    await waitFor(() => expect(FakeSocket.instances).toHaveLength(2));
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

  it("makes a URL that wrapped across rows ONE link", () => {
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

  it("exposes sendText that writes to the open socket", () => {
    const ref = React.createRef<XTerminalHandle>();
    render(<XTerminal ref={ref} wsPath="/api/cards/c1/terminal" />);
    const socket = FakeSocket.instances[FakeSocket.instances.length - 1];
    socket?.accept();
    ref.current?.sendText("hello\r");
    expect(socket?.sent).toContain("hello\r");
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

  it("does not render the control unless asked", () => {
    render(<XTerminal wsPath="/api/cards/c1/terminal" />);
    expect(screen.queryByTestId("terminal-zoom")).toBeNull();
  });
});
