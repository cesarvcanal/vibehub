import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerMaestroTools } from "./tools.js";

/** What a connecting agent is told this server is for. */
export const INSTRUCTIONS = `vibehub — the board this terminal is running on.

Every card on the board is another REAL Claude Code terminal: its own process, its own context, its
own git worktree and branch, running in the same container. These tools let this terminal coordinate
the others — list them, delegate an instruction, read back what they answered.

They are peers, not sub-agents. A terminal you delegate to keeps its own context and its own branch,
so send self-contained instructions, and expect a reply on its own schedule: delegate, let it work,
and read it back when its situation turns "waiting".`;

/** One server instance per request — the HTTP transport here is stateless. */
export function createMcpServer(actor = "mcp"): McpServer {
  const server = new McpServer({ name: "vibehub", version: "0.1.0" }, { instructions: INSTRUCTIONS });
  registerMaestroTools(server, actor);
  return server;
}
