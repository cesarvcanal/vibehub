import * as React from "react";
import { Navigate, useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { useAuth } from "@/providers/auth";
import { Paths } from "@/lib/paths";
import { Logo } from "@/components/Logo";
import { FullScreenLoader } from "@/components/FullScreenLoader";
import { StepRail } from "@/features/setup/StepFrame";
import { OwnerStep } from "@/features/setup/steps/OwnerStep";
import { RunnerStep } from "@/features/setup/steps/RunnerStep";
import { GithubStep } from "@/features/setup/steps/GithubStep";
import { ClaudeStep } from "@/features/setup/steps/ClaudeStep";
import { DoneStep } from "@/features/setup/steps/DoneStep";
import {
  SETUP_STEPS,
  currentStep,
  shouldRunWizard,
  type SetupStepId,
  type WizardOverrides,
} from "@/features/setup/steps";

function metaFor(id: SetupStepId) {
  // SETUP_STEPS covers every SetupStepId, so this always resolves; the fallback keeps TS honest
  // about the array lookup rather than asserting non-null.
  return SETUP_STEPS.find((s) => s.id === id) ?? SETUP_STEPS[0]!;
}

/**
 * First-run experience.
 *
 * The current step is *derived* from `GET /api/setup/state` on every render — no step counter is
 * kept in component state. Refresh mid-setup, come back tomorrow, or open it in a second tab: the
 * server's answer decides, so progress is never lost and never double-counted.
 */
export function SetupWizard() {
  const navigate = useNavigate();
  const { setup, isLoading, refreshSetup, refreshSession } = useAuth();
  const [overrides, setOverrides] = React.useState<WizardOverrides>({});

  const step = currentStep(setup, overrides);
  const meta = metaFor(step);

  const advance = React.useCallback(async () => {
    // Both probes: creating the owner also signs you in, so the session is stale too.
    await Promise.all([refreshSetup(), refreshSession()]);
  }, [refreshSetup, refreshSession]);

  const skipGithub = React.useCallback(() => {
    setOverrides((prev) => ({ ...prev, githubSkipped: true }));
    toast("GitHub skipped — you can connect it later from Settings.");
  }, []);

  const finish = React.useCallback(() => {
    navigate(Paths.BOARD, { replace: true });
  }, [navigate]);

  if (isLoading && !setup) return <FullScreenLoader label="Reading setup state" />;

  // Somebody navigated here on a finished install: send them where they meant to go.
  if (!shouldRunWizard(setup)) return <Navigate to={Paths.BOARD} replace />;

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-5xl flex-col px-6 py-10">
      <header className="mb-8 flex items-baseline justify-between gap-4">
        <Logo />
        <p className="font-mono text-xs text-muted-foreground">first-run setup</p>
      </header>

      <div className="grid flex-1 gap-8 md:grid-cols-[15rem_minmax(0,1fr)]">
        <aside className="md:border-r md:border-border/70 md:pr-6">
          <StepRail current={step} />
        </aside>

        <div className="panel min-w-0 p-6">
          {step === "owner" ? <OwnerStep meta={meta} onDone={advance} /> : null}
          {step === "runner" ? (
            <RunnerStep meta={meta} runner={setup?.runner} onDone={advance} />
          ) : null}
          {step === "github" ? (
            <GithubStep meta={meta} onDone={advance} onSkip={skipGithub} />
          ) : null}
          {step === "claude" ? (
            <ClaudeStep meta={meta} container={setup?.runner?.container} onDone={advance} />
          ) : null}
          {step === "done" ? <DoneStep meta={meta} onFinish={finish} /> : null}
        </div>
      </div>
    </main>
  );
}

export default SetupWizard;
