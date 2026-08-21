import { describe, expect, it } from "vitest";
import { applyOutcomeMessage } from "@/features/board/lib/applyOutcome";

/**
 * The deferred restart is the part a user cannot see. If the copy does not mention it, saving the
 * brain looks like it did nothing to the terminals that were busy — and the natural response to
 * "nothing happened" is to save again.
 */
describe("applyOutcomeMessage", () => {
  it("reports what restarted now and what will restart later", () => {
    expect(applyOutcomeMessage({ applied: true, restarted: 3, pending: 2 }, "Brain")).toBe(
      "Brain saved — applied to 3 terminals, 2 will update when they finish.",
    );
  });

  it("says nothing about later when nothing was deferred", () => {
    expect(applyOutcomeMessage({ applied: true, restarted: 4, pending: 0 }, "Brain")).toBe(
      "Brain saved — applied to 4 terminals.",
    );
  });

  it("keeps the grammar right for a single terminal on either side", () => {
    expect(applyOutcomeMessage({ applied: true, restarted: 1, pending: 1 }, "Brain")).toBe(
      "Brain saved — applied to 1 terminal, 1 will update when it finishes.",
    );
  });

  it("counts zero rather than staying silent when the server sent counts", () => {
    expect(applyOutcomeMessage({ applied: true, restarted: 0, pending: 0 }, "Brain")).toBe(
      "Brain saved — applied to 0 terminals.",
    );
  });

  it("points at the manual re-push when the server could not apply it", () => {
    expect(applyOutcomeMessage({ applied: false, restarted: 0, pending: 0 }, "Brain")).toMatch(
      /saved, but it could not be pushed to the runner — use “Apply everywhere”\./,
    );
  });

  it("invents no numbers for a server that sends none", () => {
    // An older back-end, or one that has not shipped the pending flag yet.
    expect(applyOutcomeMessage({ applied: true }, "Brain")).toBe("Brain saved and applied.");
    expect(applyOutcomeMessage(undefined, "Brain")).toBe("Brain saved and applied.");
  });

  it("takes the subject from the caller, so MCPs and the brain share one sentence", () => {
    expect(applyOutcomeMessage({ applied: true, restarted: 2, pending: 1 }, "MCP servers")).toBe(
      "MCP servers saved — applied to 2 terminals, 1 will update when it finishes.",
    );
  });
});
