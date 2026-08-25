import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { listTerminals, sendToTerminal, readTerminal, reportState } from "../services/maestro/maestro.js";
import { DECLARED_STATES } from "../services/board/registry.js";
import { runGate } from "../services/maestro/gate.js";
import { deliver } from "../services/maestro/deliver.js";

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
        return ok(await sendToTerminal(a.cardId, a.text, { by: actor, respectHumanActive: true }));
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

  server.registerTool(
    "vibehub_report",
    {
      description:
        "Report THIS terminal's own state on the board, so a maestro (or a person) knows where the " +
        "work stands without reading the whole transcript. `state` is your own judgement: 'working' " +
        "(still on it), 'ready' (done, ready to deliver/review), 'needs_me' (stuck on a decision only " +
        "the user can make) or 'blocked' (cannot proceed). `summary` is one short line. This is " +
        "ORTHOGONAL to the board's activity dot — it never moves your card between columns. `card` is " +
        "YOUR OWN card id: the value of the $VIBEHUB_CARD_ID environment variable in this terminal.",
      inputSchema: {
        card: z.string().describe("your own card id — the $VIBEHUB_CARD_ID of this terminal"),
        state: z.enum(DECLARED_STATES as unknown as [string, ...string[]]).describe("working | ready | needs_me | blocked"),
        summary: z.string().max(500).optional().describe("one short line describing where the work stands"),
      },
    },
    async (a) => {
      try {
        return ok(await reportState(a.card, a.state, a.summary, actor));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "vibehub_gate",
    {
      description:
        "Run a card's checks in its worktree and report whether they pass — the gate a delivery has " +
        "to clear. It runs `.vibehub/gate.json` (`{ \"checks\": [\"…\"] }`) if the repo has one, else " +
        "sensible defaults (a typecheck and `npm test`) when they are resolvable, else nothing at all. " +
        "Returns { ran, passed, output }: `ran:false` means there was nothing to check (a pass-" +
        "through, not a failure). Output is a redacted tail. Use it to know if a card is green before " +
        "you ask to ship it.",
      inputSchema: {
        card: z.string().describe("id of the card to check (from vibehub_list_terminals)"),
      },
    },
    async (a) => {
      try {
        return ok(await runGate(a.card));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "vibehub_deliver",
    {
      description:
        "Deliver a card: push its branch, open (or reuse) a pull request to `branch`, run the gate, " +
        "and — ONLY when `authorized` is true and the gate is green — merge the PR with a merge commit " +
        "(never a squash). All git/gh runs as the project's GitHub connection. Returns { prUrl, " +
        "merged, reason }: `reason` is 'merged' on success, or 'gate' (checks red), 'unauthorized' " +
        "(prepared the PR but was not told to merge), or a git failure. Pass `authorized:true` ONLY " +
        "when the user named where to ship (e.g. 'sobe pra dev'); NEVER by default — a merge is a " +
        "deploy. Cherry-picking to another branch is a separate, explicit operation, not part of this.",
      inputSchema: {
        card: z.string().describe("id of the card to deliver (from vibehub_list_terminals)"),
        branch: z.string().optional().describe("target branch for the PR / merge. Absent = the project's base branch."),
        authorized: z.boolean().optional().describe("true = merge (deploy). Only when the user named the target. Never default true."),
      },
    },
    async (a) => {
      try {
        return ok(await deliver(a.card, { branch: a.branch, authorized: a.authorized === true, by: actor }));
      } catch (e) {
        return fail(e);
      }
    },
  );
}
