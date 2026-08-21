import { describe, expect, it } from "vitest";
import {
  SETUP_STEPS,
  currentStep,
  isSetupComplete,
  shouldRunWizard,
  stepIndex,
  stepStates,
} from "@/features/setup/steps";
import type { SetupState } from "@/api/types";

function state(steps: Partial<SetupState["steps"]>, fresh = false): SetupState {
  return {
    fresh,
    steps: { owner: false, runner: false, claude: false, github: false, ...steps },
    runner: {
      running: false,
      exists: false,
      claudeInstalled: false,
      dockerReachable: true,
      container: "vibehub-runner",
    },
  };
}

describe("currentStep", () => {
  it("starts at owner when the server has not answered yet", () => {
    expect(currentStep(undefined)).toBe("owner");
  });

  it("starts at owner on a fresh install", () => {
    expect(currentStep(state({}, true))).toBe("owner");
  });

  it("moves to runner once the owner exists", () => {
    expect(currentStep(state({ owner: true }))).toBe("runner");
  });

  it("moves to github once the runner is up", () => {
    expect(currentStep(state({ owner: true, runner: true }))).toBe("github");
  });

  it("moves to claude when github is already connected", () => {
    expect(currentStep(state({ owner: true, runner: true, github: true }))).toBe("claude");
  });

  it("moves past github when it was skipped", () => {
    const s = state({ owner: true, runner: true });
    expect(currentStep(s, { githubSkipped: true })).toBe("claude");
  });

  it("reports done when everything is configured", () => {
    expect(currentStep(state({ owner: true, runner: true, github: true, claude: true }))).toBe("done");
  });

  it("reports done when github was skipped and the rest is configured", () => {
    const s = state({ owner: true, runner: true, claude: true });
    expect(currentStep(s, { githubSkipped: true })).toBe("done");
  });

  it("does not skip an earlier unfinished step because a later one is done", () => {
    // The server can report claude:true (a token was planted) before the runner exists.
    expect(currentStep(state({ claude: true, github: true }))).toBe("owner");
    expect(currentStep(state({ owner: true, claude: true, github: true }))).toBe("runner");
  });

  it("is resumable: the same server state always yields the same step", () => {
    const s = state({ owner: true, runner: true, github: true });
    expect(currentStep(s)).toBe(currentStep(s));
    expect(currentStep(s)).toBe("claude");
  });
});

describe("isSetupComplete", () => {
  it("is false while anything is missing", () => {
    expect(isSetupComplete(state({ owner: true, runner: true }))).toBe(false);
  });

  it("is true once every step is satisfied", () => {
    expect(isSetupComplete(state({ owner: true, runner: true, github: true, claude: true }))).toBe(
      true,
    );
  });

  it("is true when the only gap is a skipped github", () => {
    expect(isSetupComplete(state({ owner: true, runner: true, claude: true }), { githubSkipped: true })).toBe(
      true,
    );
  });
});

describe("shouldRunWizard", () => {
  it("runs when there is no state yet", () => {
    expect(shouldRunWizard(undefined)).toBe(true);
  });

  it("runs on a fresh install", () => {
    expect(shouldRunWizard(state({}, true))).toBe(true);
  });

  it("runs when a required step is still missing", () => {
    expect(shouldRunWizard(state({ owner: true, github: true }))).toBe(true);
  });

  it("does not run when only the optional github step is missing", () => {
    expect(shouldRunWizard(state({ owner: true, runner: true, claude: true }))).toBe(false);
  });

  it("does not run on a fully configured install", () => {
    expect(shouldRunWizard(state({ owner: true, runner: true, claude: true, github: true }))).toBe(
      false,
    );
  });
});

describe("step metadata", () => {
  it("gives every step a title and a reason it exists", () => {
    for (const step of SETUP_STEPS) {
      expect(step.title.length).toBeGreaterThan(0);
      expect(step.why.length).toBeGreaterThan(20);
    }
  });

  it("orders the steps owner → runner → github → claude → done", () => {
    expect(SETUP_STEPS.map((s) => s.id)).toEqual(["owner", "runner", "github", "claude", "done"]);
  });

  it("marks only github as optional", () => {
    expect(SETUP_STEPS.filter((s) => s.optional).map((s) => s.id)).toEqual(["github"]);
  });

  it("indexes steps by position", () => {
    expect(stepIndex("owner")).toBe(0);
    expect(stepIndex("done")).toBe(4);
  });
});

describe("stepStates", () => {
  it("marks earlier steps done, the current one current, later ones todo", () => {
    expect(stepStates("github")).toEqual({
      owner: "done",
      runner: "done",
      github: "current",
      claude: "todo",
      done: "todo",
    });
  });

  it("marks everything before done as done", () => {
    const states = stepStates("done");
    expect(states.owner).toBe("done");
    expect(states.claude).toBe("done");
    expect(states.done).toBe("current");
  });
});
