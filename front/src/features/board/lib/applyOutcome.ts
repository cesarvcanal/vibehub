import type { ApplyOutcome } from "@/api/types";
import { t } from "@/i18n";

/**
 * The one sentence that explains what a brain/MCP write actually did.
 *
 * Saving is not just persisting: the server rewrites the configuration in every runner profile and
 * restarts the terminals it can. A card that is mid-turn is never interrupted — it is flagged and
 * picks the change up when it finishes. That deferral is invisible unless we say it out loud, and a
 * silent "Saved." is what makes someone save twice and then wonder why nothing changed.
 *
 * Pure, so the wording is a test rather than a screenshot.
 */
export function applyOutcomeMessage(outcome: ApplyOutcome | undefined, subject: string): string {
  const restarted = countOf(outcome?.restarted);
  const pending = countOf(outcome?.pending);

  // `applied === false` is the server telling us the push itself failed (a runner was down). The
  // text is saved either way, so say so, and point at the manual re-push rather than at an error.
  if (outcome?.applied === false) {
    return t("applyOutcome.notPushed", { subject });
  }

  // No counts at all: an older server, or nothing running. Do not invent a number.
  if (outcome?.restarted === undefined && outcome?.pending === undefined) {
    return t("applyOutcome.savedApplied", { subject });
  }

  const now = t("applyOutcome.now", { n: restarted });
  if (pending === 0) return t("applyOutcome.saved", { subject, now });
  // Subject and verb agree together: "it finishes" / "they finish".
  return t("applyOutcome.savedPending", { subject, now, pending, n: pending });
}

function countOf(value: number | undefined): number {
  return Number.isFinite(value) ? (value as number) : 0;
}
