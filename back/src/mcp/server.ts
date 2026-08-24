import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerMaestroTools } from "./tools.js";
import { logger } from "../utils/logger.js";

/**
 * What a connecting agent is told this server is for — the MCP `instructions` every client receives
 * at initialize. Every card already has this server injected, so every terminal (and any external
 * client that connects later) is handed this guidance automatically: it IS the maestro persona.
 *
 * SINGLE SOURCE OF TRUTH: the text is the contents of `services/brain/personas/maestro.md`, read
 * once at startup — edit the markdown, not a string here. The `.md` is copied next to the compiled
 * JS by the build (`back/package.json` → `scripts/build-assets.mjs`), so the path below resolves the
 * same way in dev (from `src/`) and in the runtime image (from `dist/`).
 */
const PERSONA_FILE = join(dirname(fileURLToPath(import.meta.url)), "..", "services", "brain", "personas", "maestro.md");

/**
 * Belt for an install whose build did not copy the asset (an out-of-band `node dist/index.js` with
 * no build step): the server still boots and connecting agents still get the essentials, rather than
 * the whole process failing to start over a missing markdown file. The real text lives in the `.md`.
 */
const FALLBACK_INSTRUCTIONS =
  "vibehub — you are one terminal on a board of Claude Code terminals. Coordinate the others with " +
  "the vibehub_* tools, report your state with vibehub_report, and ship with vibehub_deliver — " +
  "passing authorized:true only when the user named where to ship. Never send to a human-active card.";

/** Reads the maestro persona (`maestro.md`) as the server's instructions; falls back if it is absent. */
function loadInstructions(): string {
  try {
    const text = readFileSync(PERSONA_FILE, "utf8").trim();
    if (text) return text;
    logger.warn({ file: PERSONA_FILE }, "maestro persona is empty — using the fallback MCP instructions");
  } catch (err) {
    logger.warn(
      { file: PERSONA_FILE, detail: (err as Error).message },
      "maestro persona not found — using the fallback MCP instructions",
    );
  }
  return FALLBACK_INSTRUCTIONS;
}

/** The maestro persona handed to every connecting agent as the MCP server's `instructions`. */
export const INSTRUCTIONS = loadInstructions();

/** One server instance per request — the HTTP transport here is stateless. */
export function createMcpServer(actor = "mcp"): McpServer {
  const server = new McpServer({ name: "vibehub", version: "0.1.0" }, { instructions: INSTRUCTIONS });
  registerMaestroTools(server, actor);
  return server;
}
