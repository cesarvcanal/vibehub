import { hostExecutor, shQuote, assertSafeRemotePath } from "../../runtime/host.js";
import { config } from "../../config/env.js";
import {
  listProjects, listAllCards, getCard, getProject, hasLiveSession, effectiveAccountSlug, markCardActivity,
  listAccounts, getConfig, isHumanActive, reportCardState, CLAUDE_MODELS, isValidEffort,
  type Card, type Project, type BoardColumn, type CardStatus, type DeclaredState,
} from "../board/registry.js";
import { cardAgentState, cardDefaultEffort, cardDriverActivity, cardPaneReadiness, type MenuKind } from "../board/agentState.js";
import { profileDirFor } from "../accounts/profiles.js";
import { transcriptDirFor, sessionGoneError } from "./cardSession.js";
import { recordOrigin, type MessageOrigin } from "../chat/provenance.js";
import { publishExternalMessage, readHistory } from "../sdk/history.js";
import { liveDriverSession, sendAgentTurn } from "../sdk/manager.js";
import { startCardDriver } from "../sdk/headless.js";
import { openCard, probeCardSession } from "../board/workspace.js";
import { getSettings } from "../settings/settings.js";
import { observeDeclaredState } from "../events/cardEvents.js";
import { logger } from "../../utils/logger.js";
import {
  activityFromTranscript, pendingPermissionFromHistory, pendingQuestionFromHistory, pendingQuestionFromTranscript,
  type ActivityEvent, type PendingPermission, type PendingQuestion,
} from "./feed.js";

/**
 * MAESTRO — one card's agent coordinating the OTHER cards.
 *
 * These are REAL parallel terminals (each card is its own tmux session with its own Claude process),
 * not sub-agents: they have their own context, their own worktree and their own branch. The maestro
 * does exactly three things, and each one reuses machinery the board already has:
 *
 *  - **list** the terminals and their current situation (the same mirror the board renders);
 *  - **send** an instruction to one card: a turn of its native-chat driver while that chat is in
 *    use (a live driver), otherwise typed at its terminal's prompt followed by Enter;
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
export type TerminalSituation = "working" | "waiting" | "paused" | "done" | "stopped" | "no session";

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
  /** What the agent SAID about its own work (`vibehub_report`); null = it has said nothing yet. */
  declaredState: DeclaredState | null;
  /** The one-line summary the agent reported with `declaredState`; null = none. */
  declaredSummary: string | null;
  /**
   * true = a human typed into this terminal within the last few minutes. `vibehub_send_to_terminal`
   * REFUSES a human-active card (reading is still allowed) — a maestro must not fight a person for
   * the prompt.
   */
  humanActive: boolean;
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

/** Builds the summary of one terminal from its card and project. PURE (given `now`). */
export function terminalSummary(card: Card, project: Project, now: number = Date.now()): TerminalSummary {
  return {
    cardId: card.id,
    title: card.title,
    projectId: project.id,
    project: project.name,
    column: card.column,
    status: card.status ?? null,
    situation: terminalSituation(card),
    liveSession: hasLiveSession(card),
    declaredState: card.declaredState ?? null,
    declaredSummary: card.declaredSummary ?? null,
    humanActive: isHumanActive(card, now),
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
 * not a keystroke. Container and session names are derived from the board and shell-quoted.
 *
 * The pause before Enter is the same 120 ms the browser's composer leaves (see XTerminal): a body
 * arriving in one burst is read by Claude Code's TUI as a PASTE, and an Enter that lands inside
 * that window is swallowed as part of it — the message is typed and never sent. Waiting for the
 * paste detector to settle makes the Enter a keystroke again. PURE.
 */
export function buildSendKeysScript(containerName: string, tmuxSession: string, text: string): string {
  const delimiter = "VIBEHUB_MAESTRO_TEXT";
  assertMaestroText(text, delimiter);
  const inner =
    `VIBEHUB_TEXT="$(cat)"; ` +
    `tmux send-keys -t "$1" -l -- "$VIBEHUB_TEXT"; ` +
    `sleep 0.15; ` +
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
  const now = Date.now(); // one clock for the whole listing, so `humanActive` is consistent across it
  const out: TerminalSummary[] = [];
  for (const card of cards) {
    const owner = byId.get(card.projectId);
    if (!owner) continue; // orphan card (project deleted) — not a terminal anyone can reach
    if (filter && !matchesProject(owner, filter)) continue;
    out.push(terminalSummary(card, owner, now));
  }
  return out.sort(
    (a, b) =>
      a.project.localeCompare(b.project) ||
      COLUMN_ORDER[a.column] - COLUMN_ORDER[b.column] ||
      b.updatedAt - a.updatedAt,
  );
}

export interface SendResult {
  sent: true;
  cardId: string;
  title: string;
  project: string;
  /** Where the instruction landed: a turn of the native-chat driver, or typed at the tmux prompt. */
  route?: "sdk-driver" | "terminal";
  /** true = the card was asleep (hibernated / never opened / restarted) and this send woke it. */
  woke?: boolean;
}

/**
 * Delivers an instruction to a card's terminal: types it at the prompt and presses Enter.
 *
 * Throws a distinct, actionable error when the card has no live session — that is the case a
 * maestro has to tell apart from "no such card", because the fix is different (open the card).
 *
 * `respectHumanActive` is for the MAESTRO only: a maestro must not type into a card a PERSON is using
 * right now (it would fight them for the prompt). It is OFF by default — the person's OWN send (the
 * chat composer) must ALWAYS go through, even though their very typing is what marked the card
 * human-active. Only `vibehub_send_to_terminal` (an agent driving another card) opts in.
 */
export interface SendOpts {
  by?: string;
  respectHumanActive?: boolean;
  /**
   * Refuse the send when a MENU is open in the terminal (session resume, /compact, a permission
   * prompt), instead of typing a message that presses Enter on the highlighted option. On for a
   * person's chat send (the corruption they hit); off by default so an agent-to-agent send pays no
   * probe.
   */
  guardInteractiveMenu?: boolean;
  /**
   * Refuse the send when CLAUDE IS NOT RUNNING in the pane. A card whose Claude exited (crash,
   * `/exit`, a hibernate that half-landed) still has a live tmux with a bare SHELL under it: the
   * board says "open", send-keys succeeds — and the message is executed by bash or swallowed,
   * never reaching any conversation. That was the chat's "balão pendente para sempre": a 200 with
   * no echo ever coming. On for the person's chat send and always for an AGENT's send; off by
   * default otherwise (the outbox path probes for itself).
   */
  requireAgent?: boolean;
  /**
   * WHO this message is from — the visual attribution the destination card's chat shows ("card X
   * said this", "user Y said this"). Absent = unattributed (drawn as the card owner's own message,
   * which is the pre-provenance behaviour). An AGENT origin also picks the route: while the card's
   * native chat is in use (a live SDK driver), the instruction is a turn of that driver, not text
   * typed at the tmux prompt.
   */
  origin?: MessageOrigin;
  /**
   * A PERSON's message from OUTSIDE the board (the external MCP — ChatGPT acting as the user) takes
   * the same route as an agent's: the live native-chat driver when there is one, the tmux prompt
   * otherwise. The board's own composer does not need this (it talks to the driver over its socket);
   * a message typed into tmux while the conversation lives in the driver lands in ANOTHER Claude
   * process — the chat forks, and a question card waiting in the driver is never answered.
   */
  viaNativeChat?: boolean;
  /**
   * Runs once every refusal is past, right before the text is delivered — where a send makes its
   * sender the card's author (the order's identity must land first, and a REFUSED send must leave
   * the authorship alone). A throw here fails the send.
   */
  beforeDeliver?: () => Promise<void>;
  /**
   * How long the send may WAIT for the terminal to become able to take it (Claude running, its
   * prompt drawn, no menu open) before refusing. 0 = probe once and refuse at once (the chat
   * composer: a person is looking and keeps the draft). An agent driving a card it just created or
   * opened needs the wait: Claude takes seconds to boot, and a send in that window used to fail as
   * "no agent running"/"awaiting choice" or be typed into a pane that was not drawn yet. The wait
   * only OBSERVES — a menu is never answered for anyone; one still open at the deadline refuses.
   */
  readyWaitMs?: number;
  /** Interval between looks while waiting (tests shorten it). */
  readyPollMs?: number;
  /**
   * WAKE the card when it is asleep — hibernated by the idle sweep, never opened, or with no session
   * after a runner restart — instead of refusing with "no live session"; and, when the native chat is
   * on and nobody is mid-turn in the TUI, deliver as a turn of a driver started for it (no browser
   * needed). For orders from OUTSIDE the board (the external MCP, another card's agent): before this,
   * such an order only arrived once a person opened the card. A card PAUSED on purpose is never woken.
   */
  wake?: boolean;
}

/** How often a waiting send looks at the pane again. */
export const READY_POLL_MS = 1_000;

/**
 * How long a send from an AGENT/assistant (and an open, once its session exists) waits for Claude to
 * be able to take a message. Claude boots in a few seconds; past this the answer names what is in
 * the way (a menu, a Claude that exited) instead of a bare "awaiting choice".
 */
export const SEND_READY_WAIT_MS = 30_000;

/** Why a terminal cannot take a message right now — the refusal a waiting send ends on. */
type TerminalBlocker =
  | { reason: "no agent"; agent: "shell" | "none" }
  | { reason: "menu"; menu: MenuKind }
  | { reason: "booting" };

/**
 * What stands between this card's terminal and a typed message, null = nothing. One agent probe and
 * (when the menu guard is on) one pane capture. `booting` only counts for a WAITING send: a send
 * with no wait keeps its old behaviour (an empty capture was never a refusal).
 */
async function terminalBlocker(
  card: Card, checks: { agent: boolean; menu: boolean; booting: boolean },
): Promise<TerminalBlocker | null> {
  if (checks.agent) {
    const agent = await cardAgentState(card);
    if (agent !== "running") return { reason: "no agent", agent };
  }
  if (checks.menu) {
    const pane = await cardPaneReadiness(card);
    if (pane.state === "menu") return { reason: "menu", menu: pane.menu };
    if (pane.state === "booting" && checks.booting) return { reason: "booting" };
  }
  return null;
}

/** A blocker as the error a caller can act on. The leading markers ("no agent running", "awaiting
 * choice") are what the routes map to their status codes — keep them. */
function blockerError(b: TerminalBlocker, title: string, waitedMs: number): Error {
  const waited = waitedMs > 0 ? ` (waited ${Math.round(waitedMs / 1000)}s for it to become ready)` : "";
  if (b.reason === "no agent") {
    return new Error(
      `no agent running: Claude is not running in card "${title}" (the terminal is ${
        b.agent === "shell" ? "at a bare shell" : "gone"
      })${waited} — restart the card, then send again`,
    );
  }
  if (b.reason === "menu") {
    const what: Record<MenuKind, string> = {
      trust: "the folder-trust dialog",
      resume: "the session-resume menu",
      permission: "a permission prompt",
      other: "a menu",
    };
    return new Error(
      `awaiting choice (${b.menu}): card "${title}" is waiting on ${what[b.menu]} in the terminal${waited}. Open the Terminal tab, answer it, then send again.`,
    );
  }
  return new Error(
    `terminal not ready: Claude is still starting in card "${title}"${waited} — send again in a few seconds`,
  );
}

/**
 * Holds until the card's terminal can take a message, or throws the reason it cannot at the
 * deadline. Every wait that ended blocked — and every one that had to wait at all — is logged with
 * what it saw, so "the card did not start" is answerable from the logs instead of a screenshot.
 */
async function awaitTerminalReady(
  card: Card, checks: { agent: boolean; menu: boolean }, waitMs: number, pollMs: number,
): Promise<void> {
  const started = Date.now();
  const deadline = started + Math.max(0, waitMs);
  const full = { ...checks, booting: waitMs > 0 };
  let first: TerminalBlocker | null = null;
  for (;;) {
    const blocker = await terminalBlocker(card, full);
    if (!blocker) {
      if (first) {
        logger.info(
          { card: card.worktreeSlug, waitedMs: Date.now() - started, initially: first },
          "card terminal became ready for a waiting send",
        );
      }
      return;
    }
    first ??= blocker;
    if (Date.now() >= deadline) {
      const waitedMs = Date.now() - started;
      logger.warn(
        { card: card.worktreeSlug, session: card.tmuxSession, blocker, waitedMs },
        "send refused: card terminal not ready",
      );
      throw blockerError(blocker, card.title, waitedMs);
    }
    await sleep(Math.min(pollMs, Math.max(0, deadline - Date.now())));
  }
}

/**
 * The origin of an AGENT send (`vibehub_send_to_terminal`): the calling card's title, plus the ids
 * the chat needs to link back to it. The tool's `from` is self-declared (like `vibehub_report`'s
 * `card`), so an unknown/absent id degrades to a nameless agent label, never to an error — naming
 * the sender must not be able to break the send itself.
 */
export async function agentOriginFor(fromCardId?: string): Promise<MessageOrigin> {
  if (fromCardId) {
    try {
      const sender = await getCard(fromCardId);
      if (sender) {
        return { kind: "agent", name: sender.title, sourceCardId: sender.id, sourceProjectId: sender.projectId };
      }
    } catch {
      /* registry unreadable — fall through to the anonymous agent */
    }
  }
  return { kind: "agent", name: "" };
}

/** What an open reports about the terminal it started: able to take a message, or why not yet. */
export type TerminalReadiness = { ready: true } | { ready: false; detail: string };

/**
 * Waits up to `waitMs` for an OPENED card's terminal to take a message (Claude running, prompt
 * drawn, no menu) — what `liveSession` alone cannot say: the session exists the moment tmux does,
 * seconds before Claude can read a keystroke. Never throws; the answer says why it is not ready.
 */
export async function waitTerminalReady(cardId: string, waitMs: number, pollMs = READY_POLL_MS): Promise<TerminalReadiness> {
  const card = await getCard(cardId);
  if (!card) return { ready: false, detail: "card not found" };
  if (!hasLiveSession(card)) return { ready: false, detail: "no live session" };
  try {
    await awaitTerminalReady(card, { agent: true, menu: true }, waitMs, pollMs);
    return { ready: true };
  } catch (err) {
    return { ready: false, detail: (err as Error).message };
  }
}

export async function sendToTerminal(cardId: string, text: string, opts: SendOpts = {}): Promise<SendResult> {
  const {
    by, respectHumanActive = false, guardInteractiveMenu = false, requireAgent = false, origin, viaNativeChat = false,
    beforeDeliver, readyWaitMs = 0, readyPollMs = READY_POLL_MS, wake = false,
  } = opts;
  const instruction = String(text ?? "").trim();
  if (!instruction) throw new Error("empty text: there is nothing to send to the terminal");
  let card = await getCard(cardId);
  if (!card) throw new Error("card not found");
  // A maestro must not type into a card a person is using right now — but the person's own send is
  // never blocked (respectHumanActive is off unless the caller is a maestro driving another card).
  if (respectHumanActive && isHumanActive(card)) {
    throw new Error(
      `card "${card.title}" is human-active — someone is typing in it right now, so it will not accept a sent instruction; read it and wait, or ask the user`,
    );
  }
  let woke = false;
  if (wake) {
    // A pause is a person's decision; a message does not overrule it (neither does the deploy resume).
    if (card.pausedAt || card.column === "paused") {
      throw new Error(
        `paused: card "${card.title}" was paused on purpose and is not woken by a message — move it out of Paused (or ask the user), then send again`,
      );
    }
    if (!hasLiveSession(card)) {
      if (card.column === "done") {
        throw new Error(
          `done: card "${card.title}" is finished and asleep — move it back to Waiting/Working first, then send again`,
        );
      }
      const before = card.hibernatedAt ? "hibernated" : card.openedAt ? "no session" : "never opened";
      card = await openCard(card.id, by);
      woke = true;
      logger.info({ audit: true, action: "maestro.wake", card: card.worktreeSlug, was: before, by }, "asleep card woken by an order from outside the board");
    }
  }
  if (!hasLiveSession(card)) {
    throw new Error(
      `the terminal for card "${card.title}" has no live session — open or resume the card before sending it an instruction`,
    );
  }
  const fromAgent = origin?.kind === "agent";
  // The native chat takes the turn while it is in use (a live driver). For an order from outside the
  // board (`wake`) it also takes it when NO ONE is mid-turn in the TUI: the driver is started here,
  // headless — the TUI is the route that depends on status hooks reaching the back and on no menu
  // sitting in the pane. A TUI that is generating right now keeps the order (typed, queued by Claude),
  // so two Claudes never work the same worktree at once.
  let driver = fromAgent || viaNativeChat ? liveDriverSession(card.id) : null;
  if (!driver && wake && origin && (fromAgent || viaNativeChat) && (await getSettings()).sdkDriver) {
    if ((await probeCardSession(card)) !== "busy") driver = await startCardDriver(card.id);
  }
  // The TUI route for an order from outside: a card the board calls live whose tmux session is GONE
  // (the runner restarted under it) is recreated — the same idempotent open — instead of refused.
  if (!driver && wake && (await probeCardSession(card)) === "gone") {
    card = await openCard(card.id, by);
    woke = true;
    logger.info({ audit: true, action: "maestro.wake", card: card.worktreeSlug, was: "session gone", by }, "card whose terminal was gone recreated for an order from outside the board");
  }
  if (driver && origin) {
    const project = await getProject(card.projectId);
    if (!project) throw new Error("project for this card not found");
    await beforeDeliver?.();
    if (!sendAgentTurn(driver, instruction, origin)) {
      throw new Error(
        `the native chat driver of card "${card.title}" exited before it could take the instruction — send it again`,
      );
    }
    await markCardActivity(card.id).catch(() => undefined);
    logger.info(
      { audit: true, action: "maestro.send", card: card.worktreeSlug, route: "sdk-driver", woke, bytes: Buffer.byteLength(instruction), by },
      "instruction delivered to a card's native chat",
    );
    return { sent: true, cardId: card.id, title: card.title, project: project.name, route: "sdk-driver", woke };
  }
  // A menu is open in the terminal (session-resume, /compact, a permission prompt): typing a message
  // now would press Enter on the highlighted option and be swallowed. Refuse — the caller keeps the
  // text and the person answers the menu in the Terminal tab. The marker lets the routes map it to a
  // 409 and the UI to a clear line.
  // Claude EXITED under this session (the pane is a bare shell) or the session evaporated: typing
  // here would hand the message to bash, answer 200, and echo NOTHING back — the chat's forever-
  // pending bubble. Refuse with the action that fixes it instead.
  if (requireAgent || fromAgent || guardInteractiveMenu) {
    await awaitTerminalReady(card, { agent: requireAgent || fromAgent, menu: guardInteractiveMenu }, readyWaitMs, readyPollMs);
  }
  const project = await getProject(card.projectId);
  if (!project) throw new Error("project for this card not found");
  await beforeDeliver?.();

  try {
    await hostExecutor().runScript(
      buildSendKeysScript(config.runner.container, card.tmuxSession, instruction),
      { timeoutMs: 30_000 },
    );
  } catch (err) {
    throw sessionGoneError(err, card.title);
  }
  if (origin) {
    // Attribution only, AFTER a successful delivery — a failed send must leave no ghost label, and
    // a failed record must not fail a delivered message (both writers below never throw).
    // The provenance log is what the OLD chat matches its transcript user-events against; the sdk
    // history line is what makes an agent's message VISIBLE (with its sender) in the native chat,
    // which never sees text typed into the tmux prompt.
    void recordOrigin(card.id, instruction, origin);
    if (origin.kind === "agent") {
      void publishExternalMessage(card.id, { type: "user", text: instruction, at: Date.now(), from: origin });
    }
  }
  // A delivered order is a sign of life the idle sweep must see even when the hooks cannot report it.
  await markCardActivity(card.id).catch(() => undefined);
  logger.info(
    {
      audit: true, action: "maestro.send", card: card.worktreeSlug, session: card.tmuxSession, route: "terminal", woke,
      bytes: Buffer.byteLength(instruction), by,
    },
    "instruction delivered to a card terminal",
  );
  return { sent: true, cardId: card.id, title: card.title, project: project.name, route: "terminal", woke };
}

export interface ReportResult {
  reported: true;
  cardId: string;
  title: string;
  state: DeclaredState;
  summary: string;
}

/**
 * Records a card's OWN declared state and one-line summary (`vibehub_report`). This is a SELF-report:
 * `cardId` is the calling card's id (its `$VIBEHUB_CARD_ID`), the same way the status hook self-reports
 * `{ card, status }`. It writes only `declaredState`/`declaredSummary` — never the column or the dot.
 */
export async function reportState(cardId: string, state: string, summary?: string, by?: string): Promise<ReportResult> {
  const card = await reportCardState(cardId, state, summary); // validates the state; unknown card -> undefined
  if (!card) throw new Error("card not found");
  // "I need you" is what a person away from the board must hear (services/events/cardEvents.ts).
  void observeDeclaredState(card.id, card.declaredState as DeclaredState, card.declaredSummary);
  logger.info(
    {
      audit: true, action: "maestro.report", card: card.worktreeSlug,
      state: card.declaredState, bytes: Buffer.byteLength(card.declaredSummary ?? ""), by,
    },
    "card reported its declared state",
  );
  return {
    reported: true,
    cardId: card.id,
    title: card.title,
    state: card.declaredState as DeclaredState,
    summary: card.declaredSummary ?? "",
  };
}

export interface ReadResult {
  cardId: string;
  title: string;
  situation: TerminalSituation;
  /** Last assistant answers, oldest first. Empty = no transcript yet. */
  answers: string[];
  /**
   * The question the card is waiting on the user for, null = none. An answer's text often ends in
   * "which one do you want?" while the real options live in a question card the text never shows.
   */
  pendingQuestion: PendingQuestion | null;
}

/**
 * Reads the last `last` assistant answers from a card's transcript, already stripped to text. Does
 * NOT require a live session: what was said is still readable after a pause or a restart.
 */
export async function readTerminal(cardId: string, last = 3): Promise<ReadResult> {
  const { card, transcript } = await readCardTranscript(cardId);
  const n = Math.max(1, Math.min(20, Math.floor(last) || 3));
  const answers = parseAssistantTranscript(transcript, n);
  logger.info(
    { audit: true, action: "maestro.read", card: card.worktreeSlug, session: card.tmuxSession, answers: answers.length },
    "card transcript read (last assistant answers)",
  );
  const pending = await pendingFor(card.id, transcript);
  return { cardId: card.id, title: card.title, situation: terminalSituation(card), answers, pendingQuestion: pending.question };
}

/** The card and the tail of its newest transcript (read-only; no live session needed). */
async function readCardTranscript(cardId: string): Promise<{ card: Card; transcript: string }> {
  const card = await getCard(cardId);
  if (!card) throw new Error("card not found");
  const project = await getProject(card.projectId);
  if (!project) throw new Error("project for this card not found");
  const transcriptDir = transcriptDirFor(project, card, effectiveAccountSlug(card, project));
  const { stdout } = await hostExecutor().runScript(
    buildReadTranscriptScript(config.runner.container, transcriptDir, TAIL_LINES),
    { timeoutMs: 30_000 },
  );
  return { card, transcript: stdout };
}

/** How much of the sdk history the pending checks look at — the open cards are always at the end. */
const PENDING_HISTORY_EVENTS = 200;

/**
 * What the card is waiting on the user for: the native chat's question/permission card (the sdk
 * history, local disk) or — when there is none — a question menu in the terminal (the transcript).
 * `transcript` absent = history only (the cheap check a wait loop can afford on every tick).
 */
async function pendingFor(
  cardId: string, transcript?: string,
): Promise<{ question: PendingQuestion | null; permission: PendingPermission | null }> {
  const events = await readHistory(cardId, PENDING_HISTORY_EVENTS);
  const now = Date.now();
  const question = pendingQuestionFromHistory(events, now) ?? (transcript ? pendingQuestionFromTranscript(transcript) : null);
  return { question, permission: pendingPermissionFromHistory(events, now) };
}

/** Is a turn running: the hook's dot says working, or the native chat's driver is mid-turn. */
function isBusy(card: Card): boolean {
  return card.status === "working" || cardDriverActivity(card.id) === "turn";
}

export interface ActivityResult {
  cardId: string;
  title: string;
  situation: TerminalSituation;
  /** A turn is running right now (hook dot or native-chat driver). */
  busy: boolean;
  declaredState: DeclaredState | null;
  declaredSummary: string | null;
  pendingQuestion: PendingQuestion | null;
  pendingPermission: PendingPermission | null;
  /** What the card did, oldest first (see feed.ts). */
  events: ActivityEvent[];
  /** The server's clock when this was read — pass it back as `since` to get only what is new. */
  now: number;
}

/** How many activity events a read returns at most. */
export const ACTIVITY_LIMIT_MAX = 100;

/**
 * What a card is doing and did: situation, what it waits on, and its recent activity (messages, tool
 * calls, answers). `since` (epoch ms) keeps only newer events. Read-only; no live session needed.
 */
export async function readCardActivity(cardId: string, opts: { since?: number; limit?: number } = {}): Promise<ActivityResult> {
  const now = Date.now();
  const { card, transcript } = await readCardTranscript(cardId);
  const limit = Math.max(1, Math.min(ACTIVITY_LIMIT_MAX, Math.floor(opts.limit ?? 30) || 30));
  const pending = await pendingFor(card.id, transcript);
  logger.info({ audit: true, action: "maestro.activity", card: card.worktreeSlug }, "card activity read");
  return {
    cardId: card.id,
    title: card.title,
    situation: terminalSituation(card),
    busy: isBusy(card),
    declaredState: card.declaredState ?? null,
    declaredSummary: card.declaredSummary ?? null,
    pendingQuestion: pending.question,
    pendingPermission: pending.permission,
    events: activityFromTranscript(transcript, { since: opts.since, limit }),
    now,
  };
}

/**
 * How long one wait may hold the call. A tool call from a chat app has its own deadline (around a
 * minute); past that the app gives up on the call and the user hears an error instead of "still
 * working". The caller simply waits again.
 */
export const WAIT_MAX_MS = 50_000;
const WAIT_POLL_MS = 1_500;

/**
 * - `finished`: the turn ended — `answers` is what the card said.
 * - `question` / `permission`: the card is waiting on the user (see `pendingQuestion` / `pendingPermission`).
 * - `timeout`: still working when the wait ran out — `activity` is what it did so far; wait again.
 * - `not_started`: the card is idle and no turn began after `since` (the message may not have landed).
 * - `no session`: the card is not open — nothing will happen until it is.
 */
export type WaitOutcome = "finished" | "question" | "permission" | "timeout" | "not_started" | "no session";

export interface WaitResult {
  cardId: string;
  title: string;
  outcome: WaitOutcome;
  situation: TerminalSituation;
  busy: boolean;
  waitedMs: number;
  /** The last answers (text), oldest first. */
  answers: string[];
  /** What the card did after `since` (or its latest events when `since` is absent). */
  activity: ActivityEvent[];
  pendingQuestion: PendingQuestion | null;
  pendingPermission: PendingPermission | null;
  now: number;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Waits for a card's turn to end — or for it to need the user — and answers with what it said.
 *
 * `since` is the moment the instruction was sent (`vibehub_send_to_terminal` returns it). It is what
 * keeps the classic race out: right after a send, the card still shows the PREVIOUS turn's "waiting"
 * dot for a second or two before the hook flips it to working, and reading that as "finished" would
 * report an answer to a message the card has not even read. So the turn counts as ended only once a
 * turn was SEEN (busy during the wait, or a hook stamped after `since`) and is no longer running.
 */
export async function waitForTurn(
  cardId: string,
  opts: { since?: number; timeoutMs?: number; pollMs?: number; last?: number } = {},
): Promise<WaitResult> {
  const started = Date.now();
  const timeoutMs = Math.max(0, Math.min(WAIT_MAX_MS, opts.timeoutMs ?? WAIT_MAX_MS));
  const pollMs = Math.max(10, opts.pollMs ?? WAIT_POLL_MS);
  const deadline = started + timeoutMs;
  const since = opts.since;
  let sawBusy = false;
  let outcome: WaitOutcome | null = null;

  for (;;) {
    const card = await getCard(cardId);
    if (!card) throw new Error("card not found");
    if (!hasLiveSession(card)) {
      outcome = "no session";
      break;
    }
    const busy = isBusy(card);
    if (busy) sawBusy = true;
    const pending = await pendingFor(card.id);
    if (pending.question) {
      outcome = "question";
      break;
    }
    if (pending.permission) {
      outcome = "permission";
      break;
    }
    const turnSeen = since === undefined || sawBusy || (card.statusAt ?? 0) >= since;
    if (!busy && turnSeen) {
      outcome = "finished";
      break;
    }
    if (Date.now() >= deadline) break;
    await sleep(Math.min(pollMs, Math.max(0, deadline - Date.now())));
  }

  const { card, transcript } = await readCardTranscript(cardId);
  const pending = await pendingFor(card.id, transcript);
  const busy = isBusy(card);
  const activity = activityFromTranscript(transcript, { since, limit: 30 });
  if (outcome === null || outcome === "finished") {
    if (pending.question) outcome = "question";
    else if (outcome === null) {
      // Ran out of time: still working, or idle with nothing new since the send.
      outcome = busy || sawBusy ? "timeout" : activity.some((e) => e.kind === "assistant") ? "finished" : "not_started";
    }
  }
  const n = Math.max(1, Math.min(20, Math.floor(opts.last ?? 3) || 3));
  logger.info({ audit: true, action: "maestro.wait", card: card.worktreeSlug, outcome, waitedMs: Date.now() - started }, "card wait ended");
  return {
    cardId: card.id,
    title: card.title,
    outcome,
    situation: terminalSituation(card),
    busy,
    waitedMs: Date.now() - started,
    answers: parseAssistantTranscript(transcript, n),
    activity,
    pendingQuestion: pending.question,
    pendingPermission: pending.permission,
    now: Date.now(),
  };
}

/* ----------------------------------------------------------- session introspection */

/** `claude-<family>-<major>[-<minor>]`; a further run of digits is a date stamp, not the version. */
const MODEL_VERSION_RE = new RegExp(`claude-(${CLAUDE_MODELS.join("|")})-(\\d{1,2})(?:-(\\d{1,2}))?(?!\\d)`);

/**
 * Model ids Claude Code writes into transcripts, mapped to the names the UI shows — VERSION included
 * ("claude-opus-5-5" → "Opus 5.5"), because a card pins a family alias and only the transcript says
 * which release that alias resolved to. An alias ("opus", from settings.json or a fresh pin) has no
 * version to show; a trailing date stamp is not part of the version. PURE.
 */
export function modelLabelFor(model: string | null | undefined): string | null {
  if (!model) return null;
  const m = model.toLowerCase();
  const version = MODEL_VERSION_RE.exec(m);
  const family = version?.[1] ?? CLAUDE_MODELS.find((f) => m.includes(f));
  if (!family) return model;
  const name = family.charAt(0).toUpperCase() + family.slice(1);
  if (!version) return name;
  return `${name} ${version[3] ? `${version[2]}.${version[3]}` : version[2]}`;
}

/**
 * The model of the LAST assistant turn in a transcript — what the session is actually using right
 * now, whatever the card or the account says it should be. Malformed lines are skipped. PURE.
 */
export function parseLastModel(jsonl: string): string | null {
  return parseLastTurn(jsonl).model;
}

/** Epoch ms of a transcript entry's `timestamp`, 0 when it has none. PURE. */
function entryTime(obj: object): number {
  const ts = (obj as { timestamp?: unknown }).timestamp;
  return typeof ts === "string" ? Date.parse(ts) || 0 : typeof ts === "number" ? ts : 0;
}

/**
 * The last assistant turn's model and WHEN it happened (epoch ms, 0 when unknown) — and when it was
 * ASKED FOR: `requestedAt` is the user entry (a message or a tool result) right before it, the one
 * whose arrival made the CLI call the model; 0 when the tail does not reach back to it. PURE.
 */
export function parseLastTurn(jsonl: string): { model: string | null; at: number; effort: string | null; requestedAt: number } {
  let model: string | null = null;
  let at = 0;
  let effort: string | null = null;
  let requestedAt = 0;
  let lastUserAt = 0;
  for (const line of jsonl.split(/\r?\n/)) {
    const s = line.trim();
    if (!s) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(s);
    } catch {
      continue;
    }
    if (!obj || typeof obj !== "object") continue;
    if ((obj as { type?: unknown }).type === "user") {
      lastUserAt = entryTime(obj);
      continue;
    }
    if ((obj as { type?: unknown }).type !== "assistant") continue;
    const m = (obj as { message?: { model?: unknown } }).message?.model;
    // Claude Code logs a "<synthetic>" assistant turn for its own notices (rate limit, errors) — it
    // is not a model the session is running, so it must not replace the real one.
    if (typeof m === "string" && m && !m.startsWith("<")) {
      model = m;
      at = entryTime(obj);
      requestedAt = lastUserAt;
      // Claude Code stamps every assistant turn with the session's reasoning level (`effort`) — the
      // only place that says what an UNPINNED card is really running on.
      const e = (obj as { effort?: unknown }).effort;
      effort = isValidEffort(typeof e === "string" ? e : null) ? (e as string) : null;
    }
  }
  return { model, at, effort, requestedAt };
}

/**
 * The reasoning level the session is on. Same contest as `pickModel`: a pin change (set OR cleared)
 * NEWER than the last reply took the session onto it — applied live in the native chat, or by a
 * restart — so it is the truth until the next reply — and a cleared pin means "the account
 * decides", unknown until that reply says so. Otherwise the last reply's stamp wins (`/effort` typed
 * in the terminal), then the pin, then settings.json's `effortLevel`. PURE.
 *
 * "Newer than the last reply" is counted from the REQUEST, not from the reply landing: an answer
 * already on its way when the level changed was asked for in the old one, and arrives stamped with
 * it. Dated by its arrival it beat the switch and the pill fell back to the old level with the
 * session already on the new one (produção, 2026-10-27 — Médio → Alto mid-turn, back to Médio).
 */
export function pickEffort(
  lastTurn: { effort: string | null; at: number; requestedAt?: number },
  settings: { effort: string | null },
  pin: { effort: string | null; at: number } = { effort: null, at: 0 },
): string | null {
  if (pin.at && pin.at >= (lastTurn.requestedAt || lastTurn.at)) return pin.effort ?? settings.effort;
  return lastTurn.effort ?? pin.effort ?? settings.effort;
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
  settings: { model: string | null; at: number; effort: string | null };
} {
  const idx = stdout.indexOf(SESSION_MARKER);
  if (idx < 0) return { transcript: stdout, settings: { model: null, at: 0, effort: null } };
  const transcript = stdout.slice(0, idx);
  const rest = stdout.slice(idx + SESSION_MARKER.length).trim();
  if (!rest) return { transcript, settings: { model: null, at: 0, effort: null } };
  const nl = rest.indexOf("\n");
  const mtime = Number.parseInt(nl < 0 ? rest : rest.slice(0, nl), 10);
  let model: string | null = null;
  let effort: string | null = null;
  try {
    const json = JSON.parse(nl < 0 ? "{}" : rest.slice(nl + 1)) as { model?: unknown; effortLevel?: unknown };
    if (typeof json.model === "string" && json.model) model = json.model;
    if (typeof json.effortLevel === "string" && isValidEffort(json.effortLevel)) effort = json.effortLevel;
  } catch {
    /* unreadable settings — ignore */
  }
  return { transcript, settings: { model, at: Number.isFinite(mtime) ? mtime * 1000 : 0, effort } };
}

export interface SessionInfo {
  /** Raw model id from the transcript, or null before the first reply. */
  model: string | null;
  modelLabel: string | null;
  /** Reasoning level the session runs on (one of CLAUDE_EFFORTS), or null while nothing says. */
  effort: string | null;
  /** The EFFECTIVE account (card → project → default) with its display name. */
  account: { slug: string | null; name: string };
  /**
   * What the terminal is doing right now. It is already polled here every few seconds, and the chat
   * view needs it: without the board's card list beside it (a phone has none) there is nothing else
   * on screen that says "the agent is still working".
   */
  situation: TerminalSituation;
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
  let effort: string | null = card.effort ?? null;
  try {
    const profileDir = profileDirFor(slug);
    const { stdout } = await hostExecutor().runScript(
      buildReadSessionScript(config_runner_container(), transcriptDirFor(project, card, slug), profileDir, 200),
      { timeoutMs: 15_000 },
    );
    const { transcript, settings } = parseSessionOutput(stdout);
    const lastTurn = parseLastTurn(transcript);
    model = pickModel(lastTurn, settings, { model: card.model ?? null, at: card.modelAt ?? 0 });
    effort = pickEffort(lastTurn, settings, { effort: card.effort ?? null, at: card.effortAt ?? 0 });
  } catch {
    model = null; // runner unreachable or no transcript yet — the UI shows the default
  }
  // Nothing above says (no pin, no reply yet, no level in the settings): the level the account runs
  // on, as the card's native chat driver announced it at boot — so a new card shows its level before
  // the first reply, like `claude` in any terminal does the moment it opens (29/10/2026).
  effort ??= cardDefaultEffort(card.id);
  // The board mirror reads a card's situation from the registry (cheap, no probe). Here — on the ONE
  // card the person is actually looking at, polled every few seconds — we can afford a live probe:
  // the registry still calls a card "waiting" after Claude has EXITED to the bare shell underneath
  // it (openedAt is set, pausedAt is not), and that silent shell with a growing queue is exactly
  // what confused people. A probe turns it into "stopped" (the chat shows "Claude parou — Reiniciar")
  // or "no session" when the runner lost the session entirely. Only "waiting" is refined, so working/
  // paused/done never pay for the probe.
  //
  // WHO the probe may speak for, though, is the native chat's undoing (produção, 2026-10-02): the
  // conversation's claude is a child of the BACK, not of the tmux pane — the pane under it is a bare
  // `bash`, which the probe reads as "Claude exited". The chat then hung a "Claude parou —
  // Reiniciar" banner over a session that was answering normally. So the DRIVER is asked first (free,
  // in memory) and the tmux probe only speaks when there is no driver to speak for the card. The
  // banner itself is the Terminal's (and the classic chat's) business — that is decided on screen,
  // where it is known which pane the person is looking at.
  let situation = terminalSituation(card);
  if (situation === "waiting") {
    const driver = cardDriverActivity(card.id);
    // A turn in flight is the one thing the registry cannot know with the status hooks unreachable
    // (they POST from the runner) — and it is what the chat header's "trabalhando" is made of.
    if (driver === "turn") situation = "working";
    else if (driver === "none") {
      const agent = await cardAgentState(card);
      if (agent === "shell") situation = "stopped";
      else if (agent === "none") situation = "no session";
    }
  }
  return {
    model,
    modelLabel: modelLabelFor(model),
    effort,
    account: { slug: slug ?? null, name },
    situation,
  };
}

function config_runner_container(): string {
  return config.runner.container;
}
