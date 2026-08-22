import * as React from "react";
import { Terminal, type IBufferLine, type ILink, type ITerminalOptions } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { cn } from "@/lib/utils";
import { wsUrl } from "@/lib/ws";
import { fitDimensions, resizeFrame } from "@/features/board/lib/focusMode";
import { reconnectDelay, type ConnectionState } from "@/features/board/lib/reconnect";
import { continuesLine, findUrls, offsetsToRange } from "@/features/board/lib/links";
import { LocalEcho } from "@/features/board/lib/localEcho";
import {
  applyZoom, readTerminalFontSize, shiftEnterSequence, writeTerminalFontSize, writeClipboard,
  zoomActionFromKey, TERMINAL_FONT_DEFAULT, TERMINAL_FONT_MIN, TERMINAL_FONT_MAX, type ZoomAction,
} from "@/features/board/lib/terminalZoom";
import { Minus, Plus } from "lucide-react";

/**
 * A live terminal: an xterm bound to a vibehub websocket.
 *
 * ## The things that are easy to get wrong
 *
 * 1. **The FitAddon must measure a CLEAN element.** It divides the host element's box by the cell
 *    size, and it does not subtract padding or a border — so a padded holder reports one row more
 *    than fits and the agent's last line disappears under the edge. The styled, padded frame is the
 *    OUTER div; the element xterm is opened on has no padding, no border, no margin, and nothing
 *    else in it.
 * 2. **Connect only once the fit is REAL.** The pty is created at the size in the connect URL, so
 *    connecting before the layout has settled hands the agent a terminal of the wrong shape and its
 *    first repaint is drawn to a stale width. Two animation frames plus a 90 ms backstop, then the
 *    socket.
 * 3. **Links must be found on the LOGICAL line.** See `lib/links.ts`: BOTH kinds of continuation
 *    row are glued on — xterm's soft wrap and the hard wrap an ink TUI emits at the margin — so
 *    Claude's three-row sign-in URL is one link and two unrelated lines never merge into a bogus
 *    one.
 * 4. **Truecolor.** xterm's default `minimumContrastRatio` re-tints colours to keep them legible,
 *    which quietly destroys the 24-bit palette an agent's output depends on (diffs, syntax
 *    highlighting, spinners). It is turned off here and a full ANSI palette is supplied, so what
 *    the runner emits is what you see.
 */

/** What a parent can ask the terminal to do without reaching into xterm. */
/** Must match the face index.css loads from Google Fonts — see the fontFamily note below. */
export const TERMINAL_FONT_FAMILY = '"JetBrains Mono", ui-monospace, "SF Mono", Menlo, Consolas, monospace';

export interface XTerminalHandle {
  /** Types text into the session as if it came from the keyboard (a composer, a transcription). */
  sendText(text: string): void;
  focus(): void;
  zoom(action: ZoomAction): void;
}

export interface XTerminalProps {
  /** Websocket path, e.g. `/api/cards/<id>/terminal`. */
  wsPath: string;
  /** Show the "− 13 +" zoom control in the top-right corner of the frame. */
  zoomControl?: boolean;
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
  /** Optimistic local echo. On by default — see `lib/localEcho.ts` for what it will and will not do. */
  localEcho?: boolean;
  className?: string;
  ariaLabel?: string;
}

/**
 * xterm's own palette — the sixteen Tango slots it ships with — over the app's dark surface.
 *
 * Naming all sixteen rather than leaving them implicit is half of "truecolor": the other half is
 * `minimumContrastRatio: 1` below. Keeping them at xterm's defaults (instead of a bespoke set) is
 * deliberate: an agent's output is full of colour that other people chose — diffs, spinners, syntax
 * highlighting — and it is calibrated against exactly these values.
 */
const THEME: ITerminalOptions["theme"] = {
  background: "#0b0f14",
  foreground: "#ffffff",
  cursor: "#ffffff",
  cursorAccent: "#0b0f14",
  selectionBackground: "rgba(255, 255, 255, 0.3)",
  black: "#2e3436",
  red: "#cc0000",
  green: "#4e9a06",
  yellow: "#c4a000",
  blue: "#3465a4",
  magenta: "#75507b",
  cyan: "#06989a",
  white: "#d3d7cf",
  brightBlack: "#555753",
  brightRed: "#ef2929",
  brightGreen: "#8ae234",
  brightYellow: "#fce94f",
  brightBlue: "#729fcf",
  brightMagenta: "#ad7fa8",
  brightCyan: "#34e2e2",
  brightWhite: "#eeeeec",
};

/** How long to wait for a real layout before giving up and connecting anyway. */
const FIT_BACKSTOP_MS = 90;

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
 * the ones that continue it, using `continuesLine` so a hard wrap counts as well as a soft one.
 * Reads xterm's buffer directly rather than copying the whole scrollback into an array on hover.
 */
function readLogicalLine(term: Terminal, index: number): { text: string; startRow: number } | null {
  const buffer = term.buffer.active;
  if (index < 0 || index >= buffer.length) return null;
  const cols = term.cols;
  // The continuation test runs on TRIMMED text (it asks whether a row ran out of columns without a
  // trailing space); the join uses the untrimmed row, which is exactly `cols` wide.
  const trimmed = (y: number) => {
    const line = buffer.getLine(y);
    return line ? { text: rowText(line, true), wrapped: line.isWrapped } : null;
  };

  let start = index;
  for (;;) {
    const above = trimmed(start - 1);
    const here = trimmed(start);
    if (!above || !here || !continuesLine(above, here, cols)) break;
    start -= 1;
  }
  let end = start;
  for (;;) {
    const here = trimmed(end);
    const below = trimmed(end + 1);
    if (!here || !below || !continuesLine(here, below, cols)) break;
    end += 1;
  }

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

export const XTerminal = React.forwardRef<XTerminalHandle, XTerminalProps>(function XTerminal(
  {
    wsPath,
    zoomControl = false,
    reconnectKey = "",
    onStatus,
    onUploadImage,
    localEcho = true,
    className,
    ariaLabel = "Terminal",
  },
  ref,
) {
  // The element xterm is opened on. It carries no styling of its own — see note 1 at the top.
  const hostRef = React.useRef<HTMLDivElement | null>(null);
  const termRef = React.useRef<Terminal | null>(null);
  const socketRef = React.useRef<WebSocket | null>(null);
  const fitRef = React.useRef<FitAddon | null>(null);
  // Mirrors term.options.fontSize so the zoom control can render it; the terminal is the truth.
  const [fontSize, setFontSize] = React.useState<number>(() => readTerminalFontSize(TERMINAL_FONT_DEFAULT));

  /** Applies a font size to the live terminal, persists it, and refits — the one zoom path. */
  const applyFontSize = React.useCallback((size: number) => {
    const term = termRef.current;
    if (!term) return;
    term.options.fontSize = size;
    writeTerminalFontSize(size);
    setFontSize(size);
    // The cell box changed, so the pty has to hear about the new geometry.
    try {
      fitRef.current?.fit();
    } catch {
      /* the element may be detached mid-teardown */
    }
  }, []);

  const zoom = React.useCallback(
    (action: ZoomAction) => {
      const current = Number(termRef.current?.options.fontSize ?? TERMINAL_FONT_DEFAULT);
      applyFontSize(applyZoom(current, action));
    },
    [applyFontSize],
  );

  React.useImperativeHandle(
    ref,
    () => ({
      sendText(text: string) {
        const socket = socketRef.current;
        if (socket?.readyState === WebSocket.OPEN) socket.send(text);
      },
      focus() {
        termRef.current?.focus();
      },
      zoom,
    }),
    [zoom],
  );
  const uploadRef = React.useRef<XTerminalProps["onUploadImage"]>(onUploadImage);
  uploadRef.current = onUploadImage;
  const statusRef = React.useRef<XTerminalProps["onStatus"]>(onStatus);
  statusRef.current = onStatus;
  const echoEnabledRef = React.useRef(localEcho);
  echoEnabledRef.current = localEcho;

  React.useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const term = new Terminal({
      allowProposedApi: true,
      convertEol: false,
      cursorBlink: true,
      // A LITERAL family list, never a CSS variable: xterm measures cells with canvas `ctx.font`,
      // which cannot resolve `var(--font-mono)` — the whole string is rejected, the canvas falls
      // back to its default face for measuring, and every glyph is then drawn into a cell sized for
      // a different font: wide letter-spacing, squashed height, and a zoom that changes nothing.
      fontFamily: TERMINAL_FONT_FAMILY,
      // Restored from the last session: how big a terminal should be is about the reader and the
      // screen, not about this card.
      fontSize: readTerminalFontSize(TERMINAL_FONT_DEFAULT),
      // Tight leading: legibility is the FONT SIZE's job (and it is a control), so the line box
      // should not spend a fifth of the pane on air — this is ~20% more lines per screen.
      lineHeight: 1.0,
      scrollback: 10_000,
      // Truecolor: never re-tint what the agent printed. See note 4 at the top.
      minimumContrastRatio: 1,
      theme: THEME,
    });
    termRef.current = term;

    const fit = new FitAddon();
    fitRef.current = fit;
    term.loadAddon(fit);
    term.open(host);

    // The webfont may land after the first measurement; xterm only re-measures when a font option
    // changes, so nudge it (assigning the same family still triggers a re-measure) and refit.
    const onFontsLoaded = (): void => {
      if (termRef.current !== term) return;
      term.options.fontFamily = TERMINAL_FONT_FAMILY;
      try {
        fit.fit();
      } catch {
        /* not measurable yet */
      }
    };
    const fonts = typeof document !== "undefined" ? (document as Document & { fonts?: FontFaceSet }).fonts : undefined;
    if (fonts) {
      void fonts.ready.then(onFontsLoaded).catch(() => undefined);
      fonts.addEventListener?.("loadingdone", onFontsLoaded);
    }

    /* ------------------------------------------------------------- renderer */

    // WebGL. The DOM renderer xterm falls back to visibly drags under the volume of coloured output
    // an agent produces — scrolling stutters and the spinner tears. Not every browser/GPU sustains a
    // WebGL context, and a live one can still be lost (a laptop waking, a driver reset), so both
    // failure modes drop back to the DOM renderer instead of taking the terminal down.
    let webgl: { dispose: () => void } | null = null;
    void (async () => {
      try {
        const { WebglAddon } = await import("@xterm/addon-webgl");
        if (termRef.current !== term) return; // unmounted while the chunk loaded
        const addon = new WebglAddon();
        // Clear the reference BEFORE disposing: dispose() destroys the canvas, the browser fires
        // webglcontextlost back into this very handler, and the effect cleanup disposes too —
        // without this both reach the AddonManager with an addon that is already dead.
        addon.onContextLoss(() => {
          const dying = webgl;
          webgl = null;
          try {
            dying?.dispose();
          } catch {
            /* the browser is already tearing it down */
          }
        });
        term.loadAddon(addon);
        webgl = addon;
      } catch {
        webgl = null; // no WebGL here: the DOM renderer is doing the work, and that is fine
      }
    })();

    /* ------------------------------------------------------------ local echo */

    // Only visual, and only while the server is quiet — see lib/localEcho.ts.
    const echo = new LocalEcho({ term: { write: (s) => term.write(s) }, enabled: echoEnabledRef.current });

    /* ----------------------------------------------------------------- links */

    // Links, on the logical line. Registered directly rather than through the web-links addon,
    // which matches per rendered row (note 3 at the top).
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
            // Cmd/Ctrl+click ONLY. In a terminal a plain click places the cursor and starts a
            // selection; navigating away because a word happened to be a URL is not something you
            // can undo. The click is still a user gesture, so the popup blocker stays out of it.
            activate: (event, text) => {
              if (!event.metaKey && !event.ctrlKey) return;
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

    /* -------------------------------------------------------------- keyboard */

    // One handler, in priority order, running before xterm sees the key:
    //   zoom (Cmd/Ctrl +/−/0) — otherwise the BROWSER zooms and the fit goes with it;
    //   Shift/Alt+Enter — a newline in the prompt instead of a submit;
    //   Cmd+C with a selection — copy without sending ^C to the pty (Ctrl+C still interrupts).
    const onKey = (event: KeyboardEvent): boolean => {
      const action = zoomActionFromKey(event);
      if (action) {
        event.preventDefault();
        zoom(action);
        return false;
      }

      const sequence = shiftEnterSequence(event);
      if (sequence !== null) {
        event.preventDefault();
        // socketRef rather than the closure variable: this handler is installed before the socket
        // exists and outlives every reconnect, so it must read whichever one is live now.
        const live = socketRef.current;
        if (live?.readyState === WebSocket.OPEN) live.send(sequence);
        return false;
      }

      if (
        event.type === "keydown" &&
        event.metaKey &&
        !event.ctrlKey &&
        !event.altKey &&
        (event.key === "c" || event.key === "C") &&
        term.hasSelection?.()
      ) {
        const selected = term.getSelection();
        if (selected) {
          writeClipboard(selected);
          return false;
        }
      }
      return true;
    };
    // Guarded: a stub Terminal (tests, future adapters) may not implement it, and a missing
    // shortcut must never take the whole terminal down with it.
    term.attachCustomKeyEventHandler?.(onKey);

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

    /** Everything the server says is the truth: reconcile the local echo before writing it. */
    const writeFromServer = (text: string): void => {
      echo.serverOutput();
      term.write(text);
    };

    const connect = (): void => {
      if (disposed || socket || typeof WebSocket === "undefined") return;
      setStatus(attempt === 0 ? "connecting" : "reconnecting");
      let next: WebSocket;
      try {
        next = new WebSocket(wsUrl(wsPath));
      } catch {
        scheduleRetry();
        return;
      }
      socket = next;
      socketRef.current = next;
      next.binaryType = "arraybuffer";
      next.onopen = () => {
        attempt = 0;
        setStatus("open");
        // Focus on EVERY open, reconnects included: a session that comes back and does not take the
        // keyboard leaves you typing into nothing without any sign of why.
        term.focus();
        echo.reset();
        sendResize();
      };
      next.onmessage = (event: MessageEvent) => {
        // The bridge sends text, but a proxy may hand it over as binary. Duck-typed rather than
        // `instanceof`, because a buffer that crossed a realm boundary fails that check.
        const data: unknown = event.data;
        if (typeof data === "string") writeFromServer(data);
        else if (ArrayBuffer.isView(data)) writeFromServer(decoder.decode(data as ArrayBufferView));
        else if (data && typeof (data as ArrayBuffer).byteLength === "number") {
          writeFromServer(decoder.decode(new Uint8Array(data as ArrayBuffer)));
        }
      };
      next.onerror = () => {
        /* onclose always follows; retrying is decided there so it happens exactly once */
      };
      next.onclose = () => {
        if (socket === next) socket = null;
        if (socketRef.current === next) socketRef.current = null;
        if (disposed) return;
        scheduleRetry();
      };
    };

    const scheduleRetry = (): void => {
      if (disposed || retry) return;
      setStatus("reconnecting");
      const delay = reconnectDelay(attempt, Math.random);
      attempt += 1;
      retry = setTimeout(() => {
        retry = null;
        connect();
      }, delay);
    };

    const input = term.onData((data) => {
      // Paint first, then send — the prediction is discarded the moment the server disagrees.
      echo.key(data);
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

    /* --------------------------------------------------- open after a real fit */

    // TWO frames, then a backstop. On the first frame the surrounding chrome (the card bar, the
    // footer) may not be laid out yet, so the pane measures short; the second frame sees the final
    // box. The timeout both re-fits and CONNECTS, so cols/rows in the connect URL are the ones the
    // pty should be born with. See note 2 at the top.
    setStatus("connecting");
    let secondFrame = 0;
    const firstFrame = requestAnimationFrame(() => {
      doFit();
      secondFrame = requestAnimationFrame(doFit);
    });
    const backstop = setTimeout(() => {
      doFit();
      connect();
    }, FIT_BACKSTOP_MS);

    return () => {
      disposed = true;
      if (retry) clearTimeout(retry);
      clearTimeout(backstop);
      cancelAnimationFrame(firstFrame);
      cancelAnimationFrame(secondFrame);
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
      // Same guard as onContextLoss above: clear the reference first, and blindfold both disposes —
      // a context-loss re-entry triggered BY the addon's dispose must not take the terminal's with
      // it.
      const dying = webgl;
      webgl = null;
      try {
        dying?.dispose();
      } catch {
        /* already disposed by the context-loss handler */
      }
      try {
        term.dispose();
      } catch {
        /* already disposing */
      }
      fonts?.removeEventListener?.("loadingdone", onFontsLoaded);
      termRef.current = null;
      fitRef.current = null;
      socketRef.current = null;
    };
    // `zoom` is stable (useCallback over refs); listing it keeps the lint honest without re-running.
  }, [wsPath, reconnectKey, zoom]);

  return (
    // OUTER frame: all the padding, border and rounding live here. `group` is what reveals the zoom
    // control on hover.
    <div
      data-testid="terminal-frame"
      className={cn(
        "group relative min-h-0 flex-1 overflow-hidden rounded-md border border-border/60 bg-[#0b0f14] p-2",
        className,
      )}
      onClick={() => termRef.current?.focus()}
    >
      {/* INNER host: nothing but the terminal. Padding here would cost a row — see note 1. */}
      <div ref={hostRef} role="application" aria-label={ariaLabel} className="h-full w-full" />
      {zoomControl ? (
        // Out of the way until you want it: the corner of a terminal is content, and a permanent
        // widget sitting on the agent's output is noise. Hover or tab to it and it appears; the
        // keyboard shortcuts (Cmd/Ctrl +/−/0) do the same thing without showing anything at all.
        <div
          data-testid="terminal-zoom"
          className="pointer-events-none absolute right-1.5 top-1.5 z-10 flex items-center gap-0.5 rounded-md border border-border/60 bg-card/80 p-0.5 text-muted-foreground opacity-0 shadow-sm backdrop-blur-sm transition-opacity duration-150 focus-within:pointer-events-auto focus-within:opacity-100 group-hover:pointer-events-auto group-hover:opacity-100"
          onClick={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            aria-label="Smaller text"
            title="Smaller text (Cmd/Ctrl −)"
            disabled={fontSize <= TERMINAL_FONT_MIN}
            onClick={() => zoom("out")}
            className="flex h-5 w-5 items-center justify-center rounded hover:bg-accent hover:text-foreground disabled:opacity-40"
          >
            <Minus className="h-3 w-3" />
          </button>
          <button
            type="button"
            aria-label="Reset text size"
            title="Reset the text size (Cmd/Ctrl 0)"
            onClick={() => zoom("reset")}
            className="flex h-5 min-w-[1.5rem] items-center justify-center rounded px-1 font-mono text-[10px] tabular-nums hover:bg-accent hover:text-foreground"
          >
            {fontSize}
          </button>
          <button
            type="button"
            aria-label="Larger text"
            title="Larger text (Cmd/Ctrl +)"
            disabled={fontSize >= TERMINAL_FONT_MAX}
            onClick={() => zoom("in")}
            className="flex h-5 w-5 items-center justify-center rounded hover:bg-accent hover:text-foreground disabled:opacity-40"
          >
            <Plus className="h-3 w-3" />
          </button>
        </div>
      ) : null}
    </div>
  );
});

export default XTerminal;
