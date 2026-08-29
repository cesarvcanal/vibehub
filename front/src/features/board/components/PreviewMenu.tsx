import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { ExternalLink, Globe, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { boardApi, PREVIEW_PORTS_KEY } from "@/features/board/api";
import type { CardPreview } from "@/api/types";
import { useT } from "@/i18n";

/**
 * PREVIEW — open, in a real browser tab, an app the agent started inside the runner.
 *
 * The menu shows the previews the agent REGISTERED on this card first (`vibehub_preview` — the
 * links it announced on purpose), then what is LISTENING in the runner right now (scanned when the
 * menu opens, not on a poll — a dev server comes and goes, and the moment of truth is the click),
 * plus a port field for the one the scan cannot guess. Choosing any opens `/preview/<port>/` in a
 * NEW TAB: same vibehub origin, so the session cookie rides along and the back-end proxies into
 * the runner.
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

/** Opens a preview in a new tab — one place, so every entry point behaves the same. */
export function openPreviewTab(port: number): void {
  window.open(previewUrl(port), "_blank", "noopener,noreferrer");
}

/**
 * The CHIP on the card bar: the latest preview the agent registered, as a click-to-open button the
 * user cannot miss — the whole point of `vibehub_preview` is "the agent announces, the user clicks".
 * Renders nothing while no preview is registered.
 */
export function PreviewChip({ previews }: { previews?: CardPreview[] }) {
  const t = useT();
  const latest = sortPreviews(previews)[0];
  if (!latest) return null;
  return (
    <button
      type="button"
      data-testid="preview-chip"
      onClick={() => openPreviewTab(latest.port)}
      title={t("preview.chipHint", { name: previewName(latest) })}
      className="inline-flex h-6 max-w-[12rem] shrink-0 items-center gap-1 rounded-full border border-emerald-500/40 bg-emerald-500/10 px-2 text-[11px] text-emerald-600 transition-colors hover:border-emerald-500/70 hover:bg-emerald-500/20 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring dark:text-emerald-400"
    >
      <ExternalLink className="h-3.5 w-3.5 shrink-0" />
      <span className="truncate">{t("preview.chip", { name: previewName(latest) })}</span>
    </button>
  );
}

/** A usable TCP port, from the manual field. */
export function parsePortInput(raw: string): number | null {
  if (!/^\d{1,5}$/.test(raw.trim())) return null;
  const port = Number(raw.trim());
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
}

export function PreviewMenu({
  disabled,
  compact,
  previews,
}: {
  disabled?: boolean;
  /** Icon-only trigger for the phone's bar, where a labelled pill does not fit. */
  compact?: boolean;
  /** Previews the agent registered on this card — listed FIRST, above the raw port scan. */
  previews?: CardPreview[];
}) {
  const t = useT();
  const [open, setOpen] = React.useState(false);
  const [manual, setManual] = React.useState("");

  // Scanned when the menu opens; refetchOnMount because "what is up NOW" is the entire question.
  const { data: ports, isLoading, isError } = useQuery({
    queryKey: PREVIEW_PORTS_KEY,
    queryFn: boardApi.previewPorts,
    enabled: open,
    refetchOnMount: "always",
    staleTime: 0,
    retry: false,
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

  return (
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
              <DropdownMenuItem key={`reg-${p.port}`} onSelect={() => openPreview(p.port)}>
                <ExternalLink className="mr-2 h-3.5 w-3.5 text-emerald-500" />
                <span className="truncate">{previewName(p)}</span>
                <span className="ml-auto pl-2 font-mono text-xs tabular-nums text-muted-foreground">:{p.port}</span>
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
  );
}
