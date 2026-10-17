import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  OAuthError, authorizationServerMetadata, issueCode, protectedResourceMetadata, redeemCode, registerClient,
  validateAuthorizeRequest, originOf, MCP_SCOPE,
} from "../auth/oauth.js";
import { isUsername, verifyCredentials } from "../auth/users.js";
import { AttemptLimiter, LOGIN_ATTEMPTS_PER_ACCOUNT } from "./auth.js";
import { logger } from "../utils/logger.js";

/**
 * OAUTH ROUTES — the public door of the external MCP (see auth/oauth.ts for the model).
 *
 *   GET  /.well-known/oauth-protected-resource[/mcp]   RFC 9728
 *   GET  /.well-known/oauth-authorization-server       RFC 8414
 *   POST /oauth/register                                RFC 7591 (DCR)
 *   GET  /oauth/authorize                               the sign-in page
 *   POST /oauth/authorize                               sign in → code → back to the client
 *   POST /oauth/token                                   code + PKCE verifier → access token
 *
 * These are the only paths, with `/mcp`, that a public gateway needs to publish: the board itself
 * stays wherever it was (a VPN, a LAN).
 */

/** Failed sign-ins on the consent page per address+username, like the board's own sign-in. */
const limiter = new AttemptLimiter(LOGIN_ATTEMPTS_PER_ACCOUNT, 15 * 60_000);

const ESCAPE: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const esc = (v: unknown): string => String(v ?? "").replace(/[&<>"']/g, (c) => ESCAPE[c] ?? c);

type Lang = "pt" | "en";
const TEXT = {
  pt: {
    title: "vibehub — Autorizar acesso",
    heading: "Conectar ao vibehub",
    sub: (client: string) =>
      `${client ? `<b>${esc(client)}</b>` : "Um app"} quer operar o seu vibehub por MCP: listar, abrir e mandar ` +
      "tarefas para os cards que a sua conta alcança. Entre com a sua conta para autorizar.",
    user: "Usuário",
    pass: "Senha",
    submit: "Autorizar",
    redirecting: "Conectado. Voltando para o app…",
    cont: "Continuar",
    invalid: "Usuário ou senha inválidos.",
    tooMany: "Tentativas demais. Espere alguns minutos e tente de novo.",
  },
  en: {
    title: "vibehub — Authorize access",
    heading: "Connect to vibehub",
    sub: (client: string) =>
      `${client ? `<b>${esc(client)}</b>` : "An app"} wants to operate your vibehub over MCP: list, open and ` +
      "send work to the cards your account can reach. Sign in to authorize it.",
    user: "Username",
    pass: "Password",
    submit: "Authorize",
    redirecting: "Connected. Going back to the app…",
    cont: "Continue",
    invalid: "Invalid username or password.",
    tooMany: "Too many attempts. Wait a few minutes and try again.",
  },
} as const;

function langOf(req: FastifyRequest): Lang {
  return /^pt\b/i.test(String(req.headers["accept-language"] ?? "")) ? "pt" : "en";
}

const STYLE =
  "body{font-family:system-ui,-apple-system,sans-serif;background:#0b0b0c;color:#eee;display:flex;min-height:100vh;" +
  "align-items:center;justify-content:center;margin:0}.card{background:#161618;padding:32px;border-radius:14px;" +
  "width:340px;box-shadow:0 8px 40px #0008}h1{font-size:18px;margin:0 0 6px}p.sub{color:#aaa;font-size:13px;" +
  "margin:0 0 20px;line-height:1.45}label{display:block;font-size:12px;color:#bbb;margin:12px 0 4px}" +
  "input{width:100%;box-sizing:border-box;padding:10px;border-radius:8px;border:1px solid #333;background:#0e0e10;" +
  "color:#fff;font-size:14px}button{width:100%;margin-top:20px;padding:11px;border:0;border-radius:8px;" +
  "background:#4f46e5;color:#fff;font-size:14px;font-weight:600;cursor:pointer}" +
  ".erro{background:#3a1212;color:#f5b5b5;padding:8px 10px;border-radius:8px;font-size:13px;margin-bottom:8px}";

interface AuthorizeParams {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  state: string;
  scope: string;
  resource: string;
}

function paramsOf(src: Record<string, unknown> | undefined): AuthorizeParams {
  const s = (k: string) => (typeof src?.[k] === "string" ? (src[k] as string) : "");
  return {
    clientId: s("client_id"),
    redirectUri: s("redirect_uri"),
    codeChallenge: s("code_challenge"),
    codeChallengeMethod: s("code_challenge_method") || "S256",
    state: s("state"),
    scope: s("scope"),
    resource: s("resource"),
  };
}

function loginPage(lang: Lang, p: AuthorizeParams, clientName: string, opts: { error?: string; username?: string } = {}): string {
  const t = TEXT[lang];
  const hidden = ([
    ["client_id", p.clientId], ["redirect_uri", p.redirectUri], ["code_challenge", p.codeChallenge],
    ["code_challenge_method", p.codeChallengeMethod], ["state", p.state], ["scope", p.scope], ["resource", p.resource],
  ] as const).map(([k, v]) => `<input type="hidden" name="${k}" value="${esc(v)}">`).join("");
  return `<!doctype html><html lang="${lang === "pt" ? "pt-br" : "en"}"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1"><title>${t.title}</title><style>${STYLE}</style></head>` +
    `<body><form class="card" method="post" action="/oauth/authorize"><h1>${t.heading}</h1><p class="sub">${t.sub(clientName)}</p>` +
    (opts.error ? `<div class="erro">${esc(opts.error)}</div>` : "") +
    `<label>${t.user}</label><input name="username" value="${esc(opts.username ?? "")}" autofocus autocomplete="username" autocapitalize="none">` +
    `<label>${t.pass}</label><input name="password" type="password" autocomplete="current-password">` +
    `${hidden}<button type="submit">${t.submit}</button></form></body></html>`;
}

/** A page with the error itself — never a redirect, since the redirect is what failed validation. */
function errorPage(lang: Lang, message: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>${TEXT[lang].title}</title><style>${STYLE}</style></head><body><div class="card"><h1>${TEXT[lang].heading}</h1>` +
    `<div class="erro">${esc(message)}</div></div></body></html>`;
}

/**
 * Back to the client with the code. A page that navigates rather than a 302: a POST answered with
 * a redirect is not followed by every OAuth popup (ChatGPT's among them), a script navigation is.
 */
function redirectPage(lang: Lang, url: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=${esc(url)}">` +
    `<title>${TEXT[lang].title}</title><style>${STYLE}</style></head><body><div class="card"><p>${TEXT[lang].redirecting}</p>` +
    `<p><a style="color:#8b8bff" href="${esc(url)}">${TEXT[lang].cont}</a></p></div>` +
    `<script>window.location.replace(${JSON.stringify(url).replace(/</g, "\\u003c")});</script></body></html>`;
}

async function oauthFailure(reply: FastifyReply, err: unknown): Promise<FastifyReply> {
  if (err instanceof OAuthError) {
    return await reply.code(400).header("cache-control", "no-store")
      .send({ error: err.code, error_description: err.message });
  }
  logger.error({ err: (err as Error).message }, "oauth request failed");
  return await reply.code(500).send({ error: "server_error" });
}

export async function oauthRoutes(app: FastifyInstance): Promise<void> {
  // The authorize form and the token request are form-encoded (RFC 6749). Scoped to this plugin:
  // nothing else in the API accepts forms.
  app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (_req, body, done) => {
    done(null, Object.fromEntries(new URLSearchParams(String(body))));
  });

  // RFC 9728 lets a client look the metadata up with the resource's path appended — and some only do.
  for (const path of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"]) {
    app.get(path, async (req, reply) => await reply.send(protectedResourceMetadata(originOf(req))));
  }
  app.get("/.well-known/oauth-authorization-server", async (req, reply) =>
    await reply.send(authorizationServerMetadata(originOf(req))),
  );

  app.post<{ Body: { client_name?: unknown; redirect_uris?: unknown } }>("/oauth/register", async (req, reply) => {
    try {
      const client = await registerClient({ clientName: req.body?.client_name, redirectUris: req.body?.redirect_uris });
      logger.info({ client: client.clientId, name: client.clientName }, "oauth client registered");
      return await reply.code(201).send({
        client_id: client.clientId,
        client_id_issued_at: Math.floor(client.createdAt / 1000),
        client_name: client.clientName,
        redirect_uris: client.redirectUris,
        grant_types: ["authorization_code"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
        scope: MCP_SCOPE,
      });
    } catch (err) {
      return await oauthFailure(reply, err);
    }
  });

  app.get<{ Querystring: Record<string, unknown> }>("/oauth/authorize", async (req, reply) => {
    const lang = langOf(req);
    const p = paramsOf(req.query);
    reply.type("text/html").header("cache-control", "no-store").header("x-frame-options", "DENY");
    if (req.query?.response_type !== "code") return await reply.code(400).send(errorPage(lang, "response_type must be 'code'"));
    try {
      const client = await validateAuthorizeRequest(originOf(req), p);
      return await reply.send(loginPage(lang, p, client.clientName));
    } catch (err) {
      return await reply.code(400).send(errorPage(lang, (err as Error).message));
    }
  });

  app.post<{ Body: Record<string, unknown> }>("/oauth/authorize", async (req, reply) => {
    const lang = langOf(req);
    const p = paramsOf(req.body);
    reply.type("text/html").header("cache-control", "no-store").header("x-frame-options", "DENY");
    let clientName = "";
    try {
      clientName = (await validateAuthorizeRequest(originOf(req), p)).clientName;
    } catch (err) {
      return await reply.code(400).send(errorPage(lang, (err as Error).message));
    }

    const username = String(req.body?.username ?? "").trim().toLowerCase();
    const password = String(req.body?.password ?? "");
    const key = `${req.ip}|${username}`;
    const wait = limiter.hit(key);
    if (wait > 0) {
      return await reply.code(429).header("retry-after", String(wait))
        .send(loginPage(lang, p, clientName, { error: TEXT[lang].tooMany, username }));
    }
    const user = isUsername(username) ? await verifyCredentials(username, password) : null;
    if (!user) {
      return await reply.code(401).send(loginPage(lang, p, clientName, { error: TEXT[lang].invalid, username }));
    }
    limiter.clear(key);

    const code = issueCode({
      clientId: p.clientId, redirectUri: p.redirectUri, codeChallenge: p.codeChallenge, userId: user.id, scope: MCP_SCOPE,
    });
    logger.info({ user: user.username, client: p.clientId, name: clientName }, "oauth authorization granted");
    const back = new URL(p.redirectUri);
    back.searchParams.set("code", code);
    if (p.state) back.searchParams.set("state", p.state);
    back.searchParams.set("iss", originOf(req));
    return await reply.send(redirectPage(lang, back.toString()));
  });

  app.post<{ Body: Record<string, unknown> }>("/oauth/token", async (req, reply) => {
    const b = req.body ?? {};
    const s = (k: string) => (typeof b[k] === "string" ? (b[k] as string) : "");
    if (s("grant_type") !== "authorization_code") {
      return await reply.code(400).send({ error: "unsupported_grant_type", error_description: "only authorization_code is supported" });
    }
    try {
      const token = await redeemCode(originOf(req), {
        code: s("code"), codeVerifier: s("code_verifier"), clientId: s("client_id"), redirectUri: s("redirect_uri"),
        resource: s("resource") || undefined,
      });
      return await reply.header("cache-control", "no-store").header("pragma", "no-cache").send(token);
    } catch (err) {
      return await oauthFailure(reply, err);
    }
  });
}
