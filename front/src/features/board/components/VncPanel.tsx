import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { AlertTriangle, Eye, KeyRound, Loader2, MonitorPlay, MousePointerClick, Plug } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { wsUrl } from "@/lib/ws";
import { apiErrorMessage } from "@/lib/apiError";
import { boardApi } from "@/features/board/api";
import { t as translate, useT } from "@/i18n";

/**
 * The card's live browser.
 *
 * Chain, end to end:
 *   POST   /api/cards/:id/browser  → Xvfb + x11vnc + a headful Chromium in the runner (idempotent)
 *   WS     /api/cards/:id/vnc      → a raw RFB byte bridge (the server is the websockify)
 *   DELETE /api/cards/:id/browser  → tears it all down and gives the RAM back
 *
 * TWO WAYS TO BE HERE, switchable live (no reconnect — `viewOnly` is a live RFB property):
 *   - "Só assistir" (the DEFAULT): view-only — your mouse and keyboard do NOT reach the page, so
 *     you can watch the agent click without bumping its cursor by accident.
 *   - "Pilotar junto": input on — your clicks and typing land ALONGSIDE the agent's. The agent
 *     drives this same Chromium over CDP (a separate channel from the VNC input), so neither side
 *     evicts the other: take the keyboard for a login or a captcha, hand it back with one click.
 *
 * noVNC is imported lazily. It is a large browser-only bundle that touches the DOM on import, so it
 * has no business loading for anyone who never opens this panel.
 */

type State = "idle" | "starting" | "connecting" | "live" | "error" | "closed";

/** localStorage key remembering the display mode ("fit" | "real") — per browser, per user. */
const VNC_DISPLAY_KEY = "vibehub.vnc.display";

const STATE_TONE: Record<State, string> = {
  idle: "text-muted-foreground",
  starting: "text-amber-400",
  connecting: "text-amber-400",
  live: "text-emerald-400",
  error: "text-red-400",
  closed: "text-muted-foreground",
};

export function VncPanel({ cardId, onClose }: { cardId: string; onClose: () => void }) {
  const t = useT();
  const [state, setState] = React.useState<State>("idle");
  const [error, setError] = React.useState<string | null>(null);
  const screenRef = React.useRef<HTMLDivElement | null>(null);
  const rfbRef = React.useRef<{ disconnect: () => void; viewOnly: boolean; scaleViewport: boolean; clipViewport: boolean } | null>(null);
  // "Só assistir" by default: watching the agent must never interfere with it by accident.
  const [viewOnly, setViewOnly] = React.useState(true);
  // The connect callback reads the CURRENT choice without re-creating itself (a new callback would
  // re-run the auto-connect effect).
  const viewOnlyRef = React.useRef(viewOnly);
  viewOnlyRef.current = viewOnly;

  /** Flip watch/pilot LIVE: `viewOnly` is a plain RFB property, no reconnect involved. */
  const toggleViewOnly = React.useCallback(() => {
    setViewOnly((current) => {
      const next = !current;
      if (rfbRef.current) rfbRef.current.viewOnly = next;
      return next;
    });
  }, []);

  // DISPLAY mode, also live: "Ajustar" scales the Chromium screen to fit the pane (follow the agent
  // with no scrolling); "Tamanho real" is 1:1 at the browser's own resolution (faithful front-end
  // testing), panning inside the pane (`clipViewport`). Remembered per browser (localStorage).
  const [fitScreen, setFitScreen] = React.useState(() => {
    try {
      return window.localStorage.getItem(VNC_DISPLAY_KEY) !== "real";
    } catch {
      return true;
    }
  });
  const fitRef = React.useRef(fitScreen);
  fitRef.current = fitScreen;

  const toggleFit = React.useCallback(() => {
    setFitScreen((current) => {
      const next = !current;
      if (rfbRef.current) {
        rfbRef.current.scaleViewport = next;
        rfbRef.current.clipViewport = !next;
      }
      try {
        window.localStorage.setItem(VNC_DISPLAY_KEY, next ? "fit" : "real");
      } catch {
        /* private window / storage off — the toggle still works for this session */
      }
      return next;
    });
  }, []);

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
      setError(apiErrorMessage(err, translate("vnc.startError")));
      return;
    }

    setState("connecting");
    let RFB: typeof import("@novnc/novnc").default;
    try {
      RFB = (await import("@novnc/novnc")).default;
    } catch (err) {
      setState("error");
      setError(apiErrorMessage(err, translate("vnc.loadError")));
      return;
    }
    if (!screenRef.current) return; // unmounted while the chunk was loading

    // `wsProtocols: []` because the bridge relays raw RFB with no sub-protocol; the session cookie
    // authenticates the upgrade, exactly like the terminal socket.
    const rfb = new RFB(screenRef.current, wsUrl(`/api/cards/${encodeURIComponent(cardId)}/vnc`), {
      wsProtocols: [],
    });
    rfb.viewOnly = viewOnlyRef.current;
    rfb.scaleViewport = fitRef.current;
    rfb.clipViewport = !fitRef.current;
    rfb.focusOnClick = true;
    rfb.background = "#000";
    rfb.addEventListener("connect", () => setState("live"));
    rfb.addEventListener("disconnect", (event: Event) => {
      const clean = (event as CustomEvent<{ clean?: boolean }>).detail?.clean;
      setState(clean ? "closed" : "error");
      if (!clean) setError(translate("vnc.dropped"));
      rfbRef.current = null;
    });
    rfbRef.current = rfb;
  }, [cardId]);

  // Opening the Browser tab shows the live browser straight away — no manual "Connect" gate. The
  // agent's built-in Playwright MCP drives THIS same Chromium over CDP, so it needs the browser
  // running; auto-connecting on mount is what guarantees that the moment the pane is open. `connect`
  // is idempotent (it no-ops when an RFB client already exists) and `startCardBrowser` is idempotent
  // in the runner, so a re-render or a StrictMode double-mount never spawns a second browser.
  React.useEffect(() => {
    void connect();
  }, [connect]);

  function close() {
    teardown();
    setState("closed");
    onClose();
  }

  const tone = STATE_TONE[state];

  return (
    <div className="flex min-h-[220px] min-w-0 flex-1 flex-col gap-1">
      <CapturePrompt cardId={cardId} active={state === "live"} />
      <div className="flex items-center justify-between">
        <span className="inline-flex items-center gap-1.5 text-xs font-medium uppercase tracking-wider text-muted-foreground">
          <MonitorPlay className="h-3.5 w-3.5" /> {t("vnc.header")}
        </span>
        <div className="flex items-center gap-2">
          {/* Display mode, LEFT of the live indicator — quiet, text-only. Fit scales the screen to
              the pane; real size is 1:1 at the Chromium's own resolution (pan to see the rest). */}
          <button
            type="button"
            data-testid="vnc-display-toggle"
            className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground/70 hover:text-muted-foreground"
            title={fitScreen ? t("vnc.fitHint") : t("vnc.realSizeHint")}
            onClick={toggleFit}
          >
            {fitScreen ? t("vnc.fit") : t("vnc.realSize")}
          </button>
          <span role="status" className={`font-mono text-[10px] uppercase tracking-wider ${tone}`}>
            {t(`vnc.state.${state}`)}
          </span>
          {/* Watch/pilot toggle — flips `viewOnly` on the LIVE connection, nobody is disconnected.
              It shows the CURRENT mode; clicking it switches to the other one. */}
          <Button
            variant="outline"
            size="sm"
            data-testid="vnc-input-toggle"
            aria-pressed={!viewOnly}
            className="h-6 px-2 text-xs"
            title={viewOnly ? t("vnc.watchOnlyHint") : t("vnc.pilotHint")}
            onClick={toggleViewOnly}
          >
            {viewOnly ? <Eye className="h-3.5 w-3.5" /> : <MousePointerClick className="h-3.5 w-3.5" />}
            {viewOnly ? t("vnc.watchOnly") : t("vnc.pilot")}
          </Button>
          {/* A word, not an ✕. Closing this pane also KILLS the Chromium in the runner and gives the
              RAM back — that is a disconnection, and an icon that usually means "hide" undersells it. */}
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-xs text-muted-foreground"
            aria-label={t("vnc.disconnectAria")}
            title={t("vnc.disconnectHint")}
            onClick={close}
          >
            {t("vnc.disconnect")}
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
                <p className="max-w-md">{error ?? t("error.generic")}</p>
                <Button variant="outline" size="sm" onClick={() => void connect()}>
                  {t("common.tryAgain")}
                </Button>
              </div>
            ) : state === "starting" || state === "connecting" ? (
              <div className="flex flex-col items-center gap-2 text-center text-xs text-muted-foreground">
                <Loader2 className="h-6 w-6 animate-spin" />
                <p>{state === "starting" ? t("vnc.starting") : t("vnc.connecting")}</p>
              </div>
            ) : (
              <div className="flex flex-col items-center gap-3 text-center text-xs text-muted-foreground">
                <MonitorPlay className="h-7 w-7" />
                <p className="max-w-md leading-relaxed">
                  {t("vnc.intro")}
                </p>
                <Button variant="secondary" size="sm" onClick={() => void connect()}>
                  <Plug /> {t("common.connect")}
                </Button>
              </div>
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/**
 * The Chrome-style "save this login?" prompt. While the browser is live it polls the card's pending
 * captures — logins vibehub noticed being submitted (by the person or the agent) — and offers to save
 * the newest to the Cofre. The PASSWORD never reaches this component: the server holds it keyed by an
 * opaque id, and "Save" only sends that id plus a chosen name.
 */
export function CapturePrompt({ cardId, active }: { cardId: string; active: boolean }) {
  const t = useT();
  const qc = useQueryClient();
  const [name, setName] = React.useState("");
  const [nameEdited, setNameEdited] = React.useState(false);

  const captures = useQuery({
    queryKey: ["captures", cardId],
    queryFn: () => boardApi.cardCaptures(cardId),
    enabled: active,
    refetchInterval: active ? 4000 : false,
  });

  const top = captures.data?.[0];

  // Seed the name field from the suggestion until the person edits it; reset when the capture changes.
  React.useEffect(() => {
    setNameEdited(false);
    setName(top?.suggestedName ?? "");
  }, [top?.id, top?.suggestedName]);

  const save = useMutation({
    mutationFn: () => boardApi.saveCapture(cardId, top!.id, name.trim() || undefined),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["captures", cardId] });
      void qc.invalidateQueries({ queryKey: ["credentials"] });
      toast.success(translate("capture.saved"));
    },
    onError: (e) => toast.error(apiErrorMessage(e)),
  });

  const dismiss = useMutation({
    mutationFn: () => boardApi.dismissCapture(cardId, top!.id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["captures", cardId] }),
  });

  if (!active || !top) return null;

  return (
    <div
      data-testid="capture-prompt"
      className="flex flex-wrap items-center gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs"
    >
      <KeyRound className="h-3.5 w-3.5 shrink-0 text-amber-500" />
      <span className="min-w-0 flex-1">{t("capture.prompt", { host: top.host })}</span>
      <Input
        aria-label={t("capture.saveAs")}
        value={name}
        onChange={(e) => { setName(e.target.value); setNameEdited(true); }}
        onBlur={() => { if (!name.trim() && !nameEdited) setName(top.suggestedName); }}
        className="h-7 w-40 font-mono text-xs"
        maxLength={40}
      />
      <Button
        type="button"
        size="sm"
        className="h-7 px-2 text-xs"
        disabled={!name.trim() || save.isPending}
        onClick={() => save.mutate()}
      >
        {t("capture.save")}
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-7 px-2 text-xs text-muted-foreground"
        disabled={dismiss.isPending}
        onClick={() => dismiss.mutate()}
      >
        {t("capture.dismiss")}
      </Button>
    </div>
  );
}
