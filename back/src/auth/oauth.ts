import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { config, dataPath } from "../config/env.js";
import { JsonStore } from "../store/jsonStore.js";
import { sessionUser, type PublicUser } from "./users.js";

/**
 * OAUTH FOR THE EXTERNAL MCP — how a client on the internet (ChatGPT, Claude.ai) gets a token for
 * `/mcp` on behalf of a vibehub ACCOUNT, without that account handing it a password or a cookie.
 *
 * The flow is OAuth 2.1 with the pieces MCP clients expect and nothing else:
 *  - Dynamic Client Registration (RFC 7591): the client registers itself, no secret (public client);
 *  - authorization code + PKCE S256 (mandatory — there is no client secret to fall back on);
 *  - the code is redeemed for an opaque bearer token bound to ONE user.
 *
 * The token is the user, never the install: whatever it reaches, it reaches as that user's role and
 * shares (see mcp/externalTools.ts). It dies with the account, and with every session of it when the
 * password changes — it is checked against `sessionsValidAfter` exactly like a cookie is.
 *
 * Tokens are stored HASHED: the file holding them is a list of who connected what, not a list of
 * credentials someone who reads `/data` could replay.
 */

/** How long an authorization code may wait to be redeemed. */
export const CODE_TTL_MS = 10 * 60_000;
/** How long an access token lives. No refresh token: past this the client asks the user to connect again. */
export const TOKEN_TTL_MS = 90 * 24 * 60 * 60_000;
/** Registration is unauthenticated, so the list is capped; past it the oldest client with no token goes. */
export const MAX_CLIENTS = 100;
/** The one scope there is. Requested or not, a token reaches what its user reaches — no more. */
export const MCP_SCOPE = "mcp";
/** Prefix of every access token, so one is recognisable at a glance (and in a leaked log). */
const TOKEN_PREFIX = "vhm_";

export interface OAuthClient {
  clientId: string;
  clientName: string;
  redirectUris: string[];
  createdAt: number;
}

export interface OAuthToken {
  /** sha256 of the token, hex. The token itself is never stored. */
  hash: string;
  userId: string;
  clientId: string;
  clientName: string;
  issuedAt: number;
  expiresAt: number;
}

interface OAuthDoc {
  clients: OAuthClient[];
  tokens: OAuthToken[];
}

const store = new JsonStore<OAuthDoc>(
  dataPath("oauth.json"),
  () => ({ clients: [], tokens: [] }),
  (raw) => ({
    clients: Array.isArray((raw as OAuthDoc)?.clients) ? (raw as OAuthDoc).clients : [],
    tokens: Array.isArray((raw as OAuthDoc)?.tokens) ? (raw as OAuthDoc).tokens : [],
  }),
);

interface PendingCode {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  userId: string;
  scope: string;
  expiresAt: number;
}

/**
 * Authorization codes live ten minutes and are redeemed seconds after they are issued: memory is
 * enough, and a restart in between only means the user clicks "connect" again.
 */
const codes = new Map<string, PendingCode>();

/** A refusal the routes turn into the OAuth error body (`error` is the RFC code, the message is for people). */
export class OAuthError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "OAuthError";
  }
}

/* ------------------------------------------------------------------ metadata */

/** The public origin the metadata announces — `VIBEHUB_MCP_PUBLIC_URL`, else `VIBEHUB_PUBLIC_URL`. */
export function issuer(): string {
  return (config.mcpPublicUrl || config.publicUrl).replace(/\/+$/, "");
}

/** The resource every token is for: the MCP endpoint on the public origin. */
export function resourceUrl(): string {
  return `${issuer()}/mcp`;
}

/** RFC 9728 — where a client that got a 401 from `/mcp` learns how to authenticate. */
export function protectedResourceMetadata() {
  return {
    resource: resourceUrl(),
    authorization_servers: [issuer()],
    bearer_methods_supported: ["header"],
    scopes_supported: [MCP_SCOPE],
  };
}

/** RFC 8414 — the authorization server's endpoints and what it supports. */
export function authorizationServerMetadata() {
  const base = issuer();
  return {
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    registration_endpoint: `${base}/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: [MCP_SCOPE],
  };
}

/* -------------------------------------------------------------- registration */

/**
 * Only https redirects, plus loopback http for desktop clients (RFC 8252 §7.3). A redirect URI is
 * where the code is sent, so anything else would let a registration ship codes to a plain-text
 * listener.
 */
function isAcceptableRedirect(uri: string): boolean {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return false;
  }
  if (url.hash) return false;
  if (url.protocol === "https:") return true;
  return url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
}

/** Dynamic Client Registration (RFC 7591). */
export async function registerClient(input: { clientName?: unknown; redirectUris?: unknown }): Promise<OAuthClient> {
  const redirectUris = Array.isArray(input.redirectUris) ? input.redirectUris.map(String) : [];
  if (redirectUris.length === 0 || redirectUris.length > 10) {
    throw new OAuthError("invalid_redirect_uri", "redirect_uris must list 1 to 10 URIs");
  }
  const bad = redirectUris.find((u) => !isAcceptableRedirect(u));
  if (bad) throw new OAuthError("invalid_redirect_uri", `redirect_uri not allowed: ${bad}`);

  const client: OAuthClient = {
    clientId: randomBytes(16).toString("hex"),
    clientName: String(input.clientName ?? "").slice(0, 100),
    redirectUris,
    createdAt: Date.now(),
  };
  await store.mutate((doc) => {
    doc.clients.push(client);
    if (doc.clients.length > MAX_CLIENTS) {
      const inUse = new Set(doc.tokens.map((t) => t.clientId));
      const victim = doc.clients.findIndex((c) => !inUse.has(c.clientId) && c.clientId !== client.clientId);
      if (victim >= 0) doc.clients.splice(victim, 1);
    }
  });
  return client;
}

export async function findClient(clientId: string): Promise<OAuthClient | null> {
  const id = String(clientId ?? "");
  if (!id) return null;
  return (await store.load()).clients.find((c) => c.clientId === id) ?? null;
}

/**
 * Is `requested` one of the client's redirect URIs? Exact match, except that a LOOPBACK redirect
 * may differ in its port: desktop clients listen on a random port per sign-in (RFC 8252 §7.3).
 */
export function redirectMatches(registered: readonly string[], requested: string): boolean {
  if (registered.includes(requested)) return true;
  let want: URL;
  try {
    want = new URL(requested);
  } catch {
    return false;
  }
  if (want.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]"].includes(want.hostname)) return false;
  return registered.some((r) => {
    try {
      const have = new URL(r);
      return have.protocol === want.protocol && have.hostname === want.hostname && have.pathname === want.pathname
        && have.search === want.search;
    } catch {
      return false;
    }
  });
}

/**
 * Checks an authorization request BEFORE the sign-in page is shown — and before anything is ever
 * redirected: an unknown client or a redirect it never registered must not become an open
 * redirect, so these are answered on the page itself, not sent back to `redirect_uri`.
 */
export async function validateAuthorizeRequest(q: {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  resource?: string;
}): Promise<OAuthClient> {
  const client = await findClient(q.clientId);
  if (!client) throw new OAuthError("invalid_client", "unknown client_id — connect again from the app");
  if (!redirectMatches(client.redirectUris, q.redirectUri)) {
    throw new OAuthError("invalid_request", "redirect_uri is not registered for this client");
  }
  if (q.codeChallengeMethod !== "S256") throw new OAuthError("invalid_request", "only PKCE S256 is supported");
  if (!/^[A-Za-z0-9_-]{43,128}$/.test(q.codeChallenge)) {
    throw new OAuthError("invalid_request", "code_challenge is required (PKCE S256)");
  }
  if (q.resource && q.resource.replace(/\/+$/, "") !== resourceUrl()) {
    throw new OAuthError("invalid_target", `this server only issues tokens for ${resourceUrl()}`);
  }
  return client;
}

/* --------------------------------------------------------------------- codes */

/** Issues a single-use code for an authorization the user just approved by signing in. */
export function issueCode(entry: Omit<PendingCode, "expiresAt">, now: number = Date.now()): string {
  for (const [code, pending] of codes) if (pending.expiresAt <= now) codes.delete(code);
  const code = randomBytes(32).toString("base64url");
  codes.set(code, { ...entry, expiresAt: now + CODE_TTL_MS });
  return code;
}

function pkceMatches(verifier: string, challenge: string): boolean {
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) return false;
  const computed = Buffer.from(createHash("sha256").update(verifier).digest("base64url"));
  const expected = Buffer.from(challenge);
  return computed.length === expected.length && timingSafeEqual(computed, expected);
}

const hashToken = (token: string): string => createHash("sha256").update(token).digest("hex");

/**
 * Redeems a code for an access token (RFC 6749 §4.1.3 + PKCE). The code is gone after the first
 * try, right or wrong: a replay — or a guess at the verifier — never gets a second chance.
 */
export async function redeemCode(input: {
  code: string;
  codeVerifier: string;
  clientId: string;
  redirectUri: string;
  resource?: string;
}, now: number = Date.now()): Promise<{ access_token: string; token_type: "Bearer"; expires_in: number; scope: string }> {
  const pending = codes.get(String(input.code ?? ""));
  codes.delete(String(input.code ?? ""));
  if (!pending || pending.expiresAt <= now) throw new OAuthError("invalid_grant", "code is invalid or expired");
  if (pending.clientId !== input.clientId) throw new OAuthError("invalid_grant", "client_id does not match the code");
  if (pending.redirectUri !== input.redirectUri) throw new OAuthError("invalid_grant", "redirect_uri does not match the code");
  if (!pkceMatches(String(input.codeVerifier ?? ""), pending.codeChallenge)) {
    throw new OAuthError("invalid_grant", "code_verifier does not match the code_challenge");
  }
  if (input.resource && input.resource.replace(/\/+$/, "") !== resourceUrl()) {
    throw new OAuthError("invalid_target", `this server only issues tokens for ${resourceUrl()}`);
  }
  const client = await findClient(pending.clientId);
  if (!client) throw new OAuthError("invalid_client", "the client was removed");

  const token = TOKEN_PREFIX + randomBytes(32).toString("base64url");
  await store.mutate((doc) => {
    doc.tokens = doc.tokens.filter((t) => t.expiresAt > now);
    doc.tokens.push({
      hash: hashToken(token),
      userId: pending.userId,
      clientId: client.clientId,
      clientName: client.clientName,
      issuedAt: now,
      expiresAt: now + TOKEN_TTL_MS,
    });
  });
  return { access_token: token, token_type: "Bearer", expires_in: Math.floor(TOKEN_TTL_MS / 1000), scope: MCP_SCOPE };
}

/* -------------------------------------------------------------------- tokens */

/** Is this string shaped like one of our access tokens? (Cheap filter before any lookup.) */
export function looksLikeAccessToken(token: string | undefined): boolean {
  return typeof token === "string" && token.startsWith(TOKEN_PREFIX) && token.length > TOKEN_PREFIX.length + 20;
}

/**
 * The user an access token speaks for — null when the token is unknown, expired, or its user was
 * removed or signed out everywhere (password change) after it was issued.
 */
export async function userForAccessToken(token: string | undefined, now: number = Date.now()): Promise<PublicUser | null> {
  if (!looksLikeAccessToken(token)) return null;
  const hash = hashToken(token as string);
  const record = (await store.load()).tokens.find((t) => t.hash === hash);
  if (!record || record.expiresAt <= now) return null;
  return await sessionUser(record.userId, record.issuedAt);
}

/** Test hook: forget every pending code and the cached document. */
export function resetOAuthForTesting(): void {
  codes.clear();
  store.resetForTesting();
}
