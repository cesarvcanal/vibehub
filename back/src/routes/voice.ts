import type { FastifyInstance } from "fastify";
import { requireSession, requestUser, sessionUserId } from "../auth/session.js";
import { requireCardWork } from "../auth/access.js";
import { cardCallDelegation, cardCallInstructions, createLiveSession, voiceLiveStatus, SDP_MAX_BYTES, VoiceLiveError } from "../services/voice/live.js";
import { parseVoiceTurns, saveVoiceTurns } from "../services/voice/turns.js";
import { parseVoiceDrop } from "../services/voice/drop.js";
import { speechAvailable, synthesizeSpeech, SPEECH_MAX_CHARS } from "../services/voice/speech.js";
import { Readable } from "node:stream";
import { originOfUser } from "../services/chat/provenance.js";
import * as registry from "../services/board/registry.js";
import { config } from "../config/env.js";
import { logger } from "../utils/logger.js";
import { runVoiceAction, runVoiceActionOnce } from "../services/voice/executor.js";
import { UserActionError } from "../services/maestro/asUser.js";
import { NOT_FOUND, type ErrorStatusRule } from "./httpError.js";

const BOARD_REFUSALS: readonly ErrorStatusRule[] = [
  NOT_FOUND,
  [/is required|empty text|reserved line/i, 400],
  [/no live session|awaiting choice|no agent running|terminal not ready|^paused:|^done:|human-active|exited before it could take/i, 409],
];

/**
 * VOICE MODE — see services/voice/live.ts. The key never leaves the server.
 *
 * - `/api/voice/live/sessions`: the plain conversation (the calibration lab). Any signed-in person.
 * - `/api/cards/:id/voice/sessions` and `/voice/turns`: a call held INSIDE a card's chat — it knows
 *   the card's thread and saves its spoken turns there, so it takes the same right as typing in
 *   that chat (`requireCardWork`: a read-only share can read the turns, not hold a call).
 * - `/api/cards/:id/voice/speech`: reads a piece of a finished answer aloud (services/voice/speech.ts).
 *   Billed like a call, so the same right.
 */
export async function voiceRoutes(app: FastifyInstance): Promise<void> {
  /** Booleans only: is the mode on, can the server reach a key, can it read answers aloud. */
  app.get("/api/voice/live", { preHandler: requireSession }, async (_req, reply) => {
    const [live, speech] = await Promise.all([voiceLiveStatus(), speechAvailable()]);
    return await reply.send({ ...live, speech });
  });

  /** `{ sdp }` (the browser's offer) → `{ sessionId, sdp }` (GPT-Live's answer). */
  app.post<{ Body: { sdp?: unknown } }>(
    "/api/voice/live/sessions",
    { preHandler: requireSession, bodyLimit: SDP_MAX_BYTES + 4096 },
    async (req, reply) => {
      // The browser cancelled (stop while connecting, tab closed): drop the upstream call too.
      const gone = new AbortController();
      reply.raw.once("close", () => {
        if (!reply.raw.writableEnded) gone.abort();
      });
      try {
        const user = (await sessionUserId(req)) ?? "unknown";
        const answer = await createLiveSession(req.body?.sdp, { user, signal: gone.signal });
        return await reply.code(201).send(answer);
      } catch (err) {
        if (err instanceof VoiceLiveError) return await reply.code(err.status).send({ error: err.message });
        throw err;
      }
    },
  );

  /** The same trade, for a call in this card's chat: the instructions carry its recent thread. */
  app.post<{ Params: { id: string }; Body: { sdp?: unknown } }>(
    "/api/cards/:id/voice/sessions",
    { preHandler: requireCardWork, bodyLimit: SDP_MAX_BYTES + 4096 },
    async (req, reply) => {
      const gone = new AbortController();
      reply.raw.once("close", () => {
        if (!reply.raw.writableEnded) gone.abort();
      });
      try {
        const cardId = req.params.id;
        // The owner passes the access check for any id: a card that is not on the board is a 404 here.
        const card = await registry.getCard(cardId);
        if (!card) return await reply.code(404).send({ error: "card not found" });
        const project = await registry.getProject(card.projectId);
        if (!project) return await reply.code(404).send({ error: "project not found" });
        const user = (await sessionUserId(req)) ?? "unknown";
        const answer = await createLiveSession(req.body?.sdp, {
          user,
          cardId,
          signal: gone.signal,
          delegation: cardCallDelegation({ cardTitle: card.title, projectName: project.name }),
          instructionsFor: (apiKey, signal) => cardCallInstructions(cardId, apiKey, signal),
        });
        return await reply.code(201).send(answer);
      } catch (err) {
        if (err instanceof VoiceLiveError) return await reply.code(err.status).send({ error: err.message });
        throw err;
      }
    },
  );

  app.post<{ Params: { id: string }; Body: { callId?: unknown; name?: unknown; arguments?: unknown } }>(
    "/api/cards/:id/voice/actions",
    { preHandler: requireCardWork, bodyLimit: 64 * 1024 },
    async (req, reply) => {
      if (!config.voiceLive.enabled) return await reply.code(404).send({ error: "voice mode is disabled" });
      const callCard = await registry.getCard(req.params.id);
      if (!callCard) return await reply.code(404).send({ error: "card not found" });
      const { callId, name, arguments: argumentsJson } = req.body ?? {};
      if (typeof callId !== "string" || !callId || callId.length > 200) return await reply.code(400).send({ error: "callId is required" });
      if (typeof name !== "string" || !name) return await reply.code(400).send({ error: "name is required" });
      if (typeof argumentsJson !== "string") return await reply.code(400).send({ error: "arguments must be the function call's JSON text" });
      const user = await requestUser(req);
      if (!user) return await reply.code(401).send({ error: "not authenticated" });
      try {
        const output = await runVoiceActionOnce(`${user.id}:${callId}:${name}`, () => runVoiceAction({ user, callCard, name, argumentsJson }));
        logger.info({ audit: true, action: "voice.action", tool: name, card: callCard.id, by: user.username }, "voice action");
        return await reply.send({ output });
      } catch (err) {
        if (err instanceof UserActionError) return await reply.code(err.status).send({ error: err.message });
        const reason = err instanceof Error ? err.message : String(err);
        const refusal = BOARD_REFUSALS.find(([pattern]) => pattern.test(reason));
        if (refusal) {
          logger.info({ tool: name, card: callCard.id, detail: reason }, "voice action refused by the board");
          return await reply.code(refusal[1]).send({ error: reason });
        }
        logger.error({ tool: name, card: callCard.id, detail: reason }, "voice action failed");
        return await reply.code(502).send({ error: `the board failed to run ${name}; the server log has the detail` });
      }
    },
  );

  /**
   * `{ turns: [{ vid, role, text, at }] }` → `{ saved, duplicate }`. Idempotent on `vid`. Saved in
   * the card's chat log and announced to its open chats as `voice_turn` events.
   */
  app.post<{ Params: { id: string }; Body: unknown }>(
    "/api/cards/:id/voice/turns",
    { preHandler: requireCardWork, bodyLimit: 512 * 1024 },
    async (req, reply) => {
      try {
        if (!(await registry.getCard(req.params.id))) return await reply.code(404).send({ error: "card not found" });
        const turns = parseVoiceTurns(req.body);
        if (turns.length === 0) return await reply.send({ saved: [], duplicate: [] });
        const user = await requestUser(req);
        return await reply.send(await saveVoiceTurns(req.params.id, turns, user ? originOfUser(user) : undefined));
      } catch (err) {
        if (err instanceof VoiceLiveError) return await reply.code(err.status).send({ error: err.message });
        throw err;
      }
    },
  );

  app.post<{ Params: { id: string }; Body: unknown }>(
    "/api/cards/:id/voice/drops",
    { preHandler: requireCardWork, bodyLimit: 4096 },
    async (req, reply) => {
      try {
        if (!(await registry.getCard(req.params.id))) return await reply.code(404).send({ error: "card not found" });
        const drop = parseVoiceDrop(req.body);
        const user = await requestUser(req);
        logger.warn({ action: "voice.drop", card: req.params.id, by: user?.username, ...drop }, "voice call dropped");
        return await reply.code(204).send();
      } catch (err) {
        if (err instanceof VoiceLiveError) return await reply.code(err.status).send({ error: err.message });
        throw err;
      }
    },
  );

  /** `{ text }` (one piece of an answer, plain text) → `audio/mpeg`, streamed from OpenAI. */
  app.post<{ Params: { id: string }; Body: { text?: unknown } }>(
    "/api/cards/:id/voice/speech",
    { preHandler: requireCardWork, bodyLimit: SPEECH_MAX_CHARS * 4 + 4096 },
    async (req, reply) => {
      // Stop pressed or tab closed: drop the upstream call too.
      const gone = new AbortController();
      reply.raw.once("close", () => {
        if (!reply.raw.writableEnded) gone.abort();
      });
      try {
        if (!(await registry.getCard(req.params.id))) return await reply.code(404).send({ error: "card not found" });
        const user = (await sessionUserId(req)) ?? "unknown";
        const audio = await synthesizeSpeech(req.body?.text, { user, cardId: req.params.id, signal: gone.signal });
        const stream = Readable.fromWeb(audio as import("node:stream/web").ReadableStream<Uint8Array>);
        // A stop mid-stream aborts the upstream read; that is not an error worth a log line.
        stream.on("error", () => undefined);
        return await reply.header("Content-Type", "audio/mpeg").header("Cache-Control", "no-store").send(stream);
      } catch (err) {
        if (err instanceof VoiceLiveError) return await reply.code(err.status).send({ error: err.message });
        throw err;
      }
    },
  );
}
