import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLink, Globe, Loader2, RotateCw, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { boardApi, CARDS_PREFIX_KEY, PREVIEW_PORTS_KEY } from "@/features/board/api";
import { apiErrorMessage } from "@/lib/apiError";
import type { CardPreview } from "@/api/types";
import { useT } from "@/i18n";

/**
 * PREVIEW — open, in a real browser tab, an app the agent started inside the runner.
 *
 * The menu shows the previews the agent REGISTERED on this card first (`vibehub_preview` — the
 * links it announced on purpose, each with an up/stopped dot and a stop button), then what is
 * LISTENING in the runner right now (scanned when the menu opens, not on a poll — a dev server
 * comes and goes, and the moment of truth is the click), plus a port field for the one the scan
 * cannot guess. Choosing any opens `/preview/<port>/` in a NEW TAB: same vibehub origin, so the
 * session cookie rides along and the back-end proxies into the runner.
 *
 * A registered preview has a LIFE OF ITS OWN: the server stores its start command, so clicking a
 * STOPPED one is never a dry 502 — it opens a small "Preview parado" dialog whose Restart button
 * relaunches the server in its dedicated runner session and then opens the tab.
 */

/** The tab's URL for a runner port — same origin, so auth and the VPN path are already solved. */
export function previewUrl(port: number): string {
  return `/preview/${port}/`;
}

/** What a registered preview is called wherever it shows: its label, or the port. PURE. */
export function previewName(p: Pick<CardPreview, "port" | "label">): string {
  return p.label?.trim() || `:${p.port}`;
}

/** Registered previews, newest first — the one just announced is the one the user wants. PURE. */
export function sortPreviews(previews: readonly CardPreview[] | undefined): CardPreview[] {
  return [...(previews ?? [])].sort((a, b) => b.createdAt - a.createdAt || b.port - a.port);
}

/**
 * A preview's state against the last port scan: `up` (listening), `down` (scanned, silent), or
 * `unknown` (no scan yet — treat as up: opening the tab is the optimistic default, and the dialog
 * exists for the KNOWN-stopped case). PURE.
 */
export type PreviewState = "up" | "down" | "unknown";

export function previewState(port: number, scanned: readonly { port: number }[] | undefined): PreviewState {
  if (!scanned) return "unknown";
  return scanned.some((p) => p.port === port) ? "up" : "down";
}

/** Opens a preview in a new tab — one place, so every entry point behaves the same. */
export function openPreviewTab(port: number): void {
  window.open(previewUrl(port), "_blank", "noopener,noreferrer");
}

/**
 * The scan the CHIP leans on: refreshed often enough that "no ar"/"parado" is honest, cheap
 * enough (one docker exec every half minute, only while a card with previews is on screen) not to
 * matter. The menu's own on-open scan shares the key, so the two can never disagree.
 */
function usePreviewScan(enabled: boolean) {
  return useQuery({
    queryKey: PREVIEW_PORTS_KEY,
    queryFn: boardApi.previewPorts,
    enabled,
    staleTime: 15_000,
    refetchInterval: enabled ? 30_000 : false,
    retry: false,
  });
}

/**
 * The "Preview parado" screen: a stopped preview is a thing to RESTART, not a dead link. With a
 * stored command the primary action relaunches the server in its dedicated runner session, waits
 * for the port and opens the tab; without one (an old/manual registration) it says the honest
 * thing — ask the card's agent to start it again. Stopping (kill + chip removal) also lives here.
 */
export function PreviewRestartDialog({
  cardId,
  preview,
  open,
  onOpenChange,
}: {
  cardId: string;
  preview: CardPreview | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useT();
  const queryClient = useQueryClient();
  const [error, setError] = React.useState<string | null>(null);

  const restart = useMutation({
    mutationFn: () => boardApi.restartPreview(cardId, preview!.port),
    onSuccess: (r) => {
      setError(null);
      void queryClient.invalidateQueries({ queryKey: PREVIEW_PORTS_KEY });
      onOpenChange(false);
      openPreviewTab(r.port);
    },
    onError: (err) => setError(apiErrorMessage(err, t("preview.restartError"))),
  });

  const stop = useMutation({
    mutationFn: () => boardApi.stopPreview(cardId, preview!.port),
    onSuccess: () => {
      setError(null);
      void queryClient.invalidateQueries({ queryKey: PREVIEW_PORTS_KEY });
      void queryClient.invalidateQueries({ queryKey: CARDS_PREFIX_KEY });
      onOpenChange(false);
    },
    onError: (err) => setError(apiErrorMessage(err, t("preview.stopError"))),
  });

  if (!preview) return null;
  const busy = restart.isPending || stop.isPending;
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (busy) return; // a relaunch in flight finishes what it started
        setError(null);
        onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("preview.stoppedTitle", { name: previewName(preview) })}</DialogTitle>
          <DialogDescription>
            {preview.command ? t("preview.stoppedBody") : t("preview.stoppedNoCommand")}
          </DialogDescription>
        </DialogHeader>
        {preview.command ? (
          <p className="break-all rounded-md bg-muted/60 px-2 py-1.5 font-mono text-xs text-muted-foreground">
            {preview.command}
          </p>
        ) : null}
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
        <DialogFooter className="gap-2 sm:justify-between">
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() => stop.mutate()}
            className="text-muted-foreground hover:text-destructive"
          >
            {stop.isPending ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <X className="mr-1.5 h-3.5 w-3.5" />}
            {t("preview.stopButton")}
          </Button>
          {preview.command ? (
            <Button size="sm" disabled={busy} onClick={() => restart.mutate()}>
              {restart.isPending ? (
                <>
                  <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                  {t("preview.restarting")}
                </>
              ) : (
                <>
                  <RotateCw className="mr-1.5 h-3.5 w-3.5" />
                  {t("preview.restartButton")}
                </>
              )}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** The colored dot that says whether a preview's port answered the last scan. */
function StateDot({ state }: { state: PreviewState }) {
  return (
    <span
      aria-hidden
      className={cn(
        "h-1.5 w-1.5 shrink-0 rounded-full",
        state === "down" ? "bg-amber-500" : "bg-emerald-500",
      )}
    />
  );
}

/**
 * The CHIP on the card bar: the latest preview the agent registered, as a click-to-open button the
 * user cannot miss — the whole point of `vibehub_preview` is "the agent announces, the user
 * clicks". It carries the live state: green + open in a tab while the port answers, amber
 * "parado" + the restart dialog once it stops. Renders nothing while no preview is registered.
 */
export function PreviewChip({ cardId, previews }: { cardId: string; previews?: CardPreview[] }) {
  const t = useT();
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const latest = sortPreviews(previews)[0];
  const { data: scanned } = usePreviewScan(Boolean(latest));
  if (!latest) return null;
  const state = previewState(latest.port, scanned);
  const down = state === "down";
  return (
    <>
      <button
        type="button"
        data-testid="preview-chip"
        onClick={() => (down ? setDialogOpen(true) : openPreviewTab(latest.port))}
        title={down ? t("preview.chipDownHint", { name: previewName(latest) }) : t("preview.chipHint", { name: previewName(latest) })}
        className={cn(
          "inline-flex h-6 max-w-[13rem] shrink-0 items-center gap-1.5 rounded-full border px-2 text-[11px] transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
          down
            ? "border-amber-500/40 bg-amber-500/10 text-amber-600 hover:border-amber-500/70 hover:bg-amber-500/20 dark:text-amber-400"
            : "border-emerald-500/40 bg-emerald-500/10 text-emerald-600 hover:border-emerald-500/70 hover:bg-emerald-500/20 dark:text-emerald-400",
        )}
      >
        {down ? <RotateCw className="h-3.5 w-3.5 shrink-0" /> : <ExternalLink className="h-3.5 w-3.5 shrink-0" />}
        <span className="truncate">
          {down
            ? t("preview.chipDown", { name: previewName(latest) })
            : t("preview.chip", { name: previewName(latest) })}
        </span>
      </button>
      <PreviewRestartDialog cardId={cardId} preview={latest} open={dialogOpen} onOpenChange={setDialogOpen} />
    </>
  );
}

/** A usable TCP port, from the manual field. */
export function parsePortInput(raw: string): number | null {
  if (!/^\d{1,5}$/.test(raw.trim())) return null;
  const port = Number(raw.trim());
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
}

export function PreviewMenu({
  cardId,
  disabled,
  compact,
  previews,
}: {
  /** Card whose previews are managed here — restart/stop are per card. */
  cardId: string;
  disabled?: boolean;
  /** Icon-only trigger for the phone's bar, where a labelled pill does not fit. */
  compact?: boolean;
  /** Previews the agent registered on this card — listed FIRST, above the raw port scan. */
  previews?: CardPreview[];
}) {
  const t = useT();
  const queryClient = useQueryClient();
  const [open, setOpen] = React.useState(false);
  const [manual, setManual] = React.useState("");
  const [dialogFor, setDialogFor] = React.useState<CardPreview | null>(null);

  // Scanned when the menu opens; refetchOnMount because "what is up NOW" is the entire question.
  const { data: ports, isLoading, isError } = useQuery({
    queryKey: PREVIEW_PORTS_KEY,
    queryFn: boardApi.previewPorts,
    enabled: open,
    refetchOnMount: "always",
    staleTime: 0,
    retry: false,
  });

  const stop = useMutation({
    mutationFn: (port: number) => boardApi.stopPreview(cardId, port),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: PREVIEW_PORTS_KEY });
      void queryClient.invalidateQueries({ queryKey: CARDS_PREFIX_KEY });
    },
  });

  const openPreview = React.useCallback((port: number) => {
    openPreviewTab(port);
  }, []);

  const registered = sortPreviews(previews);
  // A registered port already has its own row above — repeating it in the scan is just noise.
  const registeredPorts = new Set(registered.map((p) => p.port));
  const detected = ports?.filter((p) => !registeredPorts.has(p.port));
  const manualPort = parsePortInput(manual);

  function submitManual() {
    if (manualPort === null) return;
    openPreview(manualPort);
    setOpen(false);
    setManual("");
  }

  /** A stopped registered preview goes to the restart dialog; a live (or unscanned) one just opens. */
  function selectRegistered(p: CardPreview) {
    if (previewState(p.port, ports) === "down") setDialogFor(p);
    else openPreview(p.port);
  }

  return (
    <>
      <DropdownMenu open={open} onOpenChange={setOpen}>
        <DropdownMenuTrigger asChild>
          {compact ? (
            <Button
              variant="ghost"
              size="icon"
              disabled={disabled}
              aria-label={t("preview.label")}
              title={t("preview.hint")}
              className="h-9 w-9 shrink-0 rounded-md border border-border/50 bg-card/40 text-muted-foreground"
            >
              <Globe className="h-4 w-4" />
            </Button>
          ) : (
            <button
              type="button"
              disabled={disabled}
              aria-label={t("preview.label")}
              title={t("preview.hint")}
              className={cn(
                "inline-flex h-6 shrink-0 items-center gap-1 rounded-full border px-2 text-[11px] transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
                open
                  ? "border-primary/40 bg-primary/15 text-primary"
                  : "border-border/60 bg-muted/40 text-muted-foreground hover:border-border hover:text-foreground",
              )}
            >
              <Globe className="h-3.5 w-3.5" />
              {t("preview.label")}
            </button>
          )}
        </DropdownMenuTrigger>
        <DropdownMenuContent side="bottom" align="end" className="w-64">
          {registered.length > 0 ? (
            <>
              <DropdownMenuLabel>{t("preview.registered")}</DropdownMenuLabel>
              {registered.map((p) => (
                <DropdownMenuItem key={`reg-${p.port}`} onSelect={() => selectRegistered(p)}>
                  <StateDot state={previewState(p.port, ports)} />
                  <span className="ml-2 truncate">{previewName(p)}</span>
                  <span className="ml-auto pl-2 font-mono text-xs tabular-nums text-muted-foreground">:{p.port}</span>
                  {/* Stop lives INSIDE the row: kill the dedicated session, drop the chip. */}
                  <button
                    type="button"
                    aria-label={t("preview.stopButton")}
                    title={t("preview.stopButton")}
                    disabled={stop.isPending}
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      stop.mutate(p.port);
                    }}
                    className="ml-1.5 rounded p-0.5 text-muted-foreground hover:bg-destructive/15 hover:text-destructive"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </DropdownMenuItem>
              ))}
              <DropdownMenuSeparator />
            </>
          ) : null}
          <DropdownMenuLabel>{t("preview.detected")}</DropdownMenuLabel>
          {isLoading ? (
            <DropdownMenuItem disabled>
              <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
              {t("preview.loading")}
            </DropdownMenuItem>
          ) : isError ? (
            <DropdownMenuItem disabled>{t("preview.error")}</DropdownMenuItem>
          ) : !detected || detected.length === 0 ? (
            <DropdownMenuItem disabled>{t("preview.none")}</DropdownMenuItem>
          ) : (
            detected.map((p) => (
              <DropdownMenuItem key={p.port} onSelect={() => openPreview(p.port)}>
                <ExternalLink className="mr-2 h-3.5 w-3.5 text-muted-foreground" />
                <span className="font-mono tabular-nums">:{p.port}</span>
                {p.process ? (
                  <span className="ml-2 truncate text-xs text-muted-foreground">{p.process}</span>
                ) : null}
              </DropdownMenuItem>
            ))
          )}
          <DropdownMenuSeparator />
          {/* The port the scan cannot guess — typed, Enter (or the button) opens it. A plain div so
              the menu's own keyboard handling does not swallow the digits. */}
          <div
            className="flex items-center gap-1.5 px-2 py-1.5"
            onKeyDown={(e) => e.stopPropagation()}
          >
            <input
              value={manual}
              onChange={(e) => setManual(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  submitManual();
                }
              }}
              inputMode="numeric"
              placeholder={t("preview.manualPlaceholder")}
              aria-label={t("preview.manualPlaceholder")}
              className="h-7 w-full min-w-0 rounded-md border border-input bg-background px-2 font-mono text-xs tabular-nums focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            />
            <Button
              size="sm"
              variant="outline"
              className="h-7 shrink-0 px-2 text-xs"
              disabled={manualPort === null}
              onClick={submitManual}
            >
              {t("preview.open")}
            </Button>
          </div>
          <p className="max-w-[15rem] px-2 pb-1.5 text-[10px] leading-snug text-muted-foreground">
            {t("preview.baseHint")}
          </p>
        </DropdownMenuContent>
      </DropdownMenu>
      <PreviewRestartDialog
        cardId={cardId}
        preview={dialogFor}
        open={dialogFor !== null}
        onOpenChange={(next) => {
          if (!next) setDialogFor(null);
        }}
      />
    </>
  );
}
