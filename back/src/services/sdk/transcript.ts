import { shQuote, assertSafeRemotePath } from "../../runtime/host.js";
import { parseChatEvents, type ChatEvent } from "../chat/chat.js";
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
    const converted = chatEventToHistory(event);
    if (converted) out.push(converted);
  }
  return out;
}

/**
 * ONE transcript event as a history/replay frame. `tid` is the transcript's own event id — the
 * exact dedupe key a later replay uses against what a mirror already persisted. "system" notes are
 * the harness talking — not part of the conversation being preserved. PURE.
 */
export function chatEventToHistory(event: ChatEvent): HistoryEvent | null {
  if (event.kind === "user") return { type: "user", text: event.text, at: event.at, tid: event.id };
  if (event.kind === "assistant") return { type: "assistant_text", text: event.text, at: event.at, tid: event.id };
  if (event.kind === "tool") {
    return {
      type: "tool_use",
      id: event.id,
      name: event.tool ?? "?",
      // The transcript keeps a one-line summary, not the raw input; `description` is what the
      // front's toolSummary shows, so the replayed line reads like the live one did.
      input: event.text ? { description: event.text } : {},
      at: event.at,
      tid: event.id,
    };
  }
  return null;
}

/**
 * SLASH COMMANDS ARE REWRITTEN ON THE WAY TO THE TRANSCRIPT. Claude Code expands `/foo` into its
 * plugin-qualified form `/superpowers:foo` before writing the line, so the echo that comes back from
 * the file is not byte-for-byte what the person sent. Comparing text alone therefore failed to
 * recognise the echo and the SAME message was drawn twice (production, 02/10/2026).
 *
 * The match is deliberately ASYMMETRIC rather than a canonical form on both sides. Collapsing the
 * namespace everywhere would make `/a:cmd x` and `/b:cmd x` share one key, and because the dedupe
 * set only answers yes/no, a genuinely different message would be DROPPED instead of shown — a lost
 * message is worse than the duplicate this fixes. So:
 *
 *  - what was SENT registers an extra key only when it was typed BARE (`/foo …`);
 *  - a TRANSCRIPT line looks up that extra key only when it arrives QUALIFIED (`/ns:foo …`).
 *
 * Two qualified forms never meet: `/a:cmd x` registers no alias, and `/b:cmd x` looks for one that
 * was never registered. PURE.
 */
const BARE_SLASH = /^\/[A-Za-z0-9_.-]+(?:\s|$)/;
const QUALIFIED_SLASH = /^\/[A-Za-z0-9_.-]+:([A-Za-z0-9_.-]+)/;
const ALIAS = "~slash:";

/** Keys to REGISTER for something that was sent (history line, driver stdout). PURE. */
export function dedupeNoteKeys(event: Parameters<typeof replayDedupeKey>[0]): string[] {
  const key = replayDedupeKey(event);
  if (!key) return [];
  const text = key.slice(key.indexOf(":") + 1);
  return BARE_SLASH.test(text) ? [key, `${ALIAS}${key}`] : [key];
}

/** Keys to LOOK UP for a line read back from the transcript. PURE. */
export function dedupeLookupKeys(event: Parameters<typeof replayDedupeKey>[0]): string[] {
  const key = replayDedupeKey(event);
  if (!key) return [];
  const head = key.slice(0, key.indexOf(":") + 1);
  const text = key.slice(key.indexOf(":") + 1);
  if (!QUALIFIED_SLASH.test(text)) return [key];
  return [key, `${ALIAS}${head}${text.replace(QUALIFIED_SLASH, "/$1")}`];
}

/**
 * The dedupe key of one replayable event: the tool id when there is one, else kind+text. Transcript
 * tool events are id'd `<line uuid>#<tool_use id>` while the driver emits the bare tool_use id —
 * the LAST `#` segment is the id the API minted, the same on both sides. PURE.
 */
export function replayDedupeKey(
  event: Pick<HistoryEvent, "type"> & { text?: string; id?: string; sent?: string },
): string | null {
  if (event.type === "tool_use") {
    const raw = typeof event.id === "string" ? event.id : "";
    const bare = raw.split("#").pop() ?? "";
    return bare === "" ? null : `tool:${bare}`;
  }
  if (event.type !== "user" && event.type !== "assistant_text") return null;
  // An edited message's history line shows the clean text; `sent` is there when it went to the
  // model WRAPPED (the supersede wrapper, protocol.ts) and the transcript therefore carries those
  // words. On a successful REWIND the clean text is what was sent, and `rewindHistory` deletes the
  // field — so "no `sent`" is not "never edited", it is "the wrapper was never used".
  const worded = typeof event.sent === "string" && event.sent !== "" ? event.sent : event.text;
  const norm = String(worded ?? "").replace(/\s+/g, " ").trim();
  return norm === "" ? null : `${event.type}:${norm}`;
}

/**
 * The whole replay of one connect: the card's sdk history MERGED with the transcript, deduped.
 *
 * The old rule was a single timestamp cutoff — transcript events at or after the history's first
 * entry were dropped wholesale. That rule silently ate every conversation the TERMINAL had after
 * the native chat was first used (a real bug: the user talked to the TUI, came back, and the native
 * chat "não puxou nada" — those events were newer than the cutoff and in no history file). The
 * merge keeps them: a transcript event is dropped only when the history ALREADY HAS it —
 *
 *  - by transcript id (`tid`): what a live mirror persisted, exact;
 *  - by tool-use id: the driver's tool calls (the API id is the same on both sides);
 *  - by kind + normalized text (multiset): the driver's user/assistant turns, whose lines the
 *    forked transcript carries again with the SAME words.
 *
 * Everything the history does not know is the terminal's own era: pre-native history replays as
 * before, and events newer than the history's first entry are stamped `source:"terminal"` so the
 * front can say where the conversation went. The result is ONE timeline, ordered by time (history
 * wins ties — it carries provenance and permission outcomes). PURE.
 */
export function mergeTranscriptReplay(jsonl: string, history: HistoryEvent[]): HistoryEvent[] {
  const tids = new Set<string>();
  const counts = new Map<string, number>();
  for (const event of history) {
    const tid = (event as { tid?: unknown }).tid;
    if (typeof tid === "string" && tid !== "") tids.add(tid);
    for (const key of dedupeNoteKeys(event as HistoryEvent & { text?: string; id?: string })) {
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    // A resposta a uma pergunta ÓRFÃ foi ao modelo como mensagem, mas mora no `question_result`
    // (`sent`), não numa linha `user`: é a mesma fala, e o transcript a traz de volta como tal.
    const sent = event.type === "question_result" ? (event as { sent?: unknown }).sent : undefined;
    if (typeof sent === "string" && sent !== "") {
      for (const key of dedupeNoteKeys({ type: "user", text: sent })) counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  const firstHistoryAt = history.find((e) => typeof e.at === "number" && e.at > 0)?.at ?? Number.POSITIVE_INFINITY;

  const fromTranscript: HistoryEvent[] = [];
  for (const event of parseChatEvents(jsonl)) {
    if (!(event.at > 0)) continue; // an event without a timestamp cannot be placed — dropped, not guessed
    const converted = chatEventToHistory(event);
    if (!converted) continue;
    if (converted.tid && tids.has(converted.tid)) continue;
    const keys = dedupeLookupKeys(converted as HistoryEvent & { text?: string; id?: string });
    const hit = keys.find((k) => (counts.get(k) ?? 0) > 0);
    if (hit) {
      // Every key of that ONE send goes down together — the exact one and its bare-slash alias are
      // two names for the same message, and leaving the other behind would swallow the next real one.
      for (const k of new Set([hit, ...keys])) counts.set(k, Math.max(0, (counts.get(k) ?? 0) - 1));
      continue;
    }
    fromTranscript.push(converted.at !== undefined && converted.at >= firstHistoryAt ? { ...converted, source: "terminal" } : converted);
  }

  // Two at-ascending lists → one timeline. History wins ties: its version knows who sent what.
  const out: HistoryEvent[] = [];
  let h = 0;
  let t = 0;
  while (h < history.length || t < fromTranscript.length) {
    const hv = history[h];
    const tv = fromTranscript[t];
    if (hv === undefined) { out.push(tv as HistoryEvent); t += 1; continue; }
    if (tv === undefined) { out.push(hv); h += 1; continue; }
    if ((tv.at ?? 0) < (hv.at ?? 0)) { out.push(tv); t += 1; }
    else { out.push(hv); h += 1; }
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
