import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { DEFINITION } from "./events.js";
import { EventsError, subscribeWebhook, unsubscribeWebhook, type WebhookPrincipal } from "../services/webhooks/subscriptions.js";
import { logger } from "../utils/logger.js";

/**
 * MCP 2026-07-28 ("modern", stateless) ON THE SAME /mcp. The official TypeScript SDK only speaks up
 * to 2025-11-25 (initialize handshake), so a modern request — the version in `MCP-Protocol-Version`
 * and in `params._meta` — is answered here, and everything else keeps going to the SDK untouched
 * (spec: basic/versioning, "dual-era server ... MAY serve both eras concurrently on the same endpoint").
 *
 * What it serves, and nothing else (unknown methods → 404 + -32601, per the transport):
 *  - `server/discover` (MUST): versions, capabilities `tools` + `events`, instructions;
 *  - `tools/list` / `tools/call`: forwarded in-process to the SAME McpServer a legacy client of this
 *    caller gets — one tool implementation, one ACL — and given `resultType` (+ cache hints);
 *  - `events/list`, `events/subscribe`, `events/unsubscribe`: MCP Events in webhook mode, the only
 *    mode ChatGPT uses (developers.openai.com/plugins/build/mcp-events).
 *
 * Header validation: a mirrored header that DISAGREES with the body is a 400 HeaderMismatch (-32020).
 * A missing `Mcp-Method`/`Mcp-Name` is tolerated (the version header is required — it is how a
 * request is recognised as modern): rejecting it would only lock out a client that omits a mirror
 * meant for intermediaries, while the body stays the single source of truth here.
 */

export const MODERN_VERSION = "2026-07-28";
const VERSION_KEY = "io.modelcontextprotocol/protocolVersion";
const SERVER_INFO = { "io.modelcontextprotocol/serverInfo": { name: "vibehub", version: "0.1.0" } };
/** How long a client may cache discover / tools/list. Private: they vary with the account. */
const CACHE = { ttlMs: 5 * 60_000, cacheScope: "private" as const };

const HEADER_MISMATCH = -32020;
const UNSUPPORTED_VERSION = -32022;

type Headers = Record<string, string | string[] | undefined>;
interface RpcBody { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: Record<string, unknown> }

const header = (headers: Headers, name: string): string | undefined => {
  const v = headers[name];
  return Array.isArray(v) ? v[0] : v;
};

/** Is this a 2026-07-28-era request (versus a legacy one the SDK handles)? */
export function isModernRequest(headers: Headers, body: unknown): boolean {
  const b = (body ?? {}) as RpcBody;
  if (typeof (b.params?._meta as Record<string, unknown> | undefined)?.[VERSION_KEY] === "string") return true;
  return header(headers, "mcp-protocol-version") === MODERN_VERSION && b.method !== "initialize";
}

/** `=?base64?…?=` → the decoded value (the transport's encoding for non-ASCII header values). */
function headerValue(raw: string): string {
  const m = /^=\?base64\?(.*)\?=$/.exec(raw);
  return m ? Buffer.from(m[1]!, "base64").toString("utf8") : raw;
}

export interface ModernContext {
  headers: Headers;
  body: unknown;
  /** The SDK server this caller would get on the legacy path (its tools, its ACL). */
  server: () => McpServer;
  instructions: string;
  /** Who may hold webhook subscriptions; null = this credential cannot (a browser session). */
  principal: WebhookPrincipal | null;
}

export interface ModernReply { status: number; body?: unknown }

const error = (status: number, id: unknown, code: number, message: string, data?: unknown): ModernReply =>
  ({ status, body: { jsonrpc: "2.0", id: id ?? null, error: { code, message, ...(data === undefined ? {} : { data }) } } });

/** Calls the caller's own SDK server in process, as a legacy client would. */
async function viaSdk(make: () => McpServer, method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
  const { _meta: _ignored, ...rest } = params;
  const server = make();
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "vibehub-modern-bridge", version: "0.1.0" });
  try {
    await server.connect(serverSide);
    await client.connect(clientSide);
    return await client.request({ method, params: rest } as never, z.object({}).passthrough());
  } finally {
    await client.close();
    await server.close();
  }
}

async function dispatch(ctx: ModernContext, method: string, params: Record<string, unknown>): Promise<Record<string, unknown> | null> {
  switch (method) {
    case "server/discover":
      return { supportedVersions: [MODERN_VERSION], capabilities: { tools: {}, events: {} }, instructions: ctx.instructions, ...CACHE };
    case "tools/list":
      return { ...(await viaSdk(ctx.server, method, params)), ...CACHE };
    case "tools/call":
      return await viaSdk(ctx.server, method, params);
    case "events/list":
      return { events: [{ ...DEFINITION, delivery: ["webhook"] }] };
    case "events/subscribe":
      return { ...(await subscribeWebhook(ctx.principal, params)) };
    case "events/unsubscribe":
      return await unsubscribeWebhook(ctx.principal, params);
    default:
      return null;
  }
}

/** Answers one modern JSON-RPC message. */
export async function handleModern(ctx: ModernContext): Promise<ModernReply> {
  const body = ctx.body as RpcBody | null;
  if (!body || typeof body !== "object" || Array.isArray(body) || typeof body.method !== "string") {
    return error(400, null, -32600, "Invalid Request: one JSON-RPC request or notification per POST");
  }
  const { id, method } = body;
  if (id === undefined) return { status: 202 }; // no client→server notification means anything to this server
  const params = body.params && typeof body.params === "object" ? body.params : {};
  const inHeader = header(ctx.headers, "mcp-protocol-version");
  const inMeta = (params._meta as Record<string, unknown> | undefined)?.[VERSION_KEY];
  if (!inHeader) return error(400, id, HEADER_MISMATCH, "Header mismatch: MCP-Protocol-Version is required");
  if (typeof inMeta === "string" && inMeta !== inHeader) {
    return error(400, id, HEADER_MISMATCH, `Header mismatch: MCP-Protocol-Version '${inHeader}' does not match _meta '${inMeta}'`);
  }
  const mcpMethod = header(ctx.headers, "mcp-method");
  if (mcpMethod !== undefined && headerValue(mcpMethod) !== method) {
    return error(400, id, HEADER_MISMATCH, `Header mismatch: Mcp-Method '${mcpMethod}' does not match body '${method}'`);
  }
  const mcpName = header(ctx.headers, "mcp-name");
  const bodyName = params.name ?? params.uri;
  if (mcpName !== undefined && typeof bodyName === "string" && headerValue(mcpName) !== bodyName) {
    return error(400, id, HEADER_MISMATCH, "Header mismatch: Mcp-Name does not match the body");
  }
  const version = typeof inMeta === "string" ? inMeta : inHeader;
  if (version !== MODERN_VERSION) {
    return error(400, id, UNSUPPORTED_VERSION, "Unsupported protocol version", { supported: [MODERN_VERSION], requested: version });
  }

  try {
    const result = await dispatch(ctx, method, params);
    if (!result) return error(404, id, -32601, `Method not found: ${method}`);
    const meta = { ...(result._meta as Record<string, unknown> | undefined), ...SERVER_INFO };
    return { status: 200, body: { jsonrpc: "2.0", id, result: { ...result, resultType: "complete", _meta: meta } } };
  } catch (err) {
    if (err instanceof EventsError || err instanceof McpError) {
      return error(200, id, err.code, err.message, (err as { data?: unknown }).data);
    }
    logger.error({ method, detail: (err as Error).message }, "MCP 2026-07-28 request failed");
    return error(200, id, -32603, "Internal error");
  }
}
