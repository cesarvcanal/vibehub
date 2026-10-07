import type { FastifyInstance } from "fastify";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpServer } from "../mcp/server.js";
import { runnerToken } from "../runtime/runner.js";
import { currentUser, tokenMatches } from "../auth/session.js";
import { logger } from "../utils/logger.js";

/**
 * MCP endpoint — how an agent INSIDE a card reaches the board it is running on (the maestro tools).
 *
 * Authentication is the runner's service token, as a Bearer header: the caller is a Claude process
 * in the runner container, which has no cookie jar but does have the token that vibehub planted
 * there. An OWNER's browser session is also accepted, so the endpoint can be exercised from the UI
 * or curl while debugging — a member's is not: these tools reach every card on the board and can
 * type into any of them, which is exactly what a member is not allowed to do.
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
    const actor = tokenMatches(bearerToken(request.headers.authorization), await runnerToken())
      ? "card"
      : (await currentUser(request))?.role === "owner" ? "browser" : null;
    if (!actor) {
      reply.header("WWW-Authenticate", "Bearer");
      return await reply.code(401).send({ error: "invalid or missing MCP token" });
    }

    const server = createMcpServer(actor);
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
