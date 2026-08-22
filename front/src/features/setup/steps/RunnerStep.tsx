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
import { useT } from "@/i18n";

const CHOICES: { kind: RunnerKind; titleKey: string; blurbKey: string }[] = [
  { kind: "local", titleKey: "setup.runner.local.title", blurbKey: "setup.runner.local.blurb" },
  { kind: "ssh", titleKey: "setup.runner.ssh.title", blurbKey: "setup.runner.ssh.blurb" },
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
  const t = useT();
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
      append(t("setup.runner.saved"));
      await post("/runner/provision");
      // Provisioning is idempotent and reports through the socket; confirm with a fresh read so
      // the UI never claims success the server would not.
      const state = await get<SetupState>("/setup/state");
      if (state.steps?.runner) {
        append(t("setup.runner.up"));
        await onDone();
        return;
      }
      setError(
        state.runner?.detail ?? t("setup.runner.didNotComeUp"),
      );
    } catch (err) {
      setError(apiErrorMessage(err, t("setup.runner.failed")));
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
            {provisioning ? t("setup.runner.provisioning") : t("setup.runner.provision")}
          </Button>
          {runner ? <RunnerBadges runner={runner} t={t} /> : null}
        </>
      }
    >
      <fieldset className="grid gap-3 sm:grid-cols-2" disabled={provisioning}>
        <legend className="sr-only">{t("setup.runner.legend")}</legend>
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
                <span className="text-sm font-medium">{t(choice.titleKey)}</span>
              </span>
              <span className="text-xs leading-relaxed text-muted-foreground">{t(choice.blurbKey)}</span>
            </label>
          );
        })}
      </fieldset>

      {needsSsh ? (
        <div className="grid gap-4 sm:max-w-lg sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="runner-host">{t("setup.runner.host")}</Label>
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
            <Label htmlFor="runner-user">{t("setup.runner.user")}</Label>
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
            <Label htmlFor="runner-key">{t("setup.runner.keyPath")}</Label>
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
              {t("setup.runner.keyHint")}
            </p>
          </div>
        </div>
      ) : null}

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Label>{t("setup.runner.output")}</Label>
          <span className="font-mono text-[11px] text-muted-foreground">
            {connection === "open"
              ? t("setup.runner.streaming")
              : connection === "connecting"
                ? t("setup.runner.connecting")
                : t("setup.runner.idle")}
          </span>
        </div>
        <LogBox lines={lines} empty={t("setup.runner.logEmpty")} />
      </div>

      <StepError message={error} />
    </StepFrame>
  );
}

function RunnerBadges({ runner, t }: { runner: RunnerStatus; t: (key: string) => string }) {
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      <Badge tone={runner.dockerReachable ? "ok" : "critical"}>
        {runner.dockerReachable ? t("setup.runner.badge.dockerOk") : t("setup.runner.badge.dockerBad")}
      </Badge>
      <Badge tone={runner.running ? "ok" : runner.exists ? "warn" : "muted"}>
        {runner.running
          ? t("setup.runner.badge.running")
          : runner.exists
            ? t("setup.runner.badge.stopped")
            : t("setup.runner.badge.noContainer")}
      </Badge>
      {runner.container ? <Badge tone="muted">{runner.container}</Badge> : null}
    </span>
  );
}
