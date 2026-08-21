import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { AlertTriangle, ChevronDown, Loader2, Play, Server } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { apiErrorMessage } from "@/lib/apiError";
import { LogBox } from "@/features/setup/LogBox";
import { useRunnerLogs } from "@/features/setup/useRunnerLogs";
import { RUNNER_KEY, boardApi } from "@/features/board/api";
import type { RunnerStatus } from "@/api/types";

/**
 * The runner's state, above the board.
 *
 * When everything is up this is a single quiet chip — a healthy runner does not deserve a banner.
 * The banner only appears for states that need a decision: no container, a stopped container, or a
 * container without `claude` in it. Provisioning is slow and fails in interesting ways, so it
 * streams its real output (`WS /api/runner/logs`) instead of showing a spinner.
 */
export function RunnerBanner() {
  const queryClient = useQueryClient();
  const [showLogs, setShowLogs] = React.useState(false);

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
    onSuccess: () => toast.message("Provisioning the runner — the output is below."),
    onError: (error) => toast.error(apiErrorMessage(error, "Could not start provisioning")),
    onSettled: refresh,
  });

  const startMutation = useMutation({
    mutationFn: () => boardApi.startRunner(),
    onSuccess: () => toast.success("Runner started."),
    onError: (error) => toast.error(apiErrorMessage(error, "Could not start the runner")),
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
      <Badge tone="muted" className="h-8 px-2.5">
        <Loader2 className="h-3.5 w-3.5 animate-spin" /> runner
      </Badge>
    );
  }

  // The read itself failed: say nothing here. Opening a card is where it will actually hurt, and
  // that surface reports it with the real error.
  if (!runner) return null;

  const ready = runner.running && runner.claudeInstalled;
  if (ready && !showLogs) {
    return (
      <Badge tone="ok" className="h-8 px-2.5" title={runnerTitle(runner)}>
        <span className="inline-block h-2 w-2 rounded-full bg-emerald-400 motion-safe:animate-[vh-pulse_2s_ease-in-out_infinite]" />
        runner
      </Badge>
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
              Start
            </Button>
          ) : null}
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setShowLogs((v) => !v)}
            aria-expanded={showLogs}
          >
            <ChevronDown className={showLogs ? "rotate-180 transition-transform" : "transition-transform"} />
            Logs
          </Button>
          <Button
            size="sm"
            disabled={provisionMutation.isPending || provisioning || !runner.dockerReachable}
            onClick={() => provisionMutation.mutate()}
          >
            {provisionMutation.isPending || provisioning ? <Loader2 className="animate-spin" /> : null}
            {runner.exists ? "Reprovision" : "Provision runner"}
          </Button>
        </div>
      </div>
      {showLogs || provisioning ? <LogBox lines={lines} empty="No output yet." /> : null}
    </div>
  );
}

function runnerTitle(runner: RunnerStatus): string {
  const where = runner.host ? ` on ${runner.host}` : "";
  return `${runner.container}${where} — running, claude installed`;
}

function describe(runner: RunnerStatus, provisioning: boolean): { icon: React.ReactNode; message: string } {
  const warn = <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />;
  if (provisioning) {
    return { icon: <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin" />, message: "Provisioning the runner…" };
  }
  if (!runner.dockerReachable) {
    return {
      icon: warn,
      message:
        runner.detail ??
        `The Docker daemon${runner.host ? ` on ${runner.host}` : ""} did not answer, so nothing can be provisioned yet.`,
    };
  }
  if (!runner.exists) {
    return {
      icon: <Server className="mt-0.5 h-4 w-4 shrink-0" />,
      message: `There is no ${runner.container} container yet — cards need it to open a terminal.`,
    };
  }
  if (!runner.running) {
    return { icon: warn, message: `${runner.container} exists but is stopped.` };
  }
  return {
    icon: warn,
    message:
      "The runner is up but `claude` is not installed in it. Reprovision, or install it from a shell and run `claude` once to sign in.",
  };
}
