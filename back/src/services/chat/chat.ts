import { hostExecutor, shQuote, assertSafeRemotePath } from "../../runtime/host.js";
import { config } from "../../config/env.js";
import { getCard, getProject, hasLiveSession, effectiveAccountSlug } from "../board/registry.js";
import { transcriptDirFor, sessionGoneError } from "../maestro/maestro.js";
import { logger } from "../../utils/logger.js";

/**
 * CHAT — the same session as the terminal, read as a conversation instead of as a screen.
 *
 * The terminal pane ships BYTES OF TUI: Claude Code repaints its whole viewport many times a
 * second (spinner, status line, boxes), so an idle card still streams, and a phone still has to
 * rasterise every frame. That is the cost this file removes. It does NOT run a second agent: the
 * card's `claude` process is exactly where it was, and this is a mirror of what it writes.
 *
 *  - READING is the transcript Claude Code already keeps (`~/.claude/projects/<cwd>/<id>.jsonl`,
 *    one JSON object per line). One long-lived `tail -F` per open chat, parsed here into events,
 *    pushed to the browser. One line per message instead of one frame per repaint.
 *  - WRITING is the maestro's `tmux send-keys` path (`sendToTerminal`), which types at the prompt
 *    of the very same session — so a message sent from the chat is indistinguishable from one
 *    typed into the terminal, and both views show it.
 *
 * What the transcript does NOT contain: the TUI's own interactive moments (a permission prompt, a
 * plan approval, `/login`). Those exist only on the screen, which is why the switch back to the
 * terminal has to stay one tap away in the UI.
 */

/** How much history a chat opens with. ~400 lines is several turns without being a download. */
export const CHAT_TAIL_LINES = 400;

/**
 * Marker embedded in the follow loop's command line (a no-op `:` argument), so a leaked watcher is
 * IDENTIFIABLE in `ps` inside the runner. The reaper (services/reaper) kills any orphaned process
 * carrying it. Never derived from input.
 */
export const TRANSCRIPT_FOLLOW_MARKER = "vibehub-transcript-follow";

/** Longest tool detail we put on a collapsed line. Beyond this it stops being a summary. */
export const TOOL_DETAIL_MAX = 160;

export type ChatEventKind = "user" | "assistant" | "tool" | "system";

export interface ChatEvent {
  /** Stable id from the transcript (`uuid`, plus the block for tool calls) — the browser dedupes on it. */
  id: string;
  kind: ChatEventKind;
  /** Epoch ms, 0 when the line carries no timestamp. */
  at: number;
  /** user/assistant: the message. tool: the one-line summary of what it was called with. */
  text: string;
  /** Tool name, on `tool` events only. */
  tool?: string;
}

/** Clamps a summary to one readable line. PURE. */
export function clampDetail(value: string, max = TOOL_DETAIL_MAX): string {
  const one = value.replace(/\s+/g, " ").trim();
  return one.length <= max ? one : `${one.slice(0, max - 1)}…`;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * The one line a collapsed tool call shows: WHAT it touched, not how.
 *
 * The rule is the same for every tool — name the object (the file, the command, the pattern, the
 * url), because that is what tells the reader whether to care. A tool nobody has taught this
 * function still gets its description or nothing at all, never a dump of its arguments. PURE.
 */
export function toolSummary(name: string, input: unknown): string {
  const args = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const file = str(args.file_path) || str(args.path) || str(args.notebook_path);
  const base = file ? (file.split("/").pop() ?? file) : "";
  switch (name) {
    case "Bash":
    case "BashOutput":
      return clampDetail(str(args.description) || str(args.command));
    case "Read":
    case "Write":
    case "Edit":
    case "NotebookEdit":
      return clampDetail(base);
    case "Glob":
    case "Grep":
      return clampDetail(str(args.pattern) + (str(args.path) ? ` · ${str(args.path)}` : ""));
    case "WebFetch":
    case "WebSearch":
      return clampDetail(str(args.url) || str(args.query));
    case "Task":
    case "Agent":
      return clampDetail(str(args.description) || str(args.subagent_type));
    case "TodoWrite":
      return "";
    default:
      // MCP tools and anything new: a description if the tool provides one, else its first short
      // string argument, which is nearly always the subject (a query, a title, an id).
      if (str(args.description)) return clampDetail(str(args.description));
      for (const value of Object.values(args)) {
        if (typeof value === "string" && value.trim() && value.length <= 200) return clampDetail(value);
      }
      return "";
  }
}

/** `<command-name>/foo</command-name><command-args>bar</command-args>` → `/foo bar`. PURE. */
export function unwrapSlashCommand(text: string): string {
  const name = /<command-name>([\s\S]*?)<\/command-name>/.exec(text)?.[1]?.trim() ?? "";
  if (!name) return text;
  const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(text)?.[1]?.trim() ?? "";
  return args ? `${name} ${args}` : name;
}

/**
 * A user-role line that is really the HARNESS talking, not the person: a background-task
 * notification and the "[SYSTEM NOTIFICATION - NOT USER INPUT]" envelope it arrives in. These land
 * in the transcript as `type:"user"` with no `toolUseResult`, so the chat used to draw them as the
 * user's own message — the thing that made a scheduled watcher's "task completed" look like Cesar
 * had typed it. Returns a SHORT human label to show as a muted event, or null when it is a real
 * message. PURE.
 */
export function systemNote(text: string): string | null {
  const t = text.trim();
  if (!/^\[SYSTEM NOTIFICATION\b/i.test(t) && !t.includes("<task-notification>")) return null;
  const summary = /<summary>([\s\S]*?)<\/summary>/.exec(t)?.[1]?.trim();
  const label = summary || "Background task update";
  return label.length > TOOL_DETAIL_MAX ? `${label.slice(0, TOOL_DETAIL_MAX - 1)}…` : label;
}

/** The text blocks of a message content, joined. Ignores images, thinking and tool results. PURE. */
function textOf(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const item of content) {
    const block = item as { type?: unknown; text?: unknown } | null;
    if (block && typeof block === "object" && block.type === "text" && typeof block.text === "string") {
      const t = block.text.trim();
      if (t) parts.push(t);
    }
  }
  return parts.join("\n").trim();
}

/**
 * A transcript line the chat has no business showing.
 *
 * The transcript is a LOG, not a conversation: hook attachments, file-history snapshots, mode
 * changes, the tool RESULTS that come back dressed as user messages, and the whole sidechain of a
 * subagent's own turns all live in the same file. Everything here is dropped by rule rather than by
 * guessing, so a new line type Claude Code invents shows up as nothing instead of as noise. PURE.
 */
function skipLine(obj: Record<string, unknown>): boolean {
  if (obj.isSidechain === true) return true; // a subagent's private turns
  if (obj.isMeta === true) return true;
  if (obj.type === "user" && obj.toolUseResult !== undefined) return true; // a tool result, not a person
  return obj.type !== "user" && obj.type !== "assistant";
}

/**
 * Parses transcript JSONL into chat events, oldest first. Malformed lines are skipped — `tail`
 * hands us a truncated first line every time it starts, and a partially written last line every
 * time Claude is mid-flush. PURE.
 */
export function parseChatEvents(jsonl: string): ChatEvent[] {
  const events: ChatEvent[] = [];
  for (const line of jsonl.split(/\r?\n/)) {
    const s = line.trim();
    if (!s.startsWith("{")) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(s) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (!obj || typeof obj !== "object" || skipLine(obj)) continue;

    const uuid = str(obj.uuid) || `${str(obj.timestamp)}:${events.length}`;
    const at = Date.parse(str(obj.timestamp)) || 0;
    const message = (obj.message ?? {}) as { content?: unknown };

    if (obj.type === "user") {
      const text = unwrapSlashCommand(textOf(message.content));
      // `<local-command-stdout>` is the terminal echoing a slash command's own output back into the
      // transcript. It belongs to the screen, not to the conversation.
      if (!text || text.startsWith("<local-command-stdout>")) continue;
      // A background-task notification / system envelope is the harness talking, not the person —
      // show it as a muted event, never as the user's own message.
      const note = systemNote(text);
      if (note) {
        events.push({ id: uuid, kind: "system", at, text: note });
        continue;
      }
      events.push({ id: uuid, kind: "user", at, text });
      continue;
    }

    const content = message.content;
    if (!Array.isArray(content)) {
      const text = textOf(content);
      if (text) events.push({ id: uuid, kind: "assistant", at, text });
      continue;
    }
    for (const item of content) {
      const block = item as { type?: unknown; text?: unknown; name?: unknown; id?: unknown; input?: unknown };
      if (!block || typeof block !== "object") continue;
      if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
        events.push({ id: `${uuid}#${str(block.id) || "t"}`, kind: "assistant", at, text: block.text.trim() });
      } else if (block.type === "tool_use" && typeof block.name === "string") {
        events.push({
          id: `${uuid}#${str(block.id) || block.name}`,
          kind: "tool",
          at,
          tool: block.name,
          text: toolSummary(block.name, block.input),
        });
      }
      // "thinking" and everything else: deliberately not shown.
    }
  }
  return events;
}

/**
 * Command that FOLLOWS a card's transcript: prints the last `tailLines` lines and then everything
 * appended, until it is killed.
 *
 * Two things it has to survive, both of which happen in normal use:
 *
 *  - **The session file changes.** `/clear`, a restart or a resume starts a NEW `.jsonl`; a plain
 *    `tail -F` would sit on the old one forever, so the loop re-checks which file is newest and
 *    moves the tail across.
 *  - **The reader going away.** The browser closing kills our end, but the process INSIDE the
 *    container would happily keep looping. TWO independent things stop it, because ONE was not
 *    enough in production (the runner accumulated hundreds of these loops):
 *      1. The heartbeat newline: writing to a pipe nobody reads fails, the loop's condition fails
 *         with it, and the shell exits. It doubles as a "still connected" tick on the wire, and
 *         parses as nothing. BUT — and this is how the loops leaked — a `docker exec` whose CLIENT
 *         was killed does not break that pipe: the daemon keeps consuming stdout, so the printf
 *         succeeds forever and the loop never notices the reader is gone.
 *      2. The STDIN liveness check: the exec runs with `-i`, so the loop's stdin IS the connection
 *         to the backend. Nothing ever arrives on it — `read -t 2` is the loop's sleep — but when
 *         the backend's process dies (socket closed, backend restarted, ssh dropped), the daemon
 *         closes that stdin and `read` comes back with EOF instead of a timeout. EOF = no reader =
 *         exit. This is the parent-liveness check (`kill -0 $PPID` does not work here: a process
 *         started by `docker exec` sees PPID 0 inside the container's namespace).
 *
 * The loop carries TRANSCRIPT_FOLLOW_MARKER on its command line (a no-op `:` argument) so that a
 * watcher that leaks anyway — a runner upgraded mid-flight, a docker daemon hiccup — is visible in
 * `ps` and gets collected by the reaper.
 *
 * The directory is derived from the board and validated; nothing from the request reaches the
 * shell. PURE.
 */
export function buildFollowCommand(containerName: string, transcriptDir: string, tailLines = CHAT_TAIL_LINES): string {
  assertSafeRemotePath(transcriptDir);
  const n = Math.max(1, Math.min(5000, Math.floor(tailLines) || CHAT_TAIL_LINES));
  const inner =
    `: ${TRANSCRIPT_FOLLOW_MARKER}; cur=""; pid=""; ` +
    // The tail is a CHILD: without this it outlives the loop that started it and keeps a handle on
    // a socket nobody is reading. Killing it on the way out is what makes a closed chat cost zero.
    // The signal trap has to `exit` explicitly — a shell that HANDLES a signal does not die from
    // it, so a trap without the exit turns SIGTERM into "kill the tail and carry on looping".
    `trap 'kill $pid 2>/dev/null' EXIT; ` +
    `trap 'kill $pid 2>/dev/null; exit 0' INT TERM HUP; ` +
    `while printf '\\n'; do ` +
    `f=$(ls -1t "$1"/*.jsonl 2>/dev/null | head -1); ` +
    `if [ -n "$f" ] && [ "$f" != "$cur" ]; then ` +
    `if [ -n "$pid" ]; then kill "$pid" 2>/dev/null || true; fi; ` +
    `cur="$f"; tail -n ${n} -F "$f" & pid=$!; ` +
    `fi; ` +
    // The 2s cadence AND the liveness check in one: timeout (rc>128) = still connected, keep going;
    // EOF/error (rc 1..128) = the backend end of this exec is gone — exit, and the EXIT trap takes
    // the tail down. bash, not sh: dash has no `read -t`.
    `read -t 2 -r hb; rc=$?; if [ $rc -ne 0 ] && [ $rc -le 128 ]; then exit 0; fi; ` +
    `done`;
  return `docker exec -i ${shQuote(containerName)} bash -c ${shQuote(inner)} _ ${shQuote(transcriptDir)}`;
}

/** Keys the chat may press in the session, by name. Nothing else reaches tmux. */
export const CHAT_KEYS: Record<string, string> = {
  /** Claude Code's own "stop what you are doing" — the chat's Stop button. */
  escape: "Escape",
  /** The harder stop, for a session wedged in something that ignores Escape. */
  interrupt: "C-c",
};

/** Script that presses ONE named key in a card's session. The name is whitelisted, never raw. PURE. */
export function buildSendKeyScript(containerName: string, tmuxSession: string, key: string): string {
  const tmuxKey = CHAT_KEYS[key];
  if (!tmuxKey) throw new Error(`unknown key: '${key}'`);
  const inner = `tmux send-keys -t "$1" ${tmuxKey}`;
  return `docker exec ${shQuote(containerName)} bash -c ${shQuote(inner)} _ ${shQuote(tmuxSession)}`;
}

export interface ChatSource {
  cardId: string;
  title: string;
  /** argv for the follow process, already routed through the configured host executor. */
  command: { file: string; args: string[] };
}

/** The follow command for one card's transcript. THROWS when the card (or its project) is gone. */
export async function chatSource(cardId: string): Promise<ChatSource> {
  const card = await getCard(cardId);
  if (!card) throw new Error("card not found");
  const project = await getProject(card.projectId);
  if (!project) throw new Error("project for this card not found");
  const dir = transcriptDirFor(project, card, effectiveAccountSlug(card, project));
  return {
    cardId: card.id,
    title: card.title,
    command: hostExecutor().ptyCommand(buildFollowCommand(config.runner.container, dir)),
  };
}

/** Presses a key in the card's session (Stop). Same live-session rule as sending text. */
export async function sendChatKey(cardId: string, key: string): Promise<{ sent: true }> {
  const card = await getCard(cardId);
  if (!card) throw new Error("card not found");
  if (!hasLiveSession(card)) {
    throw new Error(
      `the terminal for card "${card.title}" has no live session — open or resume the card first`,
    );
  }
  try {
    await hostExecutor().runScript(buildSendKeyScript(config.runner.container, card.tmuxSession, key), {
      timeoutMs: 15_000,
    });
  } catch (err) {
    throw sessionGoneError(err, card.title);
  }
  logger.info(
    { audit: true, action: "chat.key", card: card.worktreeSlug, session: card.tmuxSession, key },
    "key pressed in a card terminal from the chat",
  );
  return { sent: true };
}
