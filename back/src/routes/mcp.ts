import type { FastifyInstance } from "fastify";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createHash } from "node:crypto";
import { EXTERNAL_INSTRUCTIONS, INSTRUCTIONS, createMcpServer } from "../mcp/server.js";
import { handleModern, isModernRequest } from "../mcp/modern.js";
import type { WebhookPrincipal } from "../services/webhooks/subscriptions.js";
import { runnerToken } from "../runtime/runner.js";
import { currentUser, tokenMatches } from "../auth/session.js";
import { accessTokenHash, originOf, userForAccessToken } from "../auth/oauth.js";
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
 *
 * Two protocol eras on the one endpoint, behind the same credential check: a 2026-07-28 request
 * (version in `MCP-Protocol-Version` and `_meta`, no initialize) is answered by mcp/modern.ts —
 * which is where MCP Events webhooks live — and everything else by the SDK, as before.
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
      reply.header("WWW-Authenticate", `Bearer resource_metadata="${originOf(request)}/.well-known/oauth-protected-resource"`);
      return await reply.code(401).send({ error: "invalid or missing MCP token" });
    }

    // The credential, checked again while an event stream stays open (a stream must not outlive it).
    const principal = async () => {
      if (actor === "card") return tokenMatches(bearer, await runnerToken()) ? null : false;
      if (actor === "external") return (await userForAccessToken(bearer)) ?? false;
      return (await currentUser(request))?.role === "owner" ? null : false;
    };
    const make = () => (actor === "external" && user
      ? createMcpServer("external", user, principal)
      : createMcpServer(actor!, undefined, principal));

    if (isModernRequest(request.headers, request.body)) {
      // A webhook subscription outlives the request: it keeps the account (or the board) and the
      // HASH of the credential, re-checked at every delivery. A browser session holds no such grant.
      const holder: WebhookPrincipal | null = actor === "external" && user && bearer
        ? { key: `user:${user.id}`, user, credential: accessTokenHash(bearer) }
        : actor === "card" && bearer
          ? { key: "board", user: null, credential: createHash("sha256").update(bearer).digest("hex") }
          : null;
      const reply_ = await handleModern({
        headers: request.headers, body: request.body, server: make, principal: holder,
        instructions: actor === "external" ? EXTERNAL_INSTRUCTIONS : INSTRUCTIONS,
      });
      reply.code(reply_.status);
      return reply_.body === undefined ? await reply.send() : await reply.type("application/json").send(reply_.body);
    }

    const server = make();
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
