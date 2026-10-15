import type { Card, Project } from "../board/registry.js";
import { cardWorkPaths } from "../board/workspace.js";
import { profileDirFor } from "../accounts/profiles.js";
import { seedDestDir } from "../import/import.js";

/*
 * What every reader of a card's runner session agrees on: where its transcripts live and how a
 * vanished tmux session is reported. A leaf on purpose: the chat, the SDK resume and the maestro
 * all import it, and the maestro also imports the SDK manager, which imports the chat.
 */

/**
 * Where a card's Claude transcripts live INSIDE the runner: the account profile's `projects/`
 * directory for that card's cwd. Every reader of a transcript — the maestro, the model pill, the
 * chat view — derives the path here, so they can never disagree about which file is the session.
 * PURE.
 */
export function transcriptDirFor(project: Project, card: Card, accountSlug?: string | null): string {
  const profileDir = profileDirFor(accountSlug ?? undefined);
  return seedDestDir(profileDir, cardWorkPaths(project, card).cwd);
}

/**
 * A tmux session can disappear underneath the board — the runner restarted, someone killed it —
 * while the card still looks live (it was opened and never paused). tmux then answers with its own
 * wording ("no server running", "can't find session"), which tells a coordinating agent nothing
 * about what to do. Translate it into the action that fixes it: open the card, which recreates the
 * session through the same attach-or-create the terminal uses. PURE.
 */
export function sessionGoneError(err: unknown, title: string): Error {
  const detail = (err as Error)?.message ?? String(err);
  if (/no server running|can't find session|session not found/i.test(detail)) {
    return new Error(
      `the terminal for card "${title}" is gone in the runner (the session died or the runner restarted) — ` +
      "open the card to recreate it, then send the instruction again",
    );
  }
  return err instanceof Error ? err : new Error(detail);
}
