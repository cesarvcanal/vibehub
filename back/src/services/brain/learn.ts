import { getCard, getProject } from "../board/registry.js";
import { applyProjectBrainEverywhere } from "../board/workspace.js";
import { appendProjectLearning } from "./brain.js";
import { logger } from "../../utils/logger.js";

/**
 * `vibehub_brain_learn` — the ONE write path an agent has into a brain, and it is deliberately
 * narrow: the learning is routed to the PROJECT of the calling card and APPENDED (dated bullet) to
 * that project brain's `## Aprendizados` section. It can never touch anything else — appendLearning
 * is append-only by construction (see brain.ts), so a prompt-injected "learning" cannot rewrite the
 * rules; at worst it adds one line the operator prunes on the Brain screen.
 *
 * After a successful append the file is re-written in the project's worktrees right away
 * (BEST-EFFORT — a runner that is down must not lose the learning, which is already persisted).
 * No restart: a learning is not urgent enough to bounce terminals — sessions pick it up on their
 * next start.
 */
export interface LearnResult {
  added: boolean;
  /** The exact line recorded (or the one that already existed, when `added` is false). */
  entry: string;
  project: string;
  note: string;
}

export async function recordLearning(cardId: string, learning: string, by?: string): Promise<LearnResult> {
  const card = await getCard(String(cardId ?? "").trim());
  if (!card) throw new Error("card not found — pass your OWN card id ($VIBEHUB_CARD_ID)");
  const project = await getProject(card.projectId);
  if (!project) throw new Error("project for this card not found");

  const { added, entry } = await appendProjectLearning(project.id, learning, by);
  if (!added) {
    return { added, entry, project: project.name, note: "already recorded (identical text) — nothing changed" };
  }

  let note = "recorded; sessions read it on their next start";
  try {
    await applyProjectBrainEverywhere(project.id, by);
  } catch (e) {
    // The learning is persisted — only the immediate file rewrite failed.
    logger.warn(
      { card: card.worktreeSlug, project: project.id, detail: (e as Error).message },
      "learning saved but not written to the worktrees yet (best-effort)",
    );
    note = "recorded; the worktree files could not be refreshed now — the next card open writes them";
  }
  return { added, entry, project: project.name, note };
}
