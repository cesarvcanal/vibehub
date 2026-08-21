import type { SetupState } from "@/api/types";

/**
 * The first-run wizard, as data.
 *
 * Every step is derived from `GET /api/setup/state`, never from local component state. That is
 * the whole trick behind resumability: reload the page halfway through, the server still knows
 * the owner exists and the runner is up, so you land back on the step you were on.
 */
export type SetupStepId = "owner" | "runner" | "github" | "claude" | "done";

export interface SetupStepMeta {
  id: SetupStepId;
  title: string;
  /** One line saying why this step exists at all. Shown under the title. */
  why: string;
  /** Steps you are allowed to walk past without finishing. */
  optional?: boolean;
}

export const SETUP_STEPS: readonly SetupStepMeta[] = [
  {
    id: "owner",
    title: "Create the owner account",
    why: "vibehub hands out live shells, so it can never be open to whoever finds the port. This first account owns the install and is the only way in.",
  },
  {
    id: "runner",
    title: "Choose where the runner lives",
    why: "Agents run inside a Docker container called the runner — not on your laptop and not in this web process. Pick the Docker daemon it should be built on.",
  },
  {
    id: "github",
    title: "Connect GitHub",
    why: "A token lets vibehub list your repositories and clone them into card worktrees. Skip it and you can still point projects at any git URL by hand.",
    optional: true,
  },
  {
    id: "claude",
    title: "Sign in to Claude",
    why: "The runner needs its own Claude login — the agents authenticate as you, inside the container, not through this browser.",
  },
  {
    id: "done",
    title: "You're set",
    why: "Everything the board needs is in place.",
  },
] as const;

/** Local, non-server decisions the wizard has to remember while it is open. */
export interface WizardOverrides {
  /** The operator pressed "Skip for now" on the optional GitHub step. */
  githubSkipped?: boolean;
}

/**
 * Which step the wizard should be showing.
 *
 * Pure on purpose: given the server's state (plus the one thing the server cannot know — that
 * you chose to skip GitHub), there is exactly one answer, and no component has to remember it.
 */
export function currentStep(
  state: SetupState | undefined,
  overrides: WizardOverrides = {},
): SetupStepId {
  // No answer from the server yet: the only safe assumption is "nothing is done".
  if (!state) return "owner";
  const steps = state.steps;
  if (!steps?.owner) return "owner";
  if (!steps.runner) return "runner";
  if (!steps.github && !overrides.githubSkipped) return "github";
  if (!steps.claude) return "claude";
  return "done";
}

/** Index of a step in the displayed sequence, for the progress rail. */
export function stepIndex(id: SetupStepId): number {
  const i = SETUP_STEPS.findIndex((s) => s.id === id);
  return i < 0 ? 0 : i;
}

export type StepState = "done" | "current" | "todo";

/**
 * Status of every step for the progress rail. A step before the current one counts as done even
 * when it was skipped — you walked past it, and you can come back through the board later.
 */
export function stepStates(current: SetupStepId): Record<SetupStepId, StepState> {
  const currentIdx = stepIndex(current);
  const out = {} as Record<SetupStepId, StepState>;
  SETUP_STEPS.forEach((step, idx) => {
    out[step.id] = idx < currentIdx ? "done" : idx === currentIdx ? "current" : "todo";
  });
  return out;
}

/** True once there is nothing left to configure and the board is reachable. */
export function isSetupComplete(
  state: SetupState | undefined,
  overrides: WizardOverrides = {},
): boolean {
  return currentStep(state, overrides) === "done";
}

/**
 * Should this wizard be shown at all? A finished install that somebody navigates to /setup by
 * hand should bounce to the board rather than re-run the first-run flow.
 */
export function shouldRunWizard(state: SetupState | undefined): boolean {
  if (!state) return true;
  if (state.fresh) return true;
  return !(state.steps?.owner && state.steps?.runner && state.steps?.claude);
}
