import * as React from "react";
import { Terminal, type IBufferLine, type ILink, type ITerminalOptions } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { cn } from "@/lib/utils";
import { wsUrl } from "@/lib/ws";
import { fitDimensions, resizeFrame } from "@/features/board/lib/focusMode";
import { reconnectDelay, type ConnectionState } from "@/features/board/lib/reconnect";
import { findUrls, offsetsToRange } from "@/features/board/lib/links";
import {
  applyZoom, readTerminalFontSize, writeTerminalFontSize, writeClipboard, zoomActionFromKey,
  TERMINAL_FONT_DEFAULT,
} from "@/features/board/lib/terminalZoom";

/**
 * A live terminal: an xterm bound to a vibehub websocket.
 *
 * ## The three things that are easy to get wrong
 *
 * 1. **The FitAddon must measure a CLEAN element.** It divides the host element's box by the cell
 *    size, and it does not subtract padding or a border — so a padded holder reports one row more
 *    than fits and the agent's last line disappears under the edge. The styled, padded frame is the
 *    OUTER div; the element xterm is opened on has no padding, no border, no margin, and nothing
 *    else in it.
 * 2. **Links must be found on the LOGICAL line.** See `lib/links.ts`: continuation rows are glued
 *    on, everything else is separated by a real newline, so a wrapped URL is one link and two
 *    unrelated lines never merge into a bogus one.
 * 3. **Truecolor.** xterm's default `minimumContrastRatio` re-tints colours to keep them legible,
 *    which quietly destroys the 24-bit palette an agent's output depends on (diffs, syntax
 *    highlighting, spinners). It is turned off here and a full ANSI palette is supplied, so what
 *    the runner emits is what you see.
 */

export interface XTerminalProps {
  /** Websocket path, e.g. `/api/cards/<id>/terminal`. */
  wsPath: string;
  /**
   * Change this to force a full reconnect (a model or account switch kills the session server-side;
   * the reattach recreates it with the new environment, in the same conversation).
   */
  reconnectKey?: string;
  onStatus?: (state: ConnectionState) => void;
  /**
   * Handles an image dropped or pasted onto the terminal. Resolve with the path INSIDE the runner
   * and it is typed into the prompt; resolve with null and nothing is written.
   */
  onUploadImage?: (file: File) => Promise<string | null>;
  className?: string;
  ariaLabel?: string;
}

/**
 * A palette that matches the app's dark surface. Supplying all sixteen ANSI slots (rather than
 * leaving xterm's defaults) is half of "truecolor": the other half is `minimumContrastRatio: 1`.
 */
const THEME: ITerminalOptions["theme"] = {
  background: "#080a0f",
  foreground: "#dfe3ea",
  cursor: "#22d3ee",
  cursorAccent: "#080a0f",
  selectionBackground: "rgba(34, 211, 238, 0.30)",
  black: "#1a1d24",
  red: "#f2555a",
  green: "#3ddc97",
  yellow: "#f2c14e",
  blue: "#5aa9f7",
  magenta: "#c58af9",
  cyan: "#22d3ee",
  white: "#c9cfd9",
  brightBlack: "#5b6472",
  brightRed: "#ff7b80",
  brightGreen: "#69f0ae",
  brightYellow: "#ffd479",
  brightBlue: "#8cc6ff",
  brightMagenta: "#dcb4ff",
  brightCyan: "#7ceaf7",
  brightWhite: "#f5f7fa",
};

/**
 * Reads one buffer row. Only the LAST row of a line is trimmed: an untrimmed row is exactly `cols`
 * characters wide, which is what lets an offset in the logical line map back to a cell by division.
 */
function rowText(line: IBufferLine | undefined, trimRight: boolean): string {
  if (!line) return "";
  return line.translateToString(trimRight);
}

/**
 * The logical line containing buffer row `index`: up through continuation rows, then down through
 * the ones that continue it. Mirrors `lib/links.ts`, reading xterm's buffer directly rather than
 * copying the whole scrollback into an array on every hover.
 */
function readLogicalLine(term: Terminal, index: number): { text: string; startRow: number } | null {
  const buffer = term.buffer.active;
  if (index < 0 || index >= buffer.length) return null;
  let start = index;
  while (start > 0 && buffer.getLine(start)?.isWrapped) start -= 1;
  let end = start;
  while (end + 1 < buffer.length && buffer.getLine(end + 1)?.isWrapped) end += 1;
  let text = "";
  for (let y = start; y <= end; y += 1) {
    text += rowText(buffer.getLine(y), y === end);
  }
  return { text, startRow: start };
}

/** Pulls image files out of a paste or drop, ignoring everything else. */
function imageFilesFrom(list: FileList | null | undefined, items?: DataTransferItemList | null): File[] {
  const out: File[] = [];
  if (list) {
    for (const file of Array.from(list)) if (file.type.startsWith("image/")) out.push(file);
  }
  if (out.length === 0 && items) {
    for (const item of Array.from(items)) {
      if (item.kind !== "file" || !item.type.startsWith("image/")) continue;
      const file = item.getAsFile();
      if (file) out.push(file);
    }
  }
  return out;
}

export function XTerminal({
  wsPath,
  reconnectKey = "",
  onStatus,
  onUploadImage,
  className,
  ariaLabel = "Terminal",
}: XTerminalProps) {
  // The element xterm is opened on. It carries no styling of its own — see note 1 at the top.
  const hostRef = React.useRef<HTMLDivElement | null>(null);
  const termRef = React.useRef<Terminal | null>(null);
  const uploadRef = React.useRef<XTerminalProps["onUploadImage"]>(onUploadImage);
  uploadRef.current = onUploadImage;
  const statusRef = React.useRef<XTerminalProps["onStatus"]>(onStatus);
  statusRef.current = onStatus;

  React.useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const term = new Terminal({
      allowProposedApi: true,
      convertEol: false,
      cursorBlink: true,
      fontFamily:
        'var(--font-mono), ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Consolas, monospace',
      // Restored from the last session: how big a terminal should be is about the reader and the
      // screen, not about this card.
      fontSize: readTerminalFontSize(TERMINAL_FONT_DEFAULT),
      lineHeight: 1.2,
      scrollback: 10_000,
      // Truecolor: never re-tint what the agent printed. See note 3 at the top.
      minimumContrastRatio: 1,
      theme: THEME,
    });
    termRef.current = term;

    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);

    // Links, on the logical line. Registered directly rather than through the web-links addon,
    // which matches per rendered row (note 2 at the top).
    const linkProvider = term.registerLinkProvider({
      provideLinks(viewportRow, callback) {
        const buffer = term.buffer.active;
        const bufferRow = buffer.viewportY + viewportRow - 1;
        const line = readLogicalLine(term, bufferRow);
        if (!line) return callback(undefined);
        const links: ILink[] = [];
        for (const match of findUrls(line.text)) {
          const range = offsetsToRange(match.start, match.end, term.cols);
          if (!range) continue;
          // Logical-line rows -> viewport rows, which is the coordinate space xterm wants.
          const top = line.startRow - buffer.viewportY;
          links.push({
            text: match.url,
            range: {
              start: { x: range.startX, y: top + range.startY },
              end: { x: range.endX, y: top + range.endY },
            },
            activate: (event, text) => {
              event.preventDefault();
              window.open(text, "_blank", "noopener,noreferrer");
            },
          });
        }
        callback(links.length ? links : undefined);
      },
    });

    /* ------------------------------------------------------ selection = copy */

    const selection = term.onSelectionChange(() => {
      const text = term.getSelection();
      if (!text) return;
      // The Clipboard API only exists in a secure context, and a plain-http LAN install is a normal
      // way to run this — writeClipboard falls back to execCommand before giving up, and says so
      // in the console if both refuse.
      writeClipboard(text);
    });

    /* ------------------------------------------------------------------ zoom */

    // Cmd/Ctrl +/-/0 resizes the terminal font. Handled here, before xterm sees the key, so the
    // browser does not zoom the whole page instead — which would break the fit and the geometry.
    const onZoomKey = (event: KeyboardEvent): boolean => {
      const action = zoomActionFromKey(event);
      if (!action) return true;
      event.preventDefault();
      const size = applyZoom(term.options.fontSize ?? TERMINAL_FONT_DEFAULT, action);
      term.options.fontSize = size;
      writeTerminalFontSize(size);
      // The cell box changed, so the pty has to hear about the new geometry.
      try {
        fit.fit();
      } catch {
        /* the element may be detached mid-teardown */
      }
      return false;
    };
    // Guarded: a stub Terminal (tests, future adapters) may not implement it, and a missing zoom
    // shortcut must never take the whole terminal down with it.
    term.attachCustomKeyEventHandler?.(onZoomKey);

    /* ------------------------------------------------------------- websocket */

    let socket: WebSocket | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;
    let disposed = false;
    const decoder = new TextDecoder();

    const setStatus = (state: ConnectionState): void => statusRef.current?.(state);

    const sendResize = (cols = term.cols, rows = term.rows): void => {
      if (socket?.readyState !== WebSocket.OPEN) return;
      const frame = resizeFrame(cols, rows);
      if (frame) socket.send(JSON.stringify(frame));
    };

    const connect = (): void => {
      if (disposed || typeof WebSocket === "undefined") return;
      setStatus(attempt === 0 ? "connecting" : "reconnecting");
      let next: WebSocket;
      try {
        next = new WebSocket(wsUrl(wsPath));
      } catch {
        scheduleRetry();
        return;
      }
      socket = next;
      next.binaryType = "arraybuffer";
      next.onopen = () => {
        attempt = 0;
        setStatus("open");
        sendResize();
      };
      next.onmessage = (event: MessageEvent) => {
        // The bridge sends text, but a proxy may hand it over as binary. Duck-typed rather than
        // `instanceof`, because a buffer that crossed a realm boundary fails that check.
        const data: unknown = event.data;
        if (typeof data === "string") term.write(data);
        else if (ArrayBuffer.isView(data)) term.write(decoder.decode(data as ArrayBufferView));
        else if (data && typeof (data as ArrayBuffer).byteLength === "number") {
          term.write(decoder.decode(new Uint8Array(data as ArrayBuffer)));
        }
      };
      next.onerror = () => {
        /* onclose always follows; retrying is decided there so it happens exactly once */
      };
      next.onclose = () => {
        if (socket === next) socket = null;
        if (disposed) return;
        scheduleRetry();
      };
    };

    const scheduleRetry = (): void => {
      if (disposed) return;
      setStatus("reconnecting");
      const delay = reconnectDelay(attempt, Math.random);
      attempt += 1;
      retry = setTimeout(connect, delay);
    };

    const input = term.onData((data) => {
      if (socket?.readyState === WebSocket.OPEN) socket.send(data);
    });

    /* ------------------------------------------------------------------ fit */

    // Cell size, learned from the first fit that measured something real. The addon needs a live
    // renderer and throws without one (a pane that is hidden, or mid-teardown); knowing the cell
    // size means a resize is still computed correctly instead of being skipped.
    let cell: { width: number; height: number } | null = null;

    const doFit = (): void => {
      try {
        fit.fit();
        if (term.cols > 0 && term.rows > 0 && host.clientWidth > 0 && host.clientHeight > 0) {
          cell = { width: host.clientWidth / term.cols, height: host.clientHeight / term.rows };
        }
        sendResize();
        return;
      } catch {
        /* the addon could not measure: fall back to the arithmetic below */
      }
      if (!cell) return; // nothing learned yet — the next observation will do it
      const fitted = fitDimensions({ width: host.clientWidth, height: host.clientHeight }, cell);
      if (!fitted) return;
      term.resize(fitted.cols, fitted.rows);
      sendResize(fitted.cols, fitted.rows);
    };

    const observer =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => doFit());
    observer?.observe(host);
    doFit();

    /* --------------------------------------------------- images: paste & drop */

    const takeImages = (files: File[]): boolean => {
      const handler = uploadRef.current;
      if (!handler || files.length === 0) return false;
      void (async () => {
        for (const file of files) {
          const path = await handler(file);
          // Typing the path is the whole point: it is what lets the agent read the image.
          if (path) term.paste(`${path} `);
        }
      })();
      return true;
    };

    const onPaste = (event: ClipboardEvent): void => {
      const images = imageFilesFrom(event.clipboardData?.files, event.clipboardData?.items);
      if (images.length === 0) return; // plain text: let xterm paste it itself
      event.preventDefault();
      event.stopPropagation();
      takeImages(images);
    };
    const onDragOver = (event: DragEvent): void => {
      if (!uploadRef.current) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    };
    const onDrop = (event: DragEvent): void => {
      const images = imageFilesFrom(event.dataTransfer?.files, event.dataTransfer?.items);
      if (images.length === 0) return;
      event.preventDefault();
      takeImages(images);
    };

    host.addEventListener("paste", onPaste, true);
    host.addEventListener("dragover", onDragOver);
    host.addEventListener("drop", onDrop);

    connect();
    term.focus();

    return () => {
      disposed = true;
      if (retry) clearTimeout(retry);
      host.removeEventListener("paste", onPaste, true);
      host.removeEventListener("dragover", onDragOver);
      host.removeEventListener("drop", onDrop);
      observer?.disconnect();
      input.dispose();
      selection.dispose();
      linkProvider?.dispose();
      if (socket) {
        socket.onclose = null;
        socket.onmessage = null;
        socket.onerror = null;
        socket.onopen = null;
        try {
          socket.close();
        } catch {
          /* already gone */
        }
      }
      term.dispose();
      termRef.current = null;
    };
  }, [wsPath, reconnectKey]);

  return (
    // OUTER frame: all the padding, border and rounding live here.
    <div
      data-testid="terminal-frame"
      className={cn(
        "relative min-h-0 flex-1 overflow-hidden rounded-md border border-border bg-[#080a0f] p-2",
        className,
      )}
      onClick={() => termRef.current?.focus()}
    >
      {/* INNER host: nothing but the terminal. Padding here would cost a row — see note 1. */}
      <div ref={hostRef} role="application" aria-label={ariaLabel} className="h-full w-full" />
    </div>
  );
}

export default XTerminal;
