import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { listTerminals, sendToTerminal, readTerminal } from "../services/maestro/maestro.js";

/**
 * MAESTRO TOOLS — what one card's agent can do to the OTHER cards.
 *
 * These are REAL parallel terminals, not sub-agents: each card has its own Claude process, its own
 * context window, its own worktree and its own branch. A maestro delegates to them and reads their
 * answers, exactly like a person would from the board.
 *
 * The tools reimplement nothing: they call `services/maestro/maestro.ts`, which reuses the same
 * registry and runner code the UI uses.
 */

const ok = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] });
const fail = (e: unknown) => ok({ error: (e as Error).message });

export function registerMaestroTools(server: McpServer, actor: string): void {
  server.registerTool(
    "vibehub_list_terminals",
    {
      description:
        "List the terminals on the vibehub board. Each card is a real Claude Code terminal running " +
        "in a container, with its own session and context. Returns id, title, project, board column, " +
        "status (working/waiting), situation (working/waiting/paused/done/no session) and whether the " +
        "session is live. Use it to discover the terminals you can coordinate. `project` (id or part " +
        "of the name) filters — coordinating within the same project is the sane default.",
      inputSchema: {
        project: z.string().optional().describe("project id, or part of its name. Absent = every project."),
      },
    },
    async (a) => {
      try {
        return ok(await listTerminals(a.project));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "vibehub_send_to_terminal",
    {
      description:
        "Delegate an instruction to another card's terminal: types `text` at that terminal's prompt " +
        "and submits it, exactly as if a person had typed it. Fails clearly when the card has no live " +
        "session — open or resume the card first. The receiving terminal keeps its own context, so " +
        "send a self-contained instruction, not a fragment of your conversation.",
      inputSchema: {
        cardId: z.string().describe("id of the destination card (from vibehub_list_terminals)"),
        text: z.string().describe("the instruction to type at that terminal's prompt (submitted with Enter)"),
      },
    },
    async (a) => {
      try {
        return ok(await sendToTerminal(a.cardId, a.text, actor));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "vibehub_read_terminal",
    {
      description:
        "Read the LAST assistant answers from another card's terminal, as clean text (tool calls and " +
        "JSON noise stripped). Use it after delegating, once that card's situation turns 'waiting' — " +
        "which is how you know its turn finished. Works on a paused card too: what was said stays " +
        "readable. `last` = how many answers to bring back (default 3).",
      inputSchema: {
        cardId: z.string().describe("id of the card to read (from vibehub_list_terminals)"),
        last: z.number().int().min(1).max(20).optional().describe("how many answers to return (default 3)"),
      },
    },
    async (a) => {
      try {
        return ok(await readTerminal(a.cardId, a.last ?? 3));
      } catch (e) {
        return fail(e);
      }
    },
  );
}
