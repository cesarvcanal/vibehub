import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import { requireCardWork } from "../auth/access.js";
import { findUser } from "../auth/users.js";
import * as registry from "../services/board/registry.js";
import { getSettings } from "../services/settings/settings.js";
import { installCardSdkDriver, sdkDriverCommand } from "../services/sdk/driver.js";
import { attachSocket, ensureDriverSession, handleClientFrame, hasDriverSession } from "../services/sdk/manager.js";
import { onExternalMessage, readHistory } from "../services/sdk/history.js";
import { matchOrigin, primeProvenance, type MessageOrigin } from "../services/chat/provenance.js";
import {
  buildLatestTranscriptScript,
  mergeTranscriptReplay,
  parseLatestTranscript,
  resumeTargetFor,
} from "../services/sdk/transcript.js";
import { acquireTranscriptMirror } from "../services/sdk/mirror.js";
import { parseSdkClientFrame } from "../services/sdk/protocol.js";
import { transcriptDirFor } from "../services/maestro/maestro.js";
import { effectiveAccountSlug } from "../services/board/registry.js";
import { config } from "../config/env.js";
import { hostExecutor } from "../runtime/host.js";
import { logger } from "../utils/logger.js";

/**
 * SDK DRIVER websocket — `/api/cards/:id/sdk`. EXPERIMENTAL and gated by the `sdkDriver` setting
 * (OFF by default); ADDITIVE and entirely SEPARATE from the terminal/chat routes. With the flag off
 * it refuses to start, so production is byte-for-byte unchanged.
 *
 * The driver is NOT this connection's child: it belongs to the CARD (see services/sdk/manager.ts).
 * This route's job per connect is the per-connection work — the replay, the mirror refcount, who is
 * typing — and then `attachSocket` onto the card's one live driver (spawning it only when there is
 * none). Closing the page detaches the socket and nothing else: a turn in flight keeps running and
 * keeps persisting, and the next connect reattaches to the same process.
 *
 * The wire contract the front consumes (see services/sdk/protocol.ts `DriverEvent`):
 *   { "type": "ready", "resume"?: string }
 *   { "type": "session", "sessionId": string }
 *   { "type": "assistant_delta", "text": string }        // live token stream
 *   { "type": "assistant_text", "text": string }          // consolidated block
 *   { "type": "tool_use", "id": string, "name": string, "input": unknown }
 *   { "type": "permission", "tool": string, "decision": "allow"|"deny", "sensitive": boolean, "reason"?: string, "id"?: string, "timedOut"?: boolean }
 *   { "type": "permission_request", "id": string, "tool": string, "input"?: unknown, "reason"?: string }
 *   { "type": "user_question", "id": string, "questions": [{ "question", "header"?, "options": [{ "label", "description"? }], "multiSelect"? }] }
 *   { "type": "question_result", "id": string, "answers"?: [{ "selected": string[] }], "timedOut"?: boolean }
 *   { "type": "result", "isError": boolean, "sessionId"?: string, "subtype"?: string, "result"?: string, "permissionDenials"?: unknown[] }
 *   { "type": "error", "message": string }
 *   { "type": "parse_error", "raw": string }              // synthesised by the back for a bad line
 *
 * The front sends, per message: either a JSON object { "type": "user", "text": "..." },
 * { "type": "interrupt" }, { "type": "permission_decision", "id": string, "allow": boolean }
 * (the answer to a `permission_request`), or { "type": "question_answer", "id": string,
 * "answers": [{ "selected": string[] }] } (the answer to a `user_question`) — or a bare string,
 * treated as a user message.
 */

// Re-exported for compatibility (tests, callers): the parser moved into the pure protocol module.
export { parseSdkClientFrame };

export async function cardSdkRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { id: string } }>(
    "/api/cards/:id/sdk",
    { websocket: true, preHandler: requireCardWork },
    async (socket: WebSocket, req) => {
      // BUFFER FIRST, before any await: this handler does seconds of async setup (settings, the
      // transcript probe, the replay) with NO message listener attached — and ws drops frames that
      // arrive with no listener. A message typed right after a reconnect (exactly what a person
      // does when the panel comes back from a deploy: "e aí, como tá indo?") was SWALLOWED in that
      // gap. Everything sent before attach is kept and delivered to the driver, in order, as the
      // normal user turns they are.
      const pendingFrames: string[] = [];
      const bufferFrame = (raw: Buffer): void => { pendingFrames.push(raw.toString()); };
      socket.on("message", bufferFrame);
      const settings = await getSettings();
      if (!settings.sdkDriver) {
        try { socket.send(JSON.stringify({ type: "error", message: "the SDK driver is off (enable the sdkDriver setting)" })); } catch { /* ignore */ }
        socket.close();
        return;
      }
      const card = await registry.getCard(req.params.id);
      const project = card ? await registry.getProject(card.projectId) : undefined;
      if (!card || !project) {
        try { socket.send(JSON.stringify({ type: "error", message: "this card no longer exists" })); } catch { /* ignore */ }
        socket.close();
        return;
      }
      // Whether the card's driver is ALREADY alive decides two things below: the install becomes a
      // no-op check, and the spawn command's resume probe is only advisory (the live driver wins).
      const driverAlive = hasDriverSession(card.id);
      if (!driverAlive) {
        try {
          await installCardSdkDriver();
        } catch (err) {
          try { socket.send(JSON.stringify({ type: "error", message: `could not install the driver in the runner: ${(err as Error).message}` })); } catch { /* ignore */ }
          socket.close();
          return;
        }
      }
      // ONE read-only probe: the newest transcript in the card's worktree. It answers two things —
      // which session the driver must RESUME (the card's one conversation, whichever mode wrote it
      // last: the TUI or a previous driver), and what the TUI-era of that conversation looked like,
      // so flipping the beta toggle never makes the conversation vanish from the screen.
      // The mirror's floor is taken BEFORE the probe reads the transcript: a line written while the
      // probe runs is either in the replay (then its id is pre-seeded below) or newer than this
      // instant — never in the gap between the two.
      const mirrorCutoffAt = Date.now();
      let latestSessionId: string | null = null;
      let tuiJsonl = "";
      try {
        const dir = transcriptDirFor(project, card, effectiveAccountSlug(card, project));
        const { stdout } = await hostExecutor().runScript(
          buildLatestTranscriptScript(config.runner.container, dir),
          { timeoutMs: 15_000 },
        );
        ({ sessionId: latestSessionId, jsonl: tuiJsonl } = parseLatestTranscript(stdout));
      } catch (err) {
        logger.warn({ card: card.worktreeSlug, detail: (err as Error).message }, "could not read the card transcript for the sdk chat");
      }

      // REPLAY FIRST: the conversation so far, before the driver says a word. The `--resume` id
      // preserves the conversation for the model; this preserves it for the SCREEN — without it a
      // remount (tab switch, reopened card, reload) started visually empty and the whole
      // conversation "sumia" even though it was delivered (the production bug). The history log and
      // the transcript are MERGED into one timeline (see mergeTranscriptReplay): the TUI era, the
      // SDK era, and the terminal conversations the log never saw — deduped, never drawn twice.
      const replayedIds: string[] = [];
      try {
        const sdkHistory = await readHistory(card.id);
        // TUI-era user lines carry no sender; the provenance log (best-effort text+time match, see
        // services/chat/provenance.ts) restores who really typed them. SDK-era events need nothing:
        // their `from` is on the ndjson line itself.
        await primeProvenance(card.id).catch(() => undefined);
        const replay = mergeTranscriptReplay(tuiJsonl, sdkHistory).map((past) => {
          if (past.type !== "user" || past.from || !past.tid) return past;
          const from = matchOrigin(card.id, past.text, past.at ?? 0);
          return from ? { ...past, from } : past;
        });
        for (const past of replay) {
          if (past.tid) replayedIds.push(past.tid);
          try { socket.send(JSON.stringify(past)); } catch { /* socket going away */ }
        }
      } catch (err) {
        logger.warn({ card: card.worktreeSlug, detail: (err as Error).message }, "could not replay sdk chat history");
      }
      // WHO is typing on this socket — stamped on their messages so OTHER readers of this card see
      // the name (their own render unlabelled: the front compares it). Resolved once per connect.
      let wsOrigin: MessageOrigin | undefined;
      const userId = (req as typeof req & { userId?: string }).userId;
      if (userId) {
        try {
          const user = await findUser(userId);
          if (user) wsOrigin = { kind: user.role === "owner" ? "owner" : "user", name: user.username };
        } catch { /* unattributed beats broken */ }
      }
      // An agent's send (`vibehub_send_to_terminal`) — and every event the transcript MIRROR lifts
      // from the terminal — lands in the history log, not on the driver's stdout. Forward them live
      // so the conversation is visible as it happens, whichever screen it happens on. (The driver's
      // own events reach this socket through the manager's broadcast.)
      const offExternal = onExternalMessage(card.id, (event) => {
        try { socket.send(JSON.stringify(event)); } catch { /* socket going away */ }
      });
      socket.on("close", offExternal);
      // The MIRROR: while this chat is connected, the card's transcript is followed and whatever
      // the TERMINAL says (a person typing at the TUI, its answers) shows up here — the bug this
      // closes is the conversation that moved to the Terminal tab and never reached the native
      // chat. Refcounted per card; the last close stops the follow.
      let releaseMirror: (() => void) | null = null;
      let socketClosed = false;
      void acquireTranscriptMirror(card.id, { cutoffAt: mirrorCutoffAt, seenIds: replayedIds }).then((releaseIt) => {
        if (socketClosed) releaseIt();
        else releaseMirror = releaseIt;
      });
      socket.on("close", () => {
        socketClosed = true;
        releaseMirror?.();
        releaseMirror = null;
      });
      // The card's ONE driver: reuse it live (mid-turn included — the reconnect after the reload),
      // or spawn it resuming the newest transcript. History persistence, resume-id persistence and
      // the mirror's dedupe keys all live in the manager — the side that survives this socket.
      const session = ensureDriverSession({
        cardId: card.id,
        label: card.worktreeSlug,
        command: await sdkDriverCommand(project, {
          ...card,
          resumeSessionId: resumeTargetFor(card, latestSessionId),
        }),
      });
      attachSocket(session, socket, wsOrigin);
      // Setup is done: hand the frames buffered during it to the SAME funnel the live listener
      // uses — user messages become normal user turns (queued by the driver until it is ready).
      socket.off("message", bufferFrame);
      for (const raw of pendingFrames) handleClientFrame(session, raw, wsOrigin);
      logger.info({ card: card.worktreeSlug, reattached: driverAlive, buffered: pendingFrames.length }, "sdk chat attached");
    },
  );
}
