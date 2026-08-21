import * as React from "react";
import { cn } from "@/lib/utils";
import { SETUP_STEPS, stepStates, type SetupStepId } from "@/features/setup/steps";

/** The numbered rail down the side. Shows where you are without pretending to be clickable. */
export function StepRail({ current }: { current: SetupStepId }) {
  const states = stepStates(current);
  return (
    <ol className="space-y-1" aria-label="Setup steps">
      {SETUP_STEPS.map((step, idx) => {
        const state = states[step.id];
        return (
          <li
            key={step.id}
            aria-current={state === "current" ? "step" : undefined}
            className={cn(
              "flex items-center gap-3 rounded px-2 py-1.5 text-sm",
              state === "current" && "bg-accent/70 text-foreground",
              state !== "current" && "text-muted-foreground",
            )}
          >
            <span
              className={cn(
                "flex h-5 w-5 shrink-0 items-center justify-center rounded border font-mono text-[11px]",
                state === "done" && "border-emerald-500/40 bg-emerald-500/10 text-emerald-400",
                state === "current" && "border-primary/60 bg-primary/10 text-primary",
                state === "todo" && "border-border text-muted-foreground",
              )}
            >
              {state === "done" ? "✓" : idx + 1}
            </span>
            <span className="truncate">{step.title}</span>
          </li>
        );
      })}
    </ol>
  );
}

/** Title + the one line explaining why the step exists, then the step's own controls. */
export function StepFrame({
  title,
  why,
  children,
  footer,
}: {
  title: string;
  why: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
}) {
  return (
    <section className="space-y-5">
      <header className="space-y-1.5">
        <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
        <p className="max-w-prose text-sm leading-relaxed text-muted-foreground">{why}</p>
      </header>
      <div className="space-y-4">{children}</div>
      {footer ? <div className="flex flex-wrap items-center gap-2 pt-1">{footer}</div> : null}
    </section>
  );
}

/** Inline error banner shared by every step. */
export function StepError({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p
      role="alert"
      className="rounded border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
    >
      {message}
    </p>
  );
}
