import * as React from "react";
import { get } from "@/lib/api";
import { apiErrorMessage } from "@/lib/apiError";
import { Button } from "@/components/ui/button";
import { StepError, StepFrame } from "@/features/setup/StepFrame";
import type { SetupStepMeta } from "@/features/setup/steps";
import type { SetupState } from "@/api/types";

/**
 * Step 4 — the sign-in itself happens inside the runner, not here. This step explains how and
 * then re-checks the server until it agrees Claude is ready.
 */
export function ClaudeStep({
  meta,
  container,
  onDone,
}: {
  meta: SetupStepMeta;
  container: string | undefined;
  onDone: () => Promise<void>;
}) {
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const name = container || "vibehub-runner";

  async function recheck() {
    setBusy(true);
    setError(null);
    try {
      const state = await get<SetupState>("/setup/state");
      if (state.steps?.claude) {
        await onDone();
        return;
      }
      setError("Still not signed in. Finish `claude` in the runner, then check again.");
    } catch (err) {
      setError(apiErrorMessage(err, "Could not read the setup state"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <StepFrame
      title={meta.title}
      why={meta.why}
      footer={
        <Button type="button" onClick={recheck} disabled={busy}>
          {busy ? "Checking…" : "I've signed in — check again"}
        </Button>
      }
    >
      <ol className="space-y-3 text-sm leading-relaxed text-muted-foreground">
        <li className="flex gap-3">
          <span className="kbd mt-0.5">1</span>
          <span>
            Open a shell in the runner:
            <code className="terminal-surface mt-1.5 block px-3 py-2">docker exec -it {name} claude</code>
          </span>
        </li>
        <li className="flex gap-3">
          <span className="kbd mt-0.5">2</span>
          <span>
            Follow the browser prompt it prints. The login is stored inside the container, so it
            survives restarts and every card reuses it.
          </span>
        </li>
        <li className="flex gap-3">
          <span className="kbd mt-0.5">3</span>
          <span>Come back here and check again.</span>
        </li>
      </ol>

      <p className="max-w-prose rounded border border-border bg-card/40 p-3 text-sm leading-relaxed text-muted-foreground">
        Running more than one Claude login? Later, each account on the Accounts screen gets its own
        isolated profile inside the runner, and you can paste a long-lived token per account instead
        of doing the browser dance again.
      </p>

      <StepError message={error} />
    </StepFrame>
  );
}
