import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Check, Loader2, Puzzle, RefreshCw, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { apiErrorMessage } from "@/lib/apiError";
import { applyOutcomeMessage } from "@/features/board/lib/applyOutcome";
import { CARDS_PREFIX_KEY, PLUGINS_KEY, boardApi } from "@/features/board/api";
import type { PluginEntry } from "@/api/types";
import { t as translate, useT } from "@/i18n";

/**
 * SKILLS — Anthropic's official plugin marketplace, from this screen into every card.
 *
 * A plugin is how Claude Code ships skills, commands and agents (`code-review`, `code-simplifier`,
 * `superpowers` and the rest are entries in the official catalogue). Installing one here installs
 * it into EVERY Claude profile of the runner, so every card — of every project, on every account —
 * can invoke it from the chat's "/" menu or from the terminal. A Claude account created later gets
 * the same set on its first card open.
 *
 * ONE catalogue, on purpose: a plugin runs in the runner with the agent's own reach, so "paste any
 * git URL" would turn this screen into a way to run arbitrary code in every card by typing a name.
 * The official marketplace is the boundary.
 *
 * The list is read from the runner every time the dialog opens — the catalogue moves on Anthropic's
 * side, and a cached one offers what may no longer exist.
 */

/** How many entries are drawn at once. The catalogue is hundreds long; the search is the way in. */
const VISIBLE_LIMIT = 40;

/** Case/accent-insensitive haystack. PURE. */
function fold(value: string): string {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

/**
 * What the list shows for a query: everything the install WANTS first (so the set in use is never
 * buried under 300 entries), then the rest by popularity, filtered by name and description. PURE.
 */
export function filterPlugins(plugins: PluginEntry[], query: string, limit = VISIBLE_LIMIT): PluginEntry[] {
  const q = fold(query.trim());
  const matches = q === ""
    ? plugins
    : plugins.filter((p) => fold(p.name).includes(q) || fold(p.description ?? "").includes(q));
  return [...matches]
    .sort((a, b) => Number(b.enabled) - Number(a.enabled) || (b.installs ?? 0) - (a.installs ?? 0))
    .slice(0, limit);
}

/** "1.1M", "482k", "37" — an install count you can read at a glance. PURE. */
export function formatInstalls(installs: number | undefined): string {
  if (!installs || installs < 0) return "";
  if (installs >= 1_000_000) return `${(installs / 1_000_000).toFixed(1)}M`;
  if (installs >= 1_000) return `${Math.round(installs / 1_000)}k`;
  return String(installs);
}

export function PluginsManager({ trigger = "icon" }: { trigger?: "icon" | "row" } = {}) {
  const t = useT();
  const queryClient = useQueryClient();
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  /** The plugin whose install/removal is in flight — only its own row spins. */
  const [busyName, setBusyName] = React.useState<string | null>(null);

  const { data, isLoading, isError, error, refetch, isFetching } = useQuery({
    queryKey: PLUGINS_KEY,
    queryFn: boardApi.plugins,
    enabled: open,
    // The runner clones a marketplace to answer this: do not re-ask on every focus change.
    staleTime: 5 * 60_000,
  });

  /** The catalogue AND the board: an install flags cards for restart, and the tiles must say so. */
  const refresh = React.useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: PLUGINS_KEY });
    void queryClient.invalidateQueries({ queryKey: CARDS_PREFIX_KEY });
  }, [queryClient]);

  const install = useMutation({
    mutationFn: (name: string) => boardApi.installPlugin(name),
    onSuccess: (result, name) => {
      refresh();
      toast.success(applyOutcomeMessage(result, translate("plugins.subject", { name })));
    },
    onError: (err) => toast.error(apiErrorMessage(err, translate("plugins.installError"))),
    onSettled: () => setBusyName(null),
  });

  const remove = useMutation({
    mutationFn: (name: string) => boardApi.removePlugin(name),
    onSuccess: (result, name) => {
      refresh();
      toast.success(applyOutcomeMessage(result, translate("plugins.removedSubject", { name })));
    },
    onError: (err) => toast.error(apiErrorMessage(err, translate("plugins.removeError"))),
    onSettled: () => setBusyName(null),
  });

  const shown = React.useMemo(() => filterPlugins(data?.plugins ?? [], query), [data, query]);
  const enabledCount = (data?.plugins ?? []).filter((p) => p.enabled).length;

  return (
    <>
      {trigger === "row" ? (
        <Button
          type="button"
          variant="outline"
          className="w-full justify-start gap-2"
          title={t("plugins.buttonTitle")}
          onClick={() => setOpen(true)}
        >
          <Puzzle className="h-4 w-4 text-muted-foreground" />
          {t("plugins.aria")}
        </Button>
      ) : (
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 text-muted-foreground hover:text-foreground"
          aria-label={t("plugins.aria")}
          title={t("plugins.buttonTitle")}
          onClick={() => setOpen(true)}
        >
          <Puzzle className="h-4 w-4" />
        </Button>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="flex max-h-[90vh] max-w-2xl flex-col">
          <DialogHeader>
            <DialogTitle>{t("plugins.title")}</DialogTitle>
            <DialogDescription>{t("plugins.description")}</DialogDescription>
          </DialogHeader>

          <div className="flex items-center gap-2">
            <div className="relative min-w-0 flex-1">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <input
                type="text"
                data-testid="plugins-search"
                aria-label={t("plugins.searchAria")}
                placeholder={t("plugins.searchPlaceholder")}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                className="h-9 w-full rounded-md border border-border bg-card pl-8 pr-2 text-sm outline-none placeholder:text-muted-foreground focus:ring-1 focus:ring-primary/50"
              />
            </div>
            <Button
              type="button"
              variant="outline"
              size="icon"
              className="h-9 w-9 shrink-0"
              data-testid="plugins-refresh"
              aria-label={t("plugins.refresh")}
              title={t("plugins.refresh")}
              disabled={isFetching}
              onClick={() => void refetch()}
            >
              {isFetching ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            </Button>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto" data-testid="plugins-list">
            {isLoading ? (
              <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                {t("plugins.loading")}
              </div>
            ) : isError ? (
              /* The catalogue lives in the runner: a runner that is down has no list to give, and
                 saying so beats an empty screen that looks like an empty marketplace. */
              <div data-testid="plugins-error" className="py-6 text-sm text-destructive">
                {apiErrorMessage(error, translate("plugins.loadError"))}
              </div>
            ) : shown.length === 0 ? (
              <div className="py-6 text-sm text-muted-foreground">{t("plugins.empty")}</div>
            ) : (
              <ul className="flex flex-col gap-1">
                {shown.map((plugin) => {
                  const busy = busyName === plugin.name;
                  return (
                    <li
                      key={plugin.name}
                      data-testid="plugins-item"
                      data-enabled={plugin.enabled ? "true" : undefined}
                      className="flex items-start gap-3 rounded-md border border-border/60 px-3 py-2"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex items-baseline gap-2">
                          <span className="truncate font-mono text-xs text-foreground">{plugin.name}</span>
                          {plugin.installs ? (
                            <span className="shrink-0 text-[10px] text-muted-foreground/70">
                              {t("plugins.installs", { n: formatInstalls(plugin.installs) })}
                            </span>
                          ) : null}
                          {plugin.enabled && !plugin.installed ? (
                            /* Wanted, not on disk: the runner was down, or the clone failed. The
                               difference matters — "apply now" is what fixes it. */
                            <span data-testid="plugins-pending" className="shrink-0 text-[10px] text-amber-600 dark:text-amber-400">
                              {t("plugins.pending")}
                            </span>
                          ) : null}
                        </div>
                        {plugin.description ? (
                          <p className="line-clamp-2 text-[11px] leading-snug text-muted-foreground">{plugin.description}</p>
                        ) : null}
                      </div>
                      <Button
                        type="button"
                        size="sm"
                        variant={plugin.enabled ? "outline" : "default"}
                        className="h-7 shrink-0 gap-1 text-xs"
                        data-testid={plugin.enabled ? "plugins-remove" : "plugins-install"}
                        disabled={busy || install.isPending || remove.isPending}
                        onClick={() => {
                          setBusyName(plugin.name);
                          if (plugin.enabled) remove.mutate(plugin.name);
                          else install.mutate(plugin.name);
                        }}
                      >
                        {busy ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : plugin.enabled ? (
                          <Check className="h-3.5 w-3.5" />
                        ) : null}
                        {plugin.enabled ? t("plugins.remove") : t("plugins.install")}
                      </Button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          <p className="text-[11px] text-muted-foreground/80">
            {t("plugins.footer", { marketplace: data?.marketplace ?? "", n: enabledCount })}
          </p>
        </DialogContent>
      </Dialog>
    </>
  );
}
