import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { PublicUser } from "../auth/users.js";
import { recordCardActor } from "../services/board/actor.js";
import type { BoardColumn } from "../services/board/registry.js";
import {
  requireCardLevel, openCardFor, listProjectsFor, listCardsFor, createCardFor, sendToCardAs, moveCardsAs,
} from "../services/maestro/asUser.js";
import {
  readTerminal, readCardActivity, waitForTurn, WAIT_MAX_MS, ACTIVITY_LIMIT_MAX,
} from "../services/maestro/maestro.js";
import { readCardChanges } from "../services/maestro/changes.js";
import { deliverCard } from "../services/review/deliverCard.js";
import { prDocsInput, prDocsOf, PR_DOCS_RULE } from "./prDocsInput.js";
import { inboxFor, markDelivered, takeUndelivered, type CardEvent } from "../services/events/cardEvents.js";
import { AGENT_MOVABLE_COLUMNS, MOVE_BATCH_MAX } from "./cardMove.js";
import { logger } from "../utils/logger.js";
import { ok, fail } from "./toolResult.js";

/**
 * EXTERNAL TOOLS — the board as an app on the internet (ChatGPT, Claude.ai) sees it when a user
 * connected it through OAuth (auth/oauth.ts). The app has no card of its own: it is the USER,
 * talking (often by voice) to an assistant that drives the cards for them.
 *
 * So every tool answers to that user's reach, the same rules the board's own routes apply
 * (auth/access.ts): the owner reaches everything; a member reaches what was shared with them, and
 * changes only what was shared at `work` level. A card the user cannot see is "not found" — the
 * same 404 the board answers, so an id never confirms that something exists. Creating cards and
 * projects stays the owner's, as on the board.
 *
 * A send here is the person's OWN message (attributed to them, like the chat composer), not one
 * card talking to another — which is also why it records the user as the card's actor: the commits
 * that come out of the instruction carry their identity.
 */

/**
 * Reads that change nothing. ChatGPT asks the user to CONFIRM every call to a tool that is not marked
 * read-only — by voice, a confirmation on every poll of a card would make following it unusable.
 */
const READ_ONLY = { readOnlyHint: true, openWorldHint: false } as const;

/**
 * A moment in the SERVER's zone with its offset ("2026-10-20T18:05:00-03:00"): the assistant reads
 * times aloud, and a bare UTC "Z" is heard as local and comes out hours off.
 */
export function localIso(ms: number): string {
  const d = new Date(ms);
  const off = -d.getTimezoneOffset();
  const pad = (n: number) => String(Math.trunc(Math.abs(n))).padStart(2, "0");
  const local = new Date(ms + off * 60_000).toISOString().slice(0, 19);
  return `${local}${off >= 0 ? "+" : "-"}${pad(off / 60)}:${pad(off % 60)}`;
}

/** A card event as the assistant gets it: the card by title (what is spoken), the time readable. */
function forAssistant(e: CardEvent) {
  // Absent fields are undefined, and JSON leaves them out.
  return {
    cardId: e.cardId, card: e.title, kind: e.kind, at: localIso(e.at),
    questions: e.questions, tool: e.tool, reason: e.reason, state: e.state, summary: e.summary,
  };
}

type ToolResult = ReturnType<typeof ok>;

/**
 * What happened on the board since this person last heard, as one more block of the answer. An MCP
 * server cannot start a turn of the app, so this is how the news reaches the conversation: on the
 * next tool call, whichever it is, once. A failure to read the log never costs the answer itself.
 */
async function withNews(user: PublicUser, result: ToolResult): Promise<ToolResult> {
  let fresh: CardEvent[];
  try {
    fresh = await takeUndelivered(user);
  } catch (err) {
    logger.warn({ by: user.username, detail: (err as Error).message }, "could not read the card events for the external MCP");
    return result;
  }
  if (fresh.length === 0) return result;
  const news = ok({
    notifications: fresh.map(forAssistant),
    hint: "new on the board since the user last heard — tell them briefly before anything else",
  });
  return { ...result, content: [...result.content, ...news.content] };
}

export function registerExternalTools(server: McpServer, user: PublicUser): void {
  // Every tool answer carries the news (see withNews) — except the inbox, which IS the news and
  // registers on `server` directly. The casts only bridge the SDK's overloads; config passes as is.
  const registerTool = ((name: string, config: unknown, cb: (...args: unknown[]) => Promise<ToolResult>) =>
    server.registerTool(name, config as never, (async (...args: unknown[]) => await withNews(user, await cb(...args))) as never)) as McpServer["registerTool"];

  registerTool(
    "vibehub_list_projects",
    {
      description:
        "List the projects you can reach on the vibehub board (id, name, repository, base branch). " +
        "A card always belongs to a project: use the id here to create a card or to filter terminals. " +
        "`canCreateCards` says whether this account may create cards (only the owner may).",
      inputSchema: {},
      annotations: READ_ONLY,
    },
    async () => {
      try {
        return ok(await listProjectsFor(user));
      } catch (e) {
        return fail(e);
      }
    },
  );

  registerTool(
    "vibehub_list_terminals",
    {
      description:
        "List the cards (terminals) you can reach. Each card is a real Claude Code terminal with its " +
        "own session, worktree and branch. Returns id, title, project, column, situation " +
        "(working/waiting/paused/done/no session), whether the session is live, what the card's agent " +
        "last reported about its work, and your `access` (work = you can send/open/move/deliver; " +
        "view = read only). situation 'waiting' means its last turn is over — read it. `project` " +
        "(id or part of the name) filters.",
      inputSchema: {
        project: z.string().optional().describe("project id, or part of its name. Absent = every project you can reach."),
      },
      annotations: READ_ONLY,
    },
    async (a) => {
      try {
        return ok(await listCardsFor(user, a.project));
      } catch (e) {
        return fail(e);
      }
    },
  );

  registerTool(
    "vibehub_create_card",
    {
      description:
        "Create a new card (a new Claude Code terminal with its own branch) in a project — owner " +
        "only. `open` (default true) also starts its session so you can send it work; the first card " +
        "of a project clones the repo, which can take a few minutes — when the answer says " +
        "`opening`, poll vibehub_list_terminals until its liveSession is true before sending.",
      inputSchema: {
        projectId: z.string().describe("project id (from vibehub_list_projects)"),
        title: z.string().min(1).max(200).describe("short title of the task, as it should read on the board"),
        open: z.boolean().optional().describe("start the session right away (default true)"),
      },
    },
    async (a) => {
      try {
        return ok(await createCardFor(user, a));
      } catch (e) {
        return fail(e);
      }
    },
  );

  registerTool(
    "vibehub_open_card",
    {
      description:
        "Open (or resume) a card's terminal session, so it can receive instructions. Idempotent: an " +
        "already-open card just answers opened. When the answer says `opening`, the workspace is " +
        "still being prepared — poll vibehub_list_terminals until liveSession is true.",
      inputSchema: {
        cardId: z.string().describe("id of the card (from vibehub_list_terminals)"),
      },
    },
    async (a) => {
      try {
        return ok(await openCardFor(user, await requireCardLevel(user, a.cardId, "work")));
      } catch (e) {
        return fail(e);
      }
    },
  );

  registerTool(
    "vibehub_send_to_terminal",
    {
      description:
        "Send an instruction to a card, as YOUR message: it arrives in that card's conversation " +
        "exactly as if you had typed it on the board. The card's agent does not hear this " +
        "conversation, so send a SELF-CONTAINED instruction (what to do, where, what done looks " +
        "like), not a fragment. Also how you ANSWER a card's pending question (say the chosen option). " +
        "Returns `sentAt`: pass it to vibehub_wait_for_card as `since`. A card that is asleep " +
        "(hibernated, never opened, or restarted) is woken on its own — no need to open it first — and " +
        "a card still starting is waited for. A card PAUSED on purpose is refused (`paused:`), and so " +
        "is a finished one asleep in Done (`done:`): ask the user before moving it. Also fails clearly " +
        "when no Claude can run there or a menu waits in its terminal. Answering an event that asked for something (a pushed card.event " +
        "with needsAnswer, or an inbox entry)? Pass its eventId as `inReplyTo`: the card is told which " +
        "question this answers, and the event closes.",
      inputSchema: {
        cardId: z.string().describe("id of the destination card (from vibehub_list_terminals)"),
        text: z.string().min(1).describe("the instruction, self-contained"),
        inReplyTo: z.string().optional().describe("the eventId this message answers (card.event / inbox)"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async (a) => {
      try {
        const sent = await sendToCardAs(user, a);
        return ok({ ...sent, next: "call vibehub_wait_for_card with this cardId and since=sentAt" });
      } catch (e) {
        return fail(e);
      }
    },
  );

  registerTool(
    "vibehub_read_terminal",
    {
      description:
        "Read the LAST answers of a card's agent, as clean text, plus `pendingQuestion`: the question " +
        "it is waiting on you for (with its options), null when none. `last` = how many answers " +
        "(default 3). To wait for a turn to end, use vibehub_wait_for_card instead.",
      inputSchema: {
        cardId: z.string().describe("id of the card to read (from vibehub_list_terminals)"),
        last: z.number().int().min(1).max(20).optional().describe("how many answers to return (default 3)"),
      },
      annotations: READ_ONLY,
    },
    async (a) => {
      try {
        await requireCardLevel(user, a.cardId, "view");
        return ok(await readTerminal(a.cardId, a.last ?? 3));
      } catch (e) {
        return fail(e);
      }
    },
  );

  registerTool(
    "vibehub_wait_for_card",
    {
      description:
        "Wait for a card's turn to END (or for it to need the user) and get what it said — use it " +
        "right after vibehub_send_to_terminal, with `since` = the `sentAt` it returned. Holds the call " +
        `up to ${WAIT_MAX_MS / 1000}s. \`outcome\`: 'finished' (read \`answers\`), 'question' (relay ` +
        "`pendingQuestion` with its options to the user; answer by sending their choice), 'permission' " +
        "(a sensitive action waits for Allow/Deny on the board — tell the user), 'timeout' (still " +
        "working: tell the user briefly what `activity` shows, then wait again), 'not_started' (the " +
        "card did not start a turn after `since`), 'no session' (open the card first).",
      inputSchema: {
        cardId: z.string().describe("id of the card (from vibehub_list_terminals)"),
        since: z.number().int().optional().describe("epoch ms of your send (`sentAt`); keeps an old answer from reading as the new one"),
        timeoutSeconds: z.number().int().min(1).max(WAIT_MAX_MS / 1000).optional()
          .describe(`how long to wait at most (default and max ${WAIT_MAX_MS / 1000})`),
      },
      annotations: READ_ONLY,
    },
    async (a) => {
      try {
        await requireCardLevel(user, a.cardId, "view");
        return ok(await waitForTurn(a.cardId, {
          since: a.since,
          timeoutMs: (a.timeoutSeconds ?? WAIT_MAX_MS / 1000) * 1000,
        }));
      } catch (e) {
        return fail(e);
      }
    },
  );

  registerTool(
    "vibehub_card_activity",
    {
      description:
        "What a card is doing and has done: situation, `busy` (a turn is running), what it is " +
        "waiting on you for (`pendingQuestion`, `pendingPermission`), and its recent `events` — your " +
        "messages, each tool call as one line (the file it edited, the command it ran) and its " +
        "answers, oldest first. `since` (epoch ms, e.g. the previous call's `now`) returns only what " +
        "is new. Use it to tell the user what the card is up to while it works.",
      inputSchema: {
        cardId: z.string().describe("id of the card (from vibehub_list_terminals)"),
        since: z.number().int().optional().describe("epoch ms; only events after it"),
        limit: z.number().int().min(1).max(ACTIVITY_LIMIT_MAX).optional().describe("newest events to return (default 30)"),
      },
      annotations: READ_ONLY,
    },
    async (a) => {
      try {
        await requireCardLevel(user, a.cardId, "view");
        return ok(await readCardActivity(a.cardId, { since: a.since, limit: a.limit }));
      } catch (e) {
        return fail(e);
      }
    },
  );

  registerTool(
    "vibehub_card_changes",
    {
      description:
        "What a card has produced in git: its branch, the commits ahead of its base (newest first), " +
        "the files it changed, what is not committed yet, and its pull request (url, state) when " +
        "there is one. Read only — it never pushes or fetches. Use it to tell the user what was " +
        "actually done before delivering.",
      inputSchema: {
        cardId: z.string().describe("id of the card (from vibehub_list_terminals)"),
      },
      annotations: READ_ONLY,
    },
    async (a) => {
      try {
        await requireCardLevel(user, a.cardId, "view");
        return ok(await readCardChanges(a.cardId));
      } catch (e) {
        return fail(e);
      }
    },
  );

  registerTool(
    "vibehub_move_cards",
    {
      description:
        "Move one or more cards to 'done' (finished — sticky) or 'backlog' (parked, not started). " +
        "Pausing or resuming is not here. Each card is processed on its own: one you cannot change " +
        "fails on its line and the rest still move. Returns { column, moved, unchanged, failed, results }.",
      inputSchema: {
        cards: z.array(z.string()).min(1).max(MOVE_BATCH_MAX).describe("card ids (from vibehub_list_terminals)"),
        column: z.enum(AGENT_MOVABLE_COLUMNS as unknown as [string, ...string[]]).describe("done | backlog"),
      },
    },
    async (a) => {
      try {
        return ok(await moveCardsAs(user, a.cards, a.column as BoardColumn));
      } catch (e) {
        return fail(e);
      }
    },
  );

  registerTool(
    "vibehub_deliver",
    {
      description:
        "Deliver a card: push its branch, open (or reuse) a pull request to `branch`, run its checks " +
        "and — ONLY when `authorized` is true and the checks pass — merge it with a merge commit. " +
        "Returns { prUrl, merged, reason } ('merged', 'gate' = checks red, 'unauthorized' = PR " +
        "prepared but not told to merge, 'locked' = merge belongs to the reviewer). Pass " +
        "`authorized:true` ONLY when the user explicitly named where to ship ('sobe pra dev'); a " +
        "merge is a deploy, never a default. A PR under review: the push always happens; the merge only " +
        "when you are the review's merger and it is ready ('review_active' otherwise, naming who merges; " +
        "'head_moved' = new commits went back to the reviewer). The merger's merge order that finds the review " +
        "not ready is recorded on it: it merges by itself once ready with no blocking item or question, Approve on " +
        "GitHub and green CI (an automatic merge that fails waits for the merger's button); `concludeWhenMerged: true` " +
        "(\"…e concluir o card\") records that the card moves to done then. The answer says what was recorded, and " +
        "when the conclusion was not. " + PR_DOCS_RULE,
      inputSchema: {
        cardId: z.string().describe("id of the card to deliver (from vibehub_list_terminals)"),
        branch: z.string().optional().describe("target branch. Absent = the project's base branch."),
        authorized: z.boolean().optional().describe("true = merge (deploy). Only when the user named the target."),
        concludeWhenMerged: z.boolean().optional().describe(
          "PR under review, with authorized: true = also conclude the card; recorded on the review, the card moves to done once it is merged.",
        ),
        ...prDocsInput,
      },
    },
    async (a) => {
      try {
        await requireCardLevel(user, a.cardId, "work");
        // Ordering the delivery IS an order: the push, the PR and the merge go out as this person.
        await recordCardActor(user, a.cardId);
        // The person IS the caller here (and was just made the card's actor): the order is theirs.
        return ok(await deliverCard(a.cardId, {
          branch: a.branch, authorized: a.authorized === true, by: user.id, from: a.cardId, concludeWhenMerged: a.concludeWhenMerged, docs: prDocsOf(a),
        }));
      } catch (e) {
        return fail(e);
      }
    },
  );
  server.registerTool(
    "vibehub_inbox",
    {
      description:
        "What happened on the board that the user has not dealt with yet: cards that FINISHED a turn, " +
        "asked a QUESTION (with its options), wait for a PERMISSION on the board, or declared they " +
        "NEED the user. A turn_finished only says the card stopped — read it (vibehub_read_terminal): " +
        "a terminal card waiting on a menu question stops the same way. Only open events — an answered question or a card that moved on leaves the " +
        "list. Check it when the user asks for news or resumes the conversation. Other tool answers " +
        "also carry new events once, as `notifications`. `since` (a previous `cursor`) returns only newer ones.",
      inputSchema: {
        since: z.number().int().optional().describe("a previous answer's `cursor`; only events after it"),
      },
      annotations: READ_ONLY,
    },
    async (a) => {
      try {
        const inbox = await inboxFor(user, { since: a.since });
        // Listed here = heard: the next answers do not repeat it (only what was listed — an event
        // landing meanwhile still rides on the next answer).
        const last = inbox.events[inbox.events.length - 1];
        if (last) await markDelivered(user, last.seq);
        return ok({ events: inbox.events.map(forAssistant), cursor: inbox.cursor });
      } catch (e) {
        return fail(e);
      }
    },
  );
}
