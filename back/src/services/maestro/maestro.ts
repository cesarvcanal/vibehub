import { hostExecutor, shQuote, assertSafeRemotePath } from "../../runtime/host.js";
import { config } from "../../config/env.js";
import {
  listProjects, listAllCards, getCard, getProject, hasLiveSession, effectiveAccountSlug,
  listAccounts, getConfig,
  type Card, type Project, type BoardColumn, type CardStatus,
} from "../board/registry.js";
import { cardWorkPaths } from "../board/workspace.js";
import { profileDirFor } from "../accounts/profiles.js";
import { seedDestDir } from "../import/import.js";
import { logger } from "../../utils/logger.js";

/**
 * MAESTRO — one card's agent coordinating the OTHER cards.
 *
 * These are REAL parallel terminals (each card is its own tmux session with its own Claude process),
 * not sub-agents: they have their own context, their own worktree and their own branch. The maestro
 * does exactly three things, and each one reuses machinery the board already has:
 *
 *  - **list** the terminals and their current situation (the same mirror the board renders);
 *  - **send** an instruction to one card's terminal (types it at the prompt and presses Enter);
 *  - **read** that card's last assistant turns out of the Claude transcript.
 *
 * RULE FOR THIS FILE: reimplement nothing. It calls the same registry/workspace/runner code the UI
 * calls. Instruction text and transcripts NEVER touch argv — the instruction travels through stdin
 * inside a quoted heredoc, and the transcript comes back on stdout from a read-only command. No
 * instruction or answer content is ever logged; only byte counts.
 */

/** How much of the transcript to pull: enough for the last turns, never megabytes. */
const TAIL_LINES = 800;

/** What a terminal is doing right now, in words a coordinating agent can act on. */
export type TerminalSituation = "working" | "waiting" | "paused" | "done" | "no session";

export interface TerminalSummary {
  cardId: string;
  title: string;
  projectId: string;
  project: string;
  column: BoardColumn;
  /** The dot the hooks reported: working = green, waiting = amber, null = nothing yet. */
  status: CardStatus | null;
  situation: TerminalSituation;
  /** true = a live tmux session in the runner (card opened and not paused). */
  liveSession: boolean;
  updatedAt: number;
}

/**
 * PURE situation of a terminal. `paused`/`done` are sticky columns and win over the dot; otherwise
 * `working` means working, a live session means it is waiting for someone to type, and no session
 * means the card was never opened (or was restarted).
 *
 * This is what tells a maestro whether a child has finished: situation "waiting" ⇒ its turn is over.
 */
export function terminalSituation(
  card: Pick<Card, "column" | "status" | "openedAt" | "pausedAt">,
): TerminalSituation {
  if (card.pausedAt || card.column === "paused") return "paused";
  if (card.column === "done") return "done";
  if (card.status === "working") return "working";
  if (hasLiveSession(card)) return "waiting";
  return "no session";
}

/** true = the card belongs to the requested project (exact id OR name contains the filter). PURE. */
export function matchesProject(project: Pick<Project, "id" | "name">, filter: string): boolean {
  const f = filter.trim().toLowerCase();
  if (!f) return true;
  return project.id.toLowerCase() === f || project.name.toLowerCase().includes(f);
}

/** Builds the summary of one terminal from its card and project. PURE. */
export function terminalSummary(card: Card, project: Project): TerminalSummary {
  return {
    cardId: card.id,
    title: card.title,
    projectId: project.id,
    project: project.name,
    column: card.column,
    status: card.status ?? null,
    situation: terminalSituation(card),
    liveSession: hasLiveSession(card),
    updatedAt: card.updatedAt,
  };
}

/** Board order, so a listing is stable: Backlog → Waiting → Working → Paused → Done. */
const COLUMN_ORDER: Record<BoardColumn, number> = {
  backlog: 0, waiting: 1, working: 2, paused: 3, done: 4,
};

/**
 * The assistant's text from ONE transcript message: only `type:"text"` blocks, so tool calls,
 * tool results and thinking never leak into what the maestro reads. Also accepts the older shape
 * where `content` is a raw string. PURE.
 */
function assistantText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const item of content) {
    if (
      item && typeof item === "object" &&
      (item as { type?: unknown }).type === "text" &&
      typeof (item as { text?: unknown }).text === "string"
    ) {
      const t = (item as { text: string }).text.trim();
      if (t) parts.push(t);
    }
  }
  return parts.join("\n").trim();
}

/**
 * Reads a Claude Code transcript (`.jsonl`, one JSON object per line) and returns the TEXT of the
 * last `last` assistant messages, oldest first. Malformed lines, non-assistant messages and
 * non-text blocks are dropped. PURE.
 */
export function parseAssistantTranscript(jsonl: string, last: number): string[] {
  const texts: string[] = [];
  for (const line of jsonl.split(/\r?\n/)) {
    const s = line.trim();
    if (!s) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(s);
    } catch {
      continue; // a truncated line from `tail` — skip it
    }
    if (!obj || typeof obj !== "object" || (obj as { type?: unknown }).type !== "assistant") continue;
    const msg = obj as { message?: { content?: unknown }; content?: unknown };
    const text = assistantText(msg.message?.content ?? msg.content);
    if (text) texts.push(text);
  }
  const n = Math.max(1, Math.floor(last) || 1);
  return texts.slice(-n);
}

/**
 * THROWS when the text collides with the heredoc delimiter carrying it — a line equal to the
 * delimiter would close the heredoc early and spill the rest into the shell. PURE.
 */
export function assertMaestroText(text: string, delimiter: string): void {
  for (const line of text.split(/\r?\n/)) {
    if (line === delimiter) throw new Error(`the instruction contains a reserved line ('${delimiter}')`);
  }
}

/**
 * Script that TYPES `text` at the prompt of a card's tmux session and submits it.
 *
 * The text rides inside the script over stdin (quoted heredoc, no expansion); `docker exec -i`
 * forwards that stdin into the container, where `$(cat)` recovers it and `tmux send-keys -l` types
 * it LITERALLY — no key-name interpretation, so an instruction containing "Enter" or "C-c" is text,
 * not a keystroke. Container and session names are derived from the board and shell-quoted. PURE.
 */
export function buildSendKeysScript(containerName: string, tmuxSession: string, text: string): string {
  const delimiter = "VIBEHUB_MAESTRO_TEXT";
  assertMaestroText(text, delimiter);
  const inner =
    `VIBEHUB_TEXT="$(cat)"; ` +
    `tmux send-keys -t "$1" -l -- "$VIBEHUB_TEXT"; ` +
    `tmux send-keys -t "$1" Enter`;
  return [
    "set -e",
    `docker exec -i ${shQuote(containerName)} bash -c ${shQuote(inner)} _ ${shQuote(tmuxSession)} <<'${delimiter}'`,
    text,
    delimiter,
  ].join("\n");
}

/**
 * Read-only command that finds the MOST RECENT `.jsonl` in a card's transcript directory (the
 * active session) and returns its last `tailLines` lines. An empty directory yields empty output,
 * not an error. The directory is derived and validated, and passed as `$1`. PURE.
 */
export function buildReadTranscriptScript(containerName: string, transcriptDir: string, tailLines: number): string {
  assertSafeRemotePath(transcriptDir);
  const n = Math.max(1, Math.min(5000, Math.floor(tailLines) || TAIL_LINES));
  const inner = `f=$(ls -1t "$1"/*.jsonl 2>/dev/null | head -1); [ -n "$f" ] && tail -n ${n} "$f" || true`;
  return `docker exec ${shQuote(containerName)} sh -c ${shQuote(inner)} _ ${shQuote(transcriptDir)}`;
}

/** Lists the terminals with their current situation. `project` filters by id or part of the name. */
export async function listTerminals(project?: string): Promise<TerminalSummary[]> {
  const [projects, cards] = await Promise.all([listProjects(), listAllCards()]);
  const byId = new Map(projects.map((p) => [p.id, p]));
  const filter = (project ?? "").trim();
  const out: TerminalSummary[] = [];
  for (const card of cards) {
    const owner = byId.get(card.projectId);
    if (!owner) continue; // orphan card (project deleted) — not a terminal anyone can reach
    if (filter && !matchesProject(owner, filter)) continue;
    out.push(terminalSummary(card, owner));
  }
  return out.sort(
    (a, b) =>
      a.project.localeCompare(b.project) ||
      COLUMN_ORDER[a.column] - COLUMN_ORDER[b.column] ||
      b.updatedAt - a.updatedAt,
  );
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

export interface SendResult {
  sent: true;
  cardId: string;
  title: string;
  project: string;
}

/**
 * Delivers an instruction to a card's terminal: types it at the prompt and presses Enter.
 *
 * Throws a distinct, actionable error when the card has no live session — that is the case a
 * maestro has to tell apart from "no such card", because the fix is different (open the card).
 */
export async function sendToTerminal(cardId: string, text: string, by?: string): Promise<SendResult> {
  const instruction = String(text ?? "").trim();
  if (!instruction) throw new Error("empty text: there is nothing to send to the terminal");
  const card = await getCard(cardId);
  if (!card) throw new Error("card not found");
  if (!hasLiveSession(card)) {
    throw new Error(
      `the terminal for card "${card.title}" has no live session — open or resume the card before sending it an instruction`,
    );
  }
  const project = await getProject(card.projectId);
  if (!project) throw new Error("project for this card not found");

  try {
    await hostExecutor().runScript(
      buildSendKeysScript(config.runner.container, card.tmuxSession, instruction),
      { timeoutMs: 30_000 },
    );
  } catch (err) {
    throw sessionGoneError(err, card.title);
  }
  logger.info(
    {
      audit: true, action: "maestro.send", card: card.worktreeSlug, session: card.tmuxSession,
      bytes: Buffer.byteLength(instruction), by,
    },
    "instruction delivered to a card terminal",
  );
  return { sent: true, cardId: card.id, title: card.title, project: project.name };
}

export interface ReadResult {
  cardId: string;
  title: string;
  situation: TerminalSituation;
  /** Last assistant answers, oldest first. Empty = no transcript yet. */
  answers: string[];
}

/**
 * Reads the last `last` assistant answers from a card's transcript, already stripped to text. Does
 * NOT require a live session: what was said is still readable after a pause or a restart.
 */
export async function readTerminal(cardId: string, last = 3): Promise<ReadResult> {
  const card = await getCard(cardId);
  if (!card) throw new Error("card not found");
  const project = await getProject(card.projectId);
  if (!project) throw new Error("project for this card not found");

  const profileDir = profileDirFor(effectiveAccountSlug(card, project));
  const { cwd } = cardWorkPaths(project, card);
  const transcriptDir = seedDestDir(profileDir, cwd);
  const n = Math.max(1, Math.min(20, Math.floor(last) || 3));

  const { stdout } = await hostExecutor().runScript(
    buildReadTranscriptScript(config.runner.container, transcriptDir, TAIL_LINES),
    { timeoutMs: 30_000 },
  );
  const answers = parseAssistantTranscript(stdout, n);
  logger.info(
    { audit: true, action: "maestro.read", card: card.worktreeSlug, session: card.tmuxSession, answers: answers.length },
    "card transcript read (last assistant answers)",
  );
  return { cardId: card.id, title: card.title, situation: terminalSituation(card), answers };
}

/* ----------------------------------------------------------- session introspection */

/** Model ids Claude Code writes into transcripts, mapped to the names the UI shows. PURE. */
export function modelLabelFor(model: string | null | undefined): string | null {
  if (!model) return null;
  const m = model.toLowerCase(); // full ids ("claude-opus-5") and the aliases settings.json uses ("opus")
  if (m.includes("fable")) return "Fable";
  if (m.includes("opus")) return "Opus";
  if (m.includes("sonnet")) return "Sonnet";
  if (m.includes("haiku")) return "Haiku";
  return model;
}

/**
 * The model of the LAST assistant turn in a transcript — what the session is actually using right
 * now, whatever the card or the account says it should be. Malformed lines are skipped. PURE.
 */
export function parseLastModel(jsonl: string): string | null {
  return parseLastTurn(jsonl).model;
}

/** The last assistant turn's model and WHEN it happened (epoch ms, 0 when unknown). PURE. */
export function parseLastTurn(jsonl: string): { model: string | null; at: number } {
  let model: string | null = null;
  let at = 0;
  for (const line of jsonl.split(/\r?\n/)) {
    const s = line.trim();
    if (!s) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(s);
    } catch {
      continue;
    }
    if (!obj || typeof obj !== "object" || (obj as { type?: unknown }).type !== "assistant") continue;
    const m = (obj as { message?: { model?: unknown } }).message?.model;
    // Claude Code logs a "<synthetic>" assistant turn for its own notices (rate limit, errors) — it
    // is not a model the session is running, so it must not replace the real one.
    if (typeof m === "string" && m && !m.startsWith("<")) {
      model = m;
      const ts = (obj as { timestamp?: unknown }).timestamp;
      at = typeof ts === "string" ? Date.parse(ts) || 0 : typeof ts === "number" ? ts : 0;
    }
  }
  return { model, at };
}

/**
 * Which signal wins: `/model` + Enter writes the profile's settings.json AND switches the running
 * session, so a settings write NEWER than the last reply is the truth until the next reply lands.
 * Otherwise the last reply is.
 *
 * A card that PINS a model replaces settings.json in that contest, it does not join it: the session
 * starts with `--model`, which beats the profile's `"model"` — and that profile is SHARED by every
 * card on the account, so any `/model` typed in a neighbouring card would otherwise be read here as
 * this card's model. The pin is dated (`modelAt`) for the same reason settings.json is: switching it
 * restarts the session, so from that instant it is newer, and truer, than the turns already in the
 * transcript. PURE.
 */
export function pickModel(
  lastTurn: { model: string | null; at: number },
  settings: { model: string | null; at: number },
  pin: { model: string | null; at: number } = { model: null, at: 0 },
): string | null {
  const config = pin.model ? pin : settings;
  if (config.model && config.at >= lastTurn.at) return config.model;
  return lastTurn.model ?? config.model;
}

/**
 * Read-only: the newest transcript tail PLUS the profile's settings.json model and its mtime, in
 * one round trip. Output is two sections separated by a marker line. PURE.
 */
export function buildReadSessionScript(containerName: string, transcriptDir: string, profileDir: string, tailLines: number): string {
  assertSafeRemotePath(transcriptDir);
  assertSafeRemotePath(profileDir);
  const n = Math.max(1, Math.min(5000, Math.floor(tailLines) || TAIL_LINES));
  const inner =
    `f=$(ls -1t "$1"/*.jsonl 2>/dev/null | head -1); [ -n "$f" ] && tail -n ${n} "$f" || true; ` +
    `echo "${SESSION_MARKER}"; ` +
    `s="$2/settings.json"; if [ -f "$s" ]; then stat -c %Y "$s"; cat "$s"; fi`;
  return `docker exec ${shQuote(containerName)} sh -c ${shQuote(inner)} _ ${shQuote(transcriptDir)} ${shQuote(profileDir)}`;
}

export const SESSION_MARKER = "__VIBEHUB_SETTINGS__";

/** Splits the script output into the transcript tail and the settings model/mtime. PURE. */
export function parseSessionOutput(stdout: string): {
  transcript: string;
  settings: { model: string | null; at: number };
} {
  const idx = stdout.indexOf(SESSION_MARKER);
  if (idx < 0) return { transcript: stdout, settings: { model: null, at: 0 } };
  const transcript = stdout.slice(0, idx);
  const rest = stdout.slice(idx + SESSION_MARKER.length).trim();
  if (!rest) return { transcript, settings: { model: null, at: 0 } };
  const nl = rest.indexOf("\n");
  const mtime = Number.parseInt(nl < 0 ? rest : rest.slice(0, nl), 10);
  let model: string | null = null;
  try {
    const json = JSON.parse(nl < 0 ? "{}" : rest.slice(nl + 1)) as { model?: unknown };
    if (typeof json.model === "string" && json.model) model = json.model;
  } catch {
    /* unreadable settings — ignore */
  }
  return { transcript, settings: { model, at: Number.isFinite(mtime) ? mtime * 1000 : 0 } };
}

export interface SessionInfo {
  /** Raw model id from the transcript, or null before the first reply. */
  model: string | null;
  modelLabel: string | null;
  /** The EFFECTIVE account (card → project → default) with its display name. */
  account: { slug: string | null; name: string };
}

/** What a card's session is really running with. Read-only; tolerates a missing transcript. */
export async function sessionInfo(cardId: string): Promise<SessionInfo> {
  const card = await getCard(cardId);
  if (!card) throw new Error("card not found");
  const project = await getProject(card.projectId);
  if (!project) throw new Error("project for this card not found");

  const slug = effectiveAccountSlug(card, project);
  const accounts = await listAccounts();
  const config = await getConfig();
  const name = slug ? (accounts.find((a) => a.slug === slug)?.name ?? slug) : (config.defaultAccountLabel ?? "default");

  let model: string | null = null;
  try {
    const profileDir = profileDirFor(slug);
    const { cwd } = cardWorkPaths(project, card);
    const { stdout } = await hostExecutor().runScript(
      buildReadSessionScript(config_runner_container(), seedDestDir(profileDir, cwd), profileDir, 200),
      { timeoutMs: 15_000 },
    );
    const { transcript, settings } = parseSessionOutput(stdout);
    model = pickModel(parseLastTurn(transcript), settings, { model: card.model ?? null, at: card.modelAt ?? 0 });
  } catch {
    model = null; // runner unreachable or no transcript yet — the UI shows the default
  }
  return { model, modelLabel: modelLabelFor(model), account: { slug: slug ?? null, name } };
}

function config_runner_container(): string {
  return config.runner.container;
}
