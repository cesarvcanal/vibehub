import { shQuote, assertSafeRemotePath } from "../../runtime/host.js";
import { parseChatEvents } from "../chat/chat.js";
import type { Card } from "../board/registry.js";
import type { HistoryEvent } from "./history.js";

/**
 * TUI ↔ SDK BRIDGE — what makes the "Chat nativo (beta)" toggle CONTINUE the card's conversation
 * instead of abandoning it.
 *
 * A card that lived in the terminal/old chat has its whole conversation in the Claude Code
 * transcript (`~/.claude/projects/<cwd-slug>/<sessionId>.jsonl` inside the runner). Flipping the
 * toggle used to open an SDK chat that (a) showed an empty screen and (b) started a brand-new
 * session with no memory — the conversation "sumia". Two answers, both from the same probe:
 *
 *  - **Display**: the newest transcript's tail is converted into SDK replay frames and sent before
 *    the card's own SDK history, so the previous conversation is ON SCREEN in the native chat.
 *  - **Context**: the newest transcript's file name IS a session id, and the SDK's `resume` option
 *    drives the same Claude Code session store the TUI uses — so the driver resumes it and the
 *    first native answer knows everything the terminal conversation knew. (Toggling back OFF needs
 *    nothing: the SDK session writes its transcript into the same directory, `claude -c` and the
 *    old chat's newest-file rule pick it right up.)
 */

/** How many transcript lines one connect converts. Matches the old chat's replay window. */
export const TUI_TAIL_LINES = 400;

/** Session ids are UUIDs minted by Claude Code — anything else is not a resume target. */
const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Read-only probe: the newest transcript's SESSION ID (its basename) on the first line, then its
 * tail. `|| true` on purpose — no transcript yet is an empty answer, not an error. PURE.
 */
export function buildLatestTranscriptScript(
  containerName: string,
  transcriptDir: string,
  tailLines: number = TUI_TAIL_LINES,
): string {
  assertSafeRemotePath(transcriptDir);
  const n = Math.max(1, Math.min(5000, Math.floor(tailLines) || TUI_TAIL_LINES));
  const inner =
    `f=$(ls -1t "$1"/*.jsonl 2>/dev/null | head -1); ` +
    `if [ -n "$f" ]; then basename "$f" .jsonl; tail -n ${n} "$f"; fi; true`;
  return `docker exec ${shQuote(containerName)} sh -c ${shQuote(inner)} _ ${shQuote(transcriptDir)}`;
}

export interface LatestTranscript {
  /** The newest session's id (the resume target), or null when there is no transcript yet. */
  sessionId: string | null;
  /** The tail of that session's JSONL. */
  jsonl: string;
}

/** Split the probe's output: first line = session id (validated), the rest = the JSONL tail. PURE. */
export function parseLatestTranscript(stdout: string): LatestTranscript {
  const raw = String(stdout ?? "");
  if (raw.trim() === "") return { sessionId: null, jsonl: "" };
  const nl = raw.indexOf("\n");
  const first = (nl < 0 ? raw : raw.slice(0, nl)).trim();
  const jsonl = nl < 0 ? "" : raw.slice(nl + 1);
  return { sessionId: SESSION_ID_RE.test(first) ? first : null, jsonl };
}

/**
 * Convert the transcript tail into SDK replay frames — only what happened BEFORE the card's own SDK
 * history starts (`cutoffAt`), so a conversation that lived in both modes is drawn once: the TUI
 * era from the transcript, the SDK era from the history log. With no SDK history yet the cutoff is
 * +Infinity and the whole tail replays. Events without a timestamp cannot be placed and are
 * dropped rather than guessed. PURE.
 */
export function transcriptToSdkHistory(jsonl: string, cutoffAt: number = Number.POSITIVE_INFINITY): HistoryEvent[] {
  const out: HistoryEvent[] = [];
  for (const event of parseChatEvents(jsonl)) {
    if (!(event.at > 0) || event.at >= cutoffAt) continue;
    if (event.kind === "user") out.push({ type: "user", text: event.text, at: event.at });
    else if (event.kind === "assistant") out.push({ type: "assistant_text", text: event.text, at: event.at });
    else if (event.kind === "tool") {
      out.push({
        type: "tool_use",
        id: event.id,
        name: event.tool ?? "?",
        // The transcript keeps a one-line summary, not the raw input; `description` is what the
        // front's toolSummary shows, so the replayed line reads like the live one did.
        input: event.text ? { description: event.text } : {},
        at: event.at,
      });
    }
    // "system" notes are the harness talking — not part of the conversation being preserved.
  }
  return out;
}

/**
 * Which session the driver should RESUME: the newest transcript in the card's worktree — whichever
 * mode wrote it (the TUI after `claude -c`, or a previous SDK driver) it is the current state of
 * this card's ONE conversation. Falls back to the persisted key when the probe found nothing. PURE.
 */
export function resumeTargetFor(card: Pick<Card, "resumeSessionId">, latestSessionId: string | null): string | undefined {
  return latestSessionId ?? card.resumeSessionId;
}
