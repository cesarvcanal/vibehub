/**
 * WHAT TO SAY WHILE THE TURN RUNS — the verb and the status note of the work indicator.
 *
 * The problem: "Trabalhando…" is the SAME word at second 2 and at minute 9. Whoever looks at the
 * screen does not know whether the agent is thinking, running a tool or stuck — and that was the
 * complaint: with no visual feedback, a long turn looks like a dead screen. Claude Code's terminal
 * solves this with two pieces: a verb that CHANGES (the proof that the thing is alive) and a tail
 * that ESCALATES with time ("thinking" → "still thinking"), next to the clock.
 *
 * Here it is the same idea, and it is PURE: in goes what is happening and for how many seconds, out
 * come the i18n KEYS. No Date.now(), no random — the same second always gives the same phrase, and
 * the test runs with no clock and no language.
 */

/** What the turn is doing now, at the granularity the indicator knows how to name. */
export type WorkingKind = "preparing" | "thinking" | "answering" | "tool" | "working";

export interface WorkingStage {
  /** Key of the verb (what shows up in place of the old "Trabalhando…"). */
  verb: string;
  /** Key of the status note, the tail that goes along with the clock ("ainda pensando"). */
  note: string;
}

/**
 * How often the verb changes. Too short becomes a flicker; too long goes back to looking frozen.
 * 12s lets the change happen twice before the note's first escalation.
 */
export const VERB_ROTATE_SECONDS = 12;
/** From here on the note becomes "ainda …" — the turn stopped being quick. */
export const STILL_AFTER_SECONDS = 20;
/** And from here on it becomes "há bastante tempo" — it really is long, and saying so is honest. */
export const LONG_AFTER_SECONDS = 90;

/**
 * The verbs of each phase, in the order they take turns. A phase with a single verb (preparing) never
 * changes: inventing a synonym for a boot wait tells nothing.
 */
const VERBS: Record<WorkingKind, readonly string[]> = {
  preparing: ["sdk.preparing"],
  thinking: ["sdk.verb.thinking", "sdk.verb.reasoning", "sdk.verb.pondering"],
  answering: ["sdk.verb.answering", "sdk.verb.writing"],
  tool: ["sdk.verb.running", "sdk.verb.working"],
  working: ["sdk.verb.working", "sdk.verb.running"],
};

/**
 * The verb and the note for this instant. A negative or broken `seconds` is treated as 0 (the view's
 * clock is an integer, but this function does not depend on that). PURE, TOTAL.
 */
export function workingStage(kind: WorkingKind, seconds: number): WorkingStage {
  const elapsed = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
  const verbs = VERBS[kind];
  const verb = verbs[Math.floor(elapsed / VERB_ROTATE_SECONDS) % verbs.length] as string;
  const stage = elapsed >= LONG_AFTER_SECONDS ? "Long" : elapsed >= STILL_AFTER_SECONDS ? "Still" : "";
  return { verb, note: `sdk.note.${kind}${stage}` };
}
