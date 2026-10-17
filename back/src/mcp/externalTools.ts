import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { PublicUser } from "../auth/users.js";
import { cardLevel, visibleProjects } from "../auth/access.js";
import * as registry from "../services/board/registry.js";
import * as workspace from "../services/board/workspace.js";
import { recordCardActor } from "../services/board/actor.js";
import { listTerminals, sendToTerminal, readTerminal } from "../services/maestro/maestro.js";
import { deliver } from "../services/maestro/deliver.js";
import { moveCards, AGENT_MOVABLE_COLUMNS, MOVE_BATCH_MAX, type CardMoveOutcome } from "./cardMove.js";
import { logger } from "../utils/logger.js";

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

const ok = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] });
const fail = (e: unknown) => ok({ error: (e as Error).message });

/** How long a tool waits for an open before answering "still opening" (a first clone takes minutes). */
export const OPEN_WAIT_MS = 20_000;

async function requireLevel(user: PublicUser, cardId: string, need: "view" | "work"): Promise<registry.Card> {
  const level = await cardLevel(user, cardId);
  const card = level ? await registry.getCard(cardId) : undefined;
  if (!level || !card) throw new Error("card not found");
  if (need === "work" && level !== "work") throw new Error("this card is shared with you read-only");
  return card;
}

/**
 * Runs `work` but answers by `ms` at the latest: `{ done: true, value }` when it settled in time,
 * `{ done: false }` when it is still going (it keeps going — its failure is logged, not lost).
 */
async function settleWithin<T>(work: Promise<T>, ms: number, what: string, cardId: string): Promise<{ done: true; value: T } | { done: false }> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<{ done: false }>((resolve) => {
    timer = setTimeout(() => resolve({ done: false }), ms);
  });
  const settled = work.then((value) => ({ done: true as const, value }));
  try {
    return await Promise.race([settled, timeout]);
  } finally {
    clearTimeout(timer);
    void settled.catch((err: unknown) => {
      logger.warn({ card: cardId, detail: (err as Error).message }, `${what} failed`);
    });
  }
}

async function openForUser(user: PublicUser, card: registry.Card) {
  // BEFORE the open, as the board's /open does: the open resolves the git identity written into
  // the worktree, so the actor has to be on the card by then.
  await recordCardActor(user, card.id);
  const result = await settleWithin(workspace.openCard(card.id, user.id), OPEN_WAIT_MS, "open from the external MCP", card.id);
  if (result.done) return { cardId: card.id, title: card.title, opened: true };
  return {
    cardId: card.id,
    title: card.title,
    opened: false,
    opening: true,
    hint: "still preparing the workspace (the first open of a project clones the repo). Check " +
      "vibehub_list_terminals until liveSession is true, then send the instruction.",
  };
}

export function registerExternalTools(server: McpServer, user: PublicUser): void {
  server.registerTool(
    "vibehub_list_projects",
    {
      description:
        "List the projects you can reach on the vibehub board (id, name, repository, base branch). " +
        "A card always belongs to a project: use the id here to create a card or to filter terminals. " +
        "`canCreateCards` says whether this account may create cards (only the owner may).",
      inputSchema: {},
    },
    async () => {
      try {
        const projects = await visibleProjects(user, await registry.listProjects());
        return ok({
          canCreateCards: user.role === "owner",
          projects: projects.map((p) => ({ id: p.id, name: p.name, repo: p.repoFullName ?? null, baseBranch: p.baseBranch })),
        });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
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
    },
    async (a) => {
      try {
        const all = await listTerminals(a.project);
        const out = [];
        for (const t of all) {
          const access = await cardLevel(user, t.cardId);
          if (access) out.push({ ...t, access });
        }
        return ok(out);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
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
        if (user.role !== "owner") throw new Error("only the owner can create cards — ask them to create or share one");
        const card = await registry.createCard({ projectId: a.projectId, title: a.title });
        logger.info({ card: card.worktreeSlug, by: user.username }, "card created from the external MCP");
        if (a.open === false) {
          void workspace.prepareCard(card.id, "card.create").catch((err: unknown) => {
            logger.warn({ card: card.worktreeSlug, detail: (err as Error).message }, "pre-provisioning of the new card failed (best-effort)");
          });
          return ok({ cardId: card.id, title: card.title, projectId: card.projectId, opened: false });
        }
        return ok({ ...(await openForUser(user, card)), projectId: card.projectId });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
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
        return ok(await openForUser(user, await requireLevel(user, a.cardId, "work")));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "vibehub_send_to_terminal",
    {
      description:
        "Send an instruction to a card, as YOUR message: it arrives in that card's conversation " +
        "exactly as if you had typed it on the board. The card's agent does not hear this " +
        "conversation, so send a SELF-CONTAINED instruction (what to do, where, what done looks " +
        "like), not a fragment. Fails clearly when the card has no live session (open it first), " +
        "when no Claude is running there, or when its terminal is waiting on a menu choice.",
      inputSchema: {
        cardId: z.string().describe("id of the destination card (from vibehub_list_terminals)"),
        text: z.string().min(1).describe("the instruction, self-contained"),
      },
    },
    async (a) => {
      try {
        await requireLevel(user, a.cardId, "work");
        await recordCardActor(user, a.cardId);
        return ok(await sendToTerminal(a.cardId, a.text, {
          by: user.id,
          guardInteractiveMenu: true,
          requireAgent: true,
          origin: { kind: user.role === "owner" ? "owner" : "user", name: user.username },
        }));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "vibehub_read_terminal",
    {
      description:
        "Read the LAST answers of a card's agent, as clean text. Use it after sending, once the " +
        "card's situation turns 'waiting' (its turn is over). `last` = how many answers (default 3).",
      inputSchema: {
        cardId: z.string().describe("id of the card to read (from vibehub_list_terminals)"),
        last: z.number().int().min(1).max(20).optional().describe("how many answers to return (default 3)"),
      },
    },
    async (a) => {
      try {
        await requireLevel(user, a.cardId, "view");
        return ok(await readTerminal(a.cardId, a.last ?? 3));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
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
        const allowed: string[] = [];
        const refused: CardMoveOutcome[] = [];
        for (const cardId of a.cards) {
          try {
            await requireLevel(user, cardId, "work");
            allowed.push(cardId);
          } catch (e) {
            refused.push({ cardId, ok: false, error: (e as Error).message });
          }
        }
        if (allowed.length === 0) {
          return ok({ column: a.column, moved: 0, unchanged: 0, failed: refused.length, results: refused });
        }
        const moved = await moveCards(allowed, a.column, { by: user.id });
        return ok({ ...moved, failed: moved.failed + refused.length, results: [...moved.results, ...refused] });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "vibehub_deliver",
    {
      description:
        "Deliver a card: push its branch, open (or reuse) a pull request to `branch`, run its checks " +
        "and — ONLY when `authorized` is true and the checks pass — merge it with a merge commit. " +
        "Returns { prUrl, merged, reason } ('merged', 'gate' = checks red, 'unauthorized' = PR " +
        "prepared but not told to merge, 'locked' = merge belongs to the reviewer). Pass " +
        "`authorized:true` ONLY when the user explicitly named where to ship ('sobe pra dev'); a " +
        "merge is a deploy, never a default.",
      inputSchema: {
        cardId: z.string().describe("id of the card to deliver (from vibehub_list_terminals)"),
        branch: z.string().optional().describe("target branch. Absent = the project's base branch."),
        authorized: z.boolean().optional().describe("true = merge (deploy). Only when the user named the target."),
      },
    },
    async (a) => {
      try {
        await requireLevel(user, a.cardId, "work");
        return ok(await deliver(a.cardId, { branch: a.branch, authorized: a.authorized === true, by: user.id }));
      } catch (e) {
        return fail(e);
      }
    },
  );
}
