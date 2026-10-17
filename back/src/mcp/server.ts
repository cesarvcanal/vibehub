import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerMaestroTools } from "./tools.js";
import { registerCredentialTools } from "./credentialTools.js";
import { registerExternalTools } from "./externalTools.js";
import type { PublicUser } from "../auth/users.js";
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
const PERSONAS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "services", "brain", "personas");

/**
 * Belt for an install whose build did not copy the asset (an out-of-band `node dist/index.js` with
 * no build step): the server still boots and connecting agents still get the essentials, rather than
 * the whole process failing to start over a missing markdown file. The real text lives in the `.md`.
 */
const FALLBACK_INSTRUCTIONS =
  "vibehub — you are one terminal on a board of Claude Code terminals. Coordinate the others with " +
  "the vibehub_* tools, report your state with vibehub_report, and ship with vibehub_deliver — " +
  "passing authorized:true only when the user named where to ship. Never send to a human-active card.";

/** The same belt for the external persona (an app on the internet acting as one user). */
const EXTERNAL_FALLBACK_INSTRUCTIONS =
  "vibehub — you operate a board of Claude Code terminals (cards) on behalf of the signed-in user. " +
  "List projects and terminals, create or open a card, send it self-contained instructions and read " +
  "its answers. Deliver with authorized:true only when the user named where to ship.";

/** Reads a persona markdown as the server's instructions; falls back if it is absent. */
function loadPersona(name: string, fallback: string): string {
  const file = join(PERSONAS_DIR, name);
  try {
    const text = readFileSync(file, "utf8").trim();
    if (text) return text;
    logger.warn({ file }, "MCP persona is empty — using the fallback instructions");
  } catch (err) {
    logger.warn({ file, detail: (err as Error).message }, "MCP persona not found — using the fallback instructions");
  }
  return fallback;
}

/** The maestro persona handed to every connecting agent as the MCP server's `instructions`. */
export const INSTRUCTIONS = loadPersona("maestro.md", FALLBACK_INSTRUCTIONS);

/** What an EXTERNAL client (ChatGPT, Claude.ai — see auth/oauth.ts) is told the server is for. */
export const EXTERNAL_INSTRUCTIONS = loadPersona("external.md", EXTERNAL_FALLBACK_INSTRUCTIONS);

/**
 * One server instance per request — the HTTP transport here is stateless.
 *
 * `external` is a different server, not the maestro one with a filter: the caller has no card of
 * its own (so none of the "your own card" tools make sense) and acts as ONE user, so every tool
 * checks that user's reach. The maestro tools stay exactly what a card gets.
 */
export function createMcpServer(actor: "external", user: PublicUser): McpServer;
export function createMcpServer(actor?: string): McpServer;
export function createMcpServer(actor = "mcp", user?: PublicUser): McpServer {
  if (actor === "external") {
    if (!user) throw new Error("an external MCP server needs the user it acts for");
    const server = new McpServer({ name: "vibehub", version: "0.1.0" }, { instructions: EXTERNAL_INSTRUCTIONS });
    registerExternalTools(server, user);
    return server;
  }
  const server = new McpServer({ name: "vibehub", version: "0.1.0" }, { instructions: INSTRUCTIONS });
  registerMaestroTools(server, actor);
  registerCredentialTools(server, actor);
  return server;
}
