import type { FastifyInstance } from "fastify";
import { requireSession } from "../auth/session.js";
import * as registry from "../services/board/registry.js";
import { cardWorkPaths, restartStaggered } from "../services/board/workspace.js";
import { setAccountToken, removeAccountToken, accountsTokenStatus } from "../services/accounts/token.js";
import { allAccountsUsage } from "../services/accounts/usage.js";
import { applyMcpsEverywhere, setMcpSecretById, mcpSecretsStatus } from "../services/mcp/mcp.js";
import { brainView, setBrainText, resetBrain, applyBrainEverywhere } from "../services/brain/brain.js";
import { importSessions, type ImportInput } from "../services/import/import.js";
import { transcribeCardAudio, transcribeStatus, setTranscribeKeys, AUDIO_MAX_BYTES } from "../services/transcribe/transcribe.js";
import { logger } from "../utils/logger.js";

/**
 * AGENT CONFIGURATION — the things that shape how Claude runs inside the runner rather than what the
 * board looks like: account tokens, MCP servers, the shared brain, and adopting sessions that
 * already exist elsewhere.
 */

function fail(err: unknown): { code: number; body: { error: string } } {
  const message = (err as Error).message ?? "invalid request";
  if (/not found/i.test(message)) return { code: 404, body: { error: message } };
  // "the runner is not provisioned / not running / unreachable" is an environment problem, not a
  // malformed request — the UI shows those differently.
  if (/runner/i.test(message)) return { code: 502, body: { error: message } };
  return { code: 400, body: { error: message } };
}

/** What every auto-applying save reports back, so the UI can say what actually happened. */
interface AutoApplyResult {
  applied: boolean;
  restarted: number;
  pending: number;
}

/**
 * AUTO-APPLY on a brain/MCP save: rewrite the file inside the runner and run the STAGGERED restart
 * (idle cards restart now; working cards get a pending restart instead of being interrupted).
 * Without this the change is invisible until somebody restarts each card by hand, because Claude
 * only reads the brain and the MCPs when a session starts.
 *
 * It is BEST-EFFORT ON PURPOSE — the save has ALREADY been persisted before we get here, so a runner
 * that is down, an unreachable vault or an MCP secret that has not been filled in yet (applyMcps is
 * fail-closed) must NOT fail the save nor make the edit disappear; it only lands in the log, and the
 * explicit "apply now" button stays as the path that fails loudly.
 */
async function autoApply(
  reason: "brain" | "mcp",
  apply: () => Promise<unknown>,
): Promise<AutoApplyResult> {
  try {
    await apply();
    const { restarted, pending } = await restartStaggered(reason);
    return { applied: true, restarted, pending };
  } catch (err) {
    logger.warn(
      { action: "agent.autoApply", reason, detail: (err as Error).message },
      "auto-apply failed (the save is persisted; use \"apply now\" to force it)",
    );
    return { applied: false, restarted: 0, pending: 0 };
  }
}

export async function agentRoutes(app: FastifyInstance): Promise<void> {
  /* ------------------------------------------------------- Claude accounts */

  app.get("/api/accounts/tokens", { preHandler: requireSession }, async (_req, reply) => {
    return await reply.send(await accountsTokenStatus());
  });

  /**
   * PLAN USAGE per account. Never fails: the service turns a runner that is down, a profile with no
   * interactive login and a throttled endpoint into a per-account `error`, because this feeds a
   * widget that must not be able to break the board.
   */
  app.get("/api/accounts/usage", { preHandler: requireSession }, async (_req, reply) => {
    return await reply.send(await allAccountsUsage());
  });

  app.post<{ Params: { slug: string }; Body: { token?: string } }>(
    "/api/accounts/:slug/token", { preHandler: requireSession },
    async (req, reply) => {
      try {
        return await reply.send(await setAccountToken(req.params.slug, req.body?.token ?? ""));
      } catch (err) {
        const { code, body } = fail(err);
        return await reply.code(code).send(body);
      }
    },
  );

  app.delete<{ Params: { slug: string } }>(
    "/api/accounts/:slug/token", { preHandler: requireSession },
    async (req, reply) => {
      try {
        return await reply.send(await removeAccountToken(req.params.slug));
      } catch (err) {
        const { code, body } = fail(err);
        return await reply.code(code).send(body);
      }
    },
  );

  /* ------------------------------------------------------------ MCP servers */

  app.get("/api/mcps", { preHandler: requireSession }, async (_req, reply) => {
    return await reply.send({ mcps: await registry.listMcps() });
  });

  app.post<{ Body: registry.CreateMcpInput }>("/api/mcps", { preHandler: requireSession }, async (req, reply) => {
    try {
      const mcp = await registry.createMcp(req.body ?? ({} as registry.CreateMcpInput));
      // Auto-applied on save (best-effort): an MCP whose secret is still missing is a silent no-op
      // (applyMcpsEverywhere is fail-closed) — the value arrives later through the secret route,
      // which applies again.
      return await reply.send({ mcp, ...(await autoApply("mcp", applyMcpsEverywhere)) });
    } catch (err) {
      const { code, body } = fail(err);
      return await reply.code(code).send(body);
    }
  });

  app.delete<{ Params: { id: string } }>("/api/mcps/:id", { preHandler: requireSession }, async (req, reply) => {
    try {
      const mcp = await registry.removeMcp(req.params.id);
      // Auto-applied on save (best-effort): drops the MCP from the runner right away + staggered restart.
      return await reply.send({ mcp, ...(await autoApply("mcp", applyMcpsEverywhere)) });
    } catch (err) {
      const { code, body } = fail(err);
      return await reply.code(code).send(body);
    }
  });

  app.post<{ Params: { id: string }; Body: { key?: string; value?: string } }>(
    "/api/mcps/:id/secret", { preHandler: requireSession },
    async (req, reply) => {
      try {
        await setMcpSecretById(req.params.id, req.body?.key ?? "", req.body?.value ?? "");
        // Auto-applied on save (best-effort): this is the moment the MCP becomes usable, so inject it
        // into the runner + staggered restart. The value itself is never logged.
        return await reply.send({ ok: true, ...(await autoApply("mcp", applyMcpsEverywhere)) });
      } catch (err) {
        const { code, body } = fail(err);
        return await reply.code(code).send(body);
      }
    },
  );

  /**
   * Which declared env vars / headers already have a value in the vault. Names and booleans only —
   * the values themselves never leave the server.
   */
  app.get("/api/mcps/secrets", { preHandler: requireSession }, async (_req, reply) => {
    const mcps = await registry.listMcps();
    const entries = await Promise.all(mcps.map(async (mcp) => [mcp.id, await mcpSecretsStatus(mcp)] as const));
    return await reply.send({ byMcp: Object.fromEntries(entries) });
  });

  app.post("/api/mcps/apply", { preHandler: requireSession }, async (_req, reply) => {
    try {
      return await reply.send({ ok: true, ...(await applyMcpsEverywhere()) });
    } catch (err) {
      const { code, body } = fail(err);
      return await reply.code(code).send(body);
    }
  });

  /* ------------------------------------------------------------------ brain */

  app.get("/api/brain", { preHandler: requireSession }, async (_req, reply) => {
    return await reply.send(await brainView());
  });

  /**
   * PERSISTS and AUTO-APPLIES: besides saving, it rewrites the brain inside the runner and runs the
   * staggered restart — best-effort, so the save never fails because of the apply (see autoApply).
   * "Apply now" remains the manual force.
   */
  app.post<{ Body: { text?: string } }>("/api/brain", { preHandler: requireSession }, async (req, reply) => {
    try {
      const saved = await setBrainText(req.body?.text ?? "");
      return await reply.send({ ...saved, ...(await autoApply("brain", applyBrainEverywhere)) });
    } catch (err) {
      const { code, body } = fail(err);
      return await reply.code(code).send(body);
    }
  });

  /** Back to the seed text — the same auto-apply as a save, since the runner content changes too. */
  app.delete("/api/brain", { preHandler: requireSession }, async (_req, reply) => {
    await resetBrain();
    const effect = await autoApply("brain", applyBrainEverywhere);
    return await reply.send({ ...(await brainView()), ...effect });
  });

  app.post("/api/brain/apply", { preHandler: requireSession }, async (_req, reply) => {
    try {
      return await reply.send({ ok: true, ...(await applyBrainEverywhere()) });
    } catch (err) {
      const { code, body } = fail(err);
      return await reply.code(code).send(body);
    }
  });

  /* ------------------------------------------------------------- voice input */

  app.get("/api/transcribe", { preHandler: requireSession }, async (_req, reply) => {
    return await reply.send(await transcribeStatus());
  });

  /** Stores the operator's keys. Values never come back — only whether each one is set. */
  app.post<{ Body: { openaiKey?: string; anthropicKey?: string } }>(
    "/api/transcribe/keys", { preHandler: requireSession },
    async (req, reply) => {
      try {
        return await reply.send(await setTranscribeKeys(req.body ?? {}));
      } catch (err) {
        const { code, body } = fail(err);
        return await reply.code(code).send(body);
      }
    },
  );

  /**
   * A recording from the composer's microphone: JSON `{ base64, mimeType }`, same shape as the image
   * upload. Its own bodyLimit — 20 MB of audio is ~1.4x that in base64 plus the envelope.
   */
  app.post<{ Params: { id: string }; Body: { base64?: string; mimeType?: string } }>(
    "/api/cards/:id/transcribe",
    { preHandler: requireSession, bodyLimit: Math.ceil(AUDIO_MAX_BYTES * 1.4) },
    async (req, reply) => {
      try {
        const out = await transcribeCardAudio(req.params.id, req.body?.base64 ?? "", req.body?.mimeType ?? "audio/webm");
        return await reply.send(out);
      } catch (err) {
        const message = (err as Error).message;
        const code = /not found/i.test(message) ? 404 : /not configured/i.test(message) ? 503 : 400;
        return await reply.code(code).send({ error: message });
      }
    },
  );

  /* ----------------------------------------------------------------- import */

  /**
   * Adopts Claude sessions that already exist (staged transcripts in the runner) as cards. The
   * working directory of a card is derived by the workspace module and handed in — the importer
   * must not reach into the clone/worktree lifecycle itself, and the two paths must never drift.
   */
  app.post<{ Body: ImportInput }>("/api/import", { preHandler: requireSession }, async (req, reply) => {
    try {
      const result = await importSessions(
        req.body ?? { items: [] },
        (project, card) => cardWorkPaths(project, card).cwd,
      );
      return await reply.send(result);
    } catch (err) {
      const { code, body } = fail(err);
      return await reply.code(code).send(body);
    }
  });

  /** The board's own view of what a card maps to in the runner — handy for debugging an import. */
  app.get<{ Params: { id: string } }>("/api/cards/:id/paths", { preHandler: requireSession }, async (req, reply) => {
    const card = await registry.getCard(req.params.id);
    const project = card ? await registry.getProject(card.projectId) : undefined;
    if (!card || !project) return await reply.code(404).send({ error: "card not found" });
    return await reply.send(cardWorkPaths(project, card));
  });
}
