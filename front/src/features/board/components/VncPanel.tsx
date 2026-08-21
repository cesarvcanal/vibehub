import * as React from "react";
import { AlertTriangle, Loader2, MonitorPlay, Plug } from "lucide-react";
import { Button } from "@/components/ui/button";
import { wsUrl } from "@/lib/ws";
import { apiErrorMessage } from "@/lib/apiError";
import { boardApi } from "@/features/board/api";

/**
 * The card's live browser.
 *
 * Chain, end to end:
 *   POST   /api/cards/:id/browser  → Xvfb + x11vnc + a headful Chromium in the runner (idempotent)
 *   WS     /api/cards/:id/vnc      → a raw RFB byte bridge (the server is the websockify)
 *   DELETE /api/cards/:id/browser  → tears it all down and gives the RAM back
 *
 * It is deliberately NOT view-only: the agent drives that same Chromium over CDP, and you can take
 * the keyboard whenever it hits a login or a captcha — without evicting it.
 *
 * noVNC is imported lazily. It is a large browser-only bundle that touches the DOM on import, so it
 * has no business loading for anyone who never opens this panel.
 */

type State = "idle" | "starting" | "connecting" | "live" | "error" | "closed";

const STATE_LABEL: Record<State, { text: string; className: string }> = {
  idle: { text: "off", className: "text-muted-foreground" },
  starting: { text: "starting…", className: "text-amber-400" },
  connecting: { text: "connecting…", className: "text-amber-400" },
  live: { text: "live", className: "text-emerald-400" },
  error: { text: "error", className: "text-red-400" },
  closed: { text: "closed", className: "text-muted-foreground" },
};

export function VncPanel({ cardId, onClose }: { cardId: string; onClose: () => void }) {
  const [state, setState] = React.useState<State>("idle");
  const [error, setError] = React.useState<string | null>(null);
  const screenRef = React.useRef<HTMLDivElement | null>(null);
  const rfbRef = React.useRef<{ disconnect: () => void } | null>(null);

  /** Disconnect the client and stop the browser in the runner. Idempotent. */
  const teardown = React.useCallback(() => {
    try {
      rfbRef.current?.disconnect();
    } catch {
      /* already gone */
    }
    rfbRef.current = null;
    void boardApi.stopCardBrowser(cardId).catch(() => undefined);
  }, [cardId]);

  React.useEffect(() => () => teardown(), [teardown]);

  const connect = React.useCallback(async () => {
    if (rfbRef.current || !screenRef.current) return;
    setError(null);
    setState("starting");
    try {
      await boardApi.startCardBrowser(cardId);
    } catch (err) {
      setState("error");
      setError(apiErrorMessage(err, "Could not start the card's browser"));
      return;
    }

    setState("connecting");
    let RFB: typeof import("@novnc/novnc").default;
    try {
      RFB = (await import("@novnc/novnc")).default;
    } catch (err) {
      setState("error");
      setError(apiErrorMessage(err, "Could not load the VNC client"));
      return;
    }
    if (!screenRef.current) return; // unmounted while the chunk was loading

    // `wsProtocols: []` because the bridge relays raw RFB with no sub-protocol; the session cookie
    // authenticates the upgrade, exactly like the terminal socket.
    const rfb = new RFB(screenRef.current, wsUrl(`/api/cards/${encodeURIComponent(cardId)}/vnc`), {
      wsProtocols: [],
    });
    rfb.viewOnly = false;
    rfb.scaleViewport = true;
    rfb.focusOnClick = true;
    rfb.background = "#000";
    rfb.addEventListener("connect", () => setState("live"));
    rfb.addEventListener("disconnect", (event: Event) => {
      const clean = (event as CustomEvent<{ clean?: boolean }>).detail?.clean;
      setState(clean ? "closed" : "error");
      if (!clean) setError("The connection to the browser dropped.");
      rfbRef.current = null;
    });
    rfbRef.current = rfb;
  }, [cardId]);

  function close() {
    teardown();
    setState("closed");
    onClose();
  }

  const label = STATE_LABEL[state];

  return (
    <div className="flex min-h-[220px] min-w-0 flex-1 flex-col gap-1">
      <div className="flex items-center justify-between">
        <span className="inline-flex items-center gap-1.5 text-xs font-medium uppercase tracking-wider text-muted-foreground">
          <MonitorPlay className="h-3.5 w-3.5" /> Browser · card Chromium
        </span>
        <div className="flex items-center gap-2">
          <span role="status" className={`font-mono text-[10px] uppercase tracking-wider ${label.className}`}>
            {label.text}
          </span>
          {/* A word, not an ✕. Closing this pane also KILLS the Chromium in the runner and gives the
              RAM back — that is a disconnection, and an icon that usually means "hide" undersells it. */}
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-xs text-muted-foreground"
            aria-label="Disconnect browser"
            title="Disconnect and stop the browser in the runner"
            onClick={close}
          >
            Disconnect
          </Button>
        </div>
      </div>

      <div className="relative flex-1 overflow-hidden rounded-md border border-border/60 bg-black">
        <div ref={screenRef} className="absolute inset-0 h-full w-full" />
        {state !== "live" ? (
          <div className="absolute inset-0 flex items-center justify-center bg-black/60 p-4">
            {state === "error" ? (
              <div className="flex flex-col items-center gap-2 text-center text-xs text-destructive">
                <AlertTriangle className="h-6 w-6" />
                <p className="max-w-md">{error ?? "Something went wrong."}</p>
                <Button variant="outline" size="sm" onClick={() => void connect()}>
                  Try again
                </Button>
              </div>
            ) : state === "starting" || state === "connecting" ? (
              <div className="flex flex-col items-center gap-2 text-center text-xs text-muted-foreground">
                <Loader2 className="h-6 w-6 animate-spin" />
                <p>{state === "starting" ? "Starting the browser in the runner…" : "Connecting…"}</p>
              </div>
            ) : (
              <div className="flex flex-col items-center gap-3 text-center text-xs text-muted-foreground">
                <MonitorPlay className="h-7 w-7" />
                <p className="max-w-md leading-relaxed">
                  The card's own Chromium, live. You can take the keyboard — type a password, clear a
                  captcha — without evicting the agent, which drives the same browser.
                </p>
                <Button variant="secondary" size="sm" onClick={() => void connect()}>
                  <Plug /> Connect
                </Button>
              </div>
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}
