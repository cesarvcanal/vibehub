import type { FastifyInstance } from "fastify";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpServer } from "../mcp/server.js";
import { runnerToken } from "../runtime/runner.js";
import { currentUser, tokenMatches } from "../auth/session.js";
import { issuer, userForAccessToken } from "../auth/oauth.js";
import type { PublicUser } from "../auth/users.js";
import { logger } from "../utils/logger.js";

/**
 * MCP endpoint — how an agent INSIDE a card reaches the board it is running on (the maestro tools).
 *
 * Three credentials, three callers:
 *  - the runner's service token, as a Bearer header: a Claude process in a card (no cookie jar, but
 *    the token vibehub planted there) — the maestro tools, reaching every card;
 *  - an OAuth access token (auth/oauth.ts): an app on the internet (ChatGPT, Claude.ai) acting as
 *    ONE user — the external tools, narrowed to that user's role and shares;
 *  - an OWNER's browser session, so the maestro tools can be exercised from the UI or curl while
 *    debugging. A member's session is not: those tools reach every card on the board.
 *
 * The 401 points at the OAuth metadata (RFC 9728), which is how an MCP client discovers it can sign in.
 *
 * Stateless on purpose: one server and one transport per request, both closed when the response
 * ends. There is no session to leak between cards.
 */

/** Pulls the bearer value out of an Authorization header. */
export function bearerToken(header: string | undefined): string | undefined {
  const match = /^Bearer\s+(.+)$/i.exec(String(header ?? "").trim());
  return match?.[1]?.trim() || undefined;
}

export async function mcpRoutes(app: FastifyInstance): Promise<void> {
  app.post("/mcp", async (request, reply) => {
    // The actor is decided by the credential that ACTUALLY authenticated: an owner's browser that
    // also sends a stale or junk bearer is still the browser, and the audit must say so.
    const bearer = bearerToken(request.headers.authorization);
    let actor: "card" | "external" | "browser" | null = null;
    let user: PublicUser | null = null;
    if (tokenMatches(bearer, await runnerToken())) {
      actor = "card";
    } else if ((user = await userForAccessToken(bearer))) {
      actor = "external";
    } else if ((await currentUser(request))?.role === "owner") {
      actor = "browser";
    }
    if (!actor) {
      reply.header("WWW-Authenticate", `Bearer resource_metadata="${issuer()}/.well-known/oauth-protected-resource"`);
      return await reply.code(401).send({ error: "invalid or missing MCP token" });
    }

    const server = actor === "external" && user ? createMcpServer("external", user) : createMcpServer(actor);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    reply.raw.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      reply.hijack();
      await transport.handleRequest(request.raw, reply.raw, request.body);
    } catch (err) {
      logger.error({ err: (err as Error).message }, "MCP request failed");
      if (!reply.raw.headersSent) {
        reply.raw.writeHead(500, { "content-type": "application/json" });
        reply.raw.end(JSON.stringify({ error: (err as Error).message }));
      }
    }
  });

  app.get("/mcp", async (_req, reply) =>
    await reply.code(405).send({ error: "use POST (MCP streamable HTTP)" }),
  );
}
