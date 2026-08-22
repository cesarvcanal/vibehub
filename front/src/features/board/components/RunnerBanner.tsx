import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { AlertTriangle, ChevronDown, Loader2, Play, Server, TerminalSquare, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { apiErrorMessage } from "@/lib/apiError";
import { LogBox } from "@/features/setup/LogBox";
import { useRunnerLogs } from "@/features/setup/useRunnerLogs";
import { XTerminal } from "@/features/board/components/XTerminal";
import { RUNNER_KEY, boardApi } from "@/features/board/api";
import type { RunnerStatus } from "@/api/types";
import { t as translate, useT } from "@/i18n";

/**
 * The runner's state, in the board's header row.
 *
 * When everything is up this is a single QUIET chip — neutral, not green: a healthy runner is the
 * normal case, and painting the normal case in a status colour trains the eye to ignore colour. The
 * one thing tinted is the dot itself. The full banner only appears for states that need a decision:
 * no container, a stopped container, or a container without `claude` in it. Provisioning is slow
 * and fails in interesting ways, so it streams its real output (`WS /api/runner/logs`) instead of
 * showing a spinner.
 *
 * The chip also opens the runner's OWN shell (`WS /api/runner/terminal`) — the place where `claude`
 * and `gh` are signed in once, by hand. Without it that first login has no home in the UI at all,
 * and it is exactly the thing a fresh install needs. The control only exists when the server says
 * the route is there (`terminal: true`).
 *
 * The component renders inside the header's flex-wrap row, so its block pieces use `w-full` plus an
 * order: the action banner breaks onto its own line ABOVE the header (`order-first`) and the open
 * terminal onto its own line BELOW it (`order-last`); the chip itself stays inline.
 */
export function RunnerBanner() {
  const t = useT();
  const queryClient = useQueryClient();
  const [showLogs, setShowLogs] = React.useState(false);
  const [shellOpen, setShellOpen] = React.useState(false);

  const { data: runner, isLoading } = useQuery({
    queryKey: RUNNER_KEY,
    queryFn: boardApi.runner,
    // The runner comes and goes underneath us (a restart, a redeploy); a slow poll keeps the chip
    // honest without hammering Docker.
    refetchInterval: 20_000,
  });

  const provisioning = Boolean(runner?.provisioning);
  const { lines } = useRunnerLogs(showLogs || provisioning);

  const refresh = React.useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: RUNNER_KEY });
  }, [queryClient]);

  const provisionMutation = useMutation({
    mutationFn: () => boardApi.provisionRunner(),
    onMutate: () => setShowLogs(true),
    onSuccess: () => toast.message(translate("runner.provisioningToast")),
    onError: (error) => toast.error(apiErrorMessage(error, translate("runner.provisionStartError"))),
    onSettled: refresh,
  });

  const startMutation = useMutation({
    mutationFn: () => boardApi.startRunner(),
    onSuccess: () => toast.success(translate("runner.started")),
    onError: (error) => toast.error(apiErrorMessage(error, translate("runner.startError"))),
    onSettled: refresh,
  });

  // Provisioning finishes in the background; re-read the status until it settles.
  React.useEffect(() => {
    if (!provisioning) return;
    const timer = setInterval(refresh, 4_000);
    return () => clearInterval(timer);
  }, [provisioning, refresh]);

  if (isLoading) {
    return (
      <span
        title={t("runner.checking")}
        className="inline-flex h-9 items-center gap-1.5 rounded-md border border-border/60 bg-card/40 px-2.5 text-[11px] font-medium text-muted-foreground"
      >
        <Loader2 className="h-3.5 w-3.5 animate-spin" /> {t("runner.chip")}
      </span>
    );
  }

  // The read itself failed: say nothing here. Opening a card is where it will actually hurt, and
  // that surface reports it with the real error.
  if (!runner) return null;

  // The runner container is up and can host a shell. `terminal` is what the server answers when the
  // websocket route exists; an older server simply does not offer the button.
  const canShell = Boolean(runner.running && runner.terminal);
  // A terminal that appears with no name and no way out is a mystery box: it gets a header row
  // saying what it is and a close button, and a height worth typing in.
  const shell =
    shellOpen && canShell ? (
      <div data-testid="runner-shell" className="flex h-[40vh] min-h-[220px] flex-col gap-1">
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            {t("runner.shellHeader")}
          </span>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6 text-muted-foreground"
            aria-label={t("runner.closeShell")}
            title={t("runner.closeShell")}
            onClick={() => setShellOpen(false)}
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>
        <XTerminal wsPath="/api/runner/terminal" ariaLabel={t("runner.shellHeader")} />
      </div>
    ) : null;

  const ready = runner.running && runner.claudeInstalled;
  if (ready && !showLogs) {
    return (
      <>
        <span
          title={runnerTitle(runner)}
          className={cn(
            "inline-flex h-9 items-center gap-2 rounded-md border border-border/60 bg-card/40 text-[11px] font-medium text-muted-foreground",
            canShell ? "pl-2.5 pr-1" : "px-2.5",
          )}
        >
          <span className="inline-block h-2 w-2 rounded-full bg-emerald-400 dot-live" />
          {t("runner.chip")}
          {canShell ? (
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              aria-label={shellOpen ? t("runner.closeOwnShell") : t("runner.openOwnShell")}
              title={shellOpen ? t("runner.closeOwnShell") : t("runner.openOwnShell")}
              aria-expanded={shellOpen}
              onClick={() => setShellOpen((v) => !v)}
            >
              <TerminalSquare className="h-4 w-4" />
            </Button>
          ) : null}
        </span>
        {shell ? <div className="order-last w-full">{shell}</div> : null}
      </>
    );
  }

  const problem = describe(runner, provisioning);

  return (
    <div className="order-first w-full space-y-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-start gap-2 text-xs text-amber-500">
          {problem.icon}
          <span className="max-w-prose leading-relaxed">{problem.message}</span>
        </div>
        <div className="flex items-center gap-2">
          {runner.exists && !runner.running ? (
            <Button size="sm" variant="outline" disabled={startMutation.isPending} onClick={() => startMutation.mutate()}>
              {startMutation.isPending ? <Loader2 className="animate-spin" /> : <Play />}
              {t("runner.start")}
            </Button>
          ) : null}
          {/* Signing `claude` in is done HERE, by hand, in the runner's own shell. */}
          {canShell ? (
            <Button size="sm" variant="outline" aria-expanded={shellOpen} onClick={() => setShellOpen((v) => !v)}>
              <TerminalSquare />
              {shellOpen ? t("runner.closeShellShort") : t("runner.openOwnShell")}
            </Button>
          ) : null}
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setShowLogs((v) => !v)}
            aria-expanded={showLogs}
          >
            <ChevronDown className={showLogs ? "rotate-180 transition-transform" : "transition-transform"} />
            {t("runner.logs")}
          </Button>
          <Button
            size="sm"
            disabled={provisionMutation.isPending || provisioning || !runner.dockerReachable}
            onClick={() => provisionMutation.mutate()}
          >
            {provisionMutation.isPending || provisioning ? <Loader2 className="animate-spin" /> : null}
            {runner.exists ? t("runner.reprovision") : t("runner.provision")}
          </Button>
        </div>
      </div>
      {shell}
      {showLogs || provisioning ? <LogBox lines={lines} empty={t("runner.noOutput")} /> : null}
    </div>
  );
}

function runnerTitle(runner: RunnerStatus): string {
  const where = runner.host ? translate("runner.onHost", { host: runner.host }) : "";
  return translate("runner.titleOk", { container: runner.container, where });
}

function describe(runner: RunnerStatus, provisioning: boolean): { icon: React.ReactNode; message: React.ReactNode } {
  const warn = <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />;
  if (provisioning) {
    return {
      icon: <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin" />,
      message: translate("runner.provisioningMsg"),
    };
  }
  if (!runner.dockerReachable) {
    return {
      icon: warn,
      message:
        runner.detail ??
        translate("runner.dockerNoAnswer", {
          where: runner.host ? translate("runner.onHost", { host: runner.host }) : "",
        }),
    };
  }
  if (!runner.exists) {
    return {
      icon: <Server className="mt-0.5 h-4 w-4 shrink-0" />,
      message: translate("runner.noContainer", { container: runner.container }),
    };
  }
  if (!runner.running) {
    return { icon: warn, message: translate("runner.stopped", { container: runner.container }) };
  }
  return {
    icon: warn,
    message: (
      <>
        {translate("runner.claudeMissing1")}
        <span className="font-mono">claude</span>
        {translate("runner.claudeMissing2")}
        <span className="font-mono">claude</span>
        {translate("runner.claudeMissing3")}
      </>
    ),
  };
}
