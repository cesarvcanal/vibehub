import * as React from "react";
import { get } from "@/lib/api";
import { apiErrorMessage } from "@/lib/apiError";
import { Button } from "@/components/ui/button";
import { StepError, StepFrame } from "@/features/setup/StepFrame";
import type { SetupStepMeta } from "@/features/setup/steps";
import type { SetupState } from "@/api/types";
import { useT } from "@/i18n";

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
  const t = useT();
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
      setError(t("setup.claude.stillNot"));
    } catch (err) {
      setError(apiErrorMessage(err, t("setup.claude.readError")));
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
          {busy ? t("common.checking") : t("setup.claude.checkAgain")}
        </Button>
      }
    >
      <ol className="space-y-3 text-sm leading-relaxed text-muted-foreground">
        <li className="flex gap-3">
          <span className="kbd mt-0.5">1</span>
          <span>
            {t("setup.claude.step1")}
            <code className="terminal-surface mt-1.5 block px-3 py-2">docker exec -it {name} claude</code>
          </span>
        </li>
        <li className="flex gap-3">
          <span className="kbd mt-0.5">2</span>
          <span>
            {t("setup.claude.step2")}
          </span>
        </li>
        <li className="flex gap-3">
          <span className="kbd mt-0.5">3</span>
          <span>{t("setup.claude.step3")}</span>
        </li>
      </ol>

      <p className="max-w-prose rounded border border-border bg-card/40 p-3 text-sm leading-relaxed text-muted-foreground">
        {t("setup.claude.note")}
      </p>

      <StepError message={error} />
    </StepFrame>
  );
}
