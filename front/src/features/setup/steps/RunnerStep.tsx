import * as React from "react";
import { get, patch, post } from "@/lib/api";
import { apiErrorMessage } from "@/lib/apiError";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { LogBox } from "@/features/setup/LogBox";
import { useRunnerLogs } from "@/features/setup/useRunnerLogs";
import { StepError, StepFrame } from "@/features/setup/StepFrame";
import type { SetupStepMeta } from "@/features/setup/steps";
import type { RunnerKind, RunnerStatus, SetupState } from "@/api/types";

const CHOICES: { kind: RunnerKind; title: string; blurb: string }[] = [
  {
    kind: "local",
    title: "This machine's Docker",
    blurb:
      "The runner is built on the same Docker daemon that this server can reach. Nothing else to configure.",
  },
  {
    kind: "ssh",
    title: "A remote host over SSH",
    blurb:
      "Keep the web UI small and put the heavy container on another box. vibehub drives its Docker over an SSH connection.",
  },
];

/**
 * Step 2 — decide where the container that actually runs the agents will live, write it to
 * settings, then provision it while streaming the build output.
 */
export function RunnerStep({
  meta,
  runner,
  onDone,
}: {
  meta: SetupStepMeta;
  runner: RunnerStatus | undefined;
  onDone: () => Promise<void>;
}) {
  const [kind, setKind] = React.useState<RunnerKind>("local");
  const [host, setHost] = React.useState("");
  const [user, setUser] = React.useState("root");
  const [keyPath, setKeyPath] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [provisioning, setProvisioning] = React.useState(false);
  const { lines, connection, append, clear } = useRunnerLogs(provisioning);

  const needsSsh = kind === "ssh";
  const sshReady = host.trim().length > 0 && user.trim().length > 0;
  const canProvision = (!needsSsh || sshReady) && !provisioning;

  async function onProvision() {
    setError(null);
    clear();
    setProvisioning(true);
    try {
      await patch("/settings", {
        runner:
          kind === "ssh"
            ? { kind, host: host.trim(), user: user.trim(), keyPath: keyPath.trim() || undefined }
            : { kind },
      });
      append("Settings saved. Provisioning the runner…");
      await post("/runner/provision");
      // Provisioning is idempotent and reports through the socket; confirm with a fresh read so
      // the UI never claims success the server would not.
      const state = await get<SetupState>("/setup/state");
      if (state.steps?.runner) {
        append("Runner is up.");
        await onDone();
        return;
      }
      setError(
        state.runner?.detail ??
          "The runner did not come up. Check the output above and try again.",
      );
    } catch (err) {
      setError(apiErrorMessage(err, "Provisioning failed"));
    } finally {
      setProvisioning(false);
    }
  }

  return (
    <StepFrame
      title={meta.title}
      why={meta.why}
      footer={
        <>
          <Button type="button" onClick={onProvision} disabled={!canProvision}>
            {provisioning ? "Provisioning…" : "Provision the runner"}
          </Button>
          {runner ? <RunnerBadges runner={runner} /> : null}
        </>
      }
    >
      <fieldset className="grid gap-3 sm:grid-cols-2" disabled={provisioning}>
        <legend className="sr-only">Runner location</legend>
        {CHOICES.map((choice) => {
          const selected = kind === choice.kind;
          return (
            <label
              key={choice.kind}
              className={cn(
                "flex cursor-pointer flex-col gap-1.5 rounded-lg border p-4 transition-colors",
                selected
                  ? "border-primary/60 bg-primary/5"
                  : "border-border bg-card/40 hover:border-border/60 hover:bg-accent/40",
              )}
            >
              <span className="flex items-center gap-2">
                <input
                  type="radio"
                  name="runner-kind"
                  className="accent-[hsl(var(--primary))]"
                  value={choice.kind}
                  checked={selected}
                  onChange={() => setKind(choice.kind)}
                />
                <span className="text-sm font-medium">{choice.title}</span>
              </span>
              <span className="text-xs leading-relaxed text-muted-foreground">{choice.blurb}</span>
            </label>
          );
        })}
      </fieldset>

      {needsSsh ? (
        <div className="grid gap-4 sm:max-w-lg sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="runner-host">Host</Label>
            <Input
              id="runner-host"
              placeholder="10.0.0.20"
              spellCheck={false}
              className="font-mono"
              value={host}
              onChange={(e) => setHost(e.target.value)}
              disabled={provisioning}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="runner-user">SSH user</Label>
            <Input
              id="runner-user"
              spellCheck={false}
              className="font-mono"
              value={user}
              onChange={(e) => setUser(e.target.value)}
              disabled={provisioning}
            />
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="runner-key">Private key path</Label>
            <Input
              id="runner-key"
              placeholder="~/.ssh/id_ed25519"
              spellCheck={false}
              className="font-mono"
              value={keyPath}
              onChange={(e) => setKeyPath(e.target.value)}
              disabled={provisioning}
              aria-describedby="runner-key-hint"
            />
            <p id="runner-key-hint" className="text-xs text-muted-foreground">
              Path on this server, not on your laptop. Leave blank to use the default SSH agent.
            </p>
          </div>
        </div>
      ) : null}

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Label>Provisioning output</Label>
          <span className="font-mono text-[11px] text-muted-foreground">
            {connection === "open"
              ? "streaming"
              : connection === "connecting"
                ? "connecting…"
                : "idle"}
          </span>
        </div>
        <LogBox lines={lines} empty="Output appears here once provisioning starts." />
      </div>

      <StepError message={error} />
    </StepFrame>
  );
}

function RunnerBadges({ runner }: { runner: RunnerStatus }) {
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      <Badge tone={runner.dockerReachable ? "ok" : "critical"}>
        docker {runner.dockerReachable ? "reachable" : "unreachable"}
      </Badge>
      <Badge tone={runner.running ? "ok" : runner.exists ? "warn" : "muted"}>
        {runner.running ? "running" : runner.exists ? "stopped" : "no container"}
      </Badge>
      {runner.container ? <Badge tone="muted">{runner.container}</Badge> : null}
    </span>
  );
}
