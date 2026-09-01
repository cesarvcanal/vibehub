import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import { requireCardWork } from "../auth/access.js";
import { findUser } from "../auth/users.js";
import * as registry from "../services/board/registry.js";
import { getSettings } from "../services/settings/settings.js";
import { installCardSdkDriver, sdkDriverCommand } from "../services/sdk/driver.js";
import { appendHistory, onExternalMessage, readHistory, replayableHistoryEvent } from "../services/sdk/history.js";
import { matchOrigin, primeProvenance, type MessageOrigin } from "../services/chat/provenance.js";
import {
  buildLatestTranscriptScript,
  parseLatestTranscript,
  resumeTargetFor,
  transcriptToSdkHistory,
} from "../services/sdk/transcript.js";
import { parseDriverLine, encodeControl, type DriverControl, type DriverEvent } from "../services/sdk/protocol.js";
import { transcriptDirFor } from "../services/maestro/maestro.js";
import { effectiveAccountSlug } from "../services/board/registry.js";
import { config } from "../config/env.js";
import { hostExecutor } from "../runtime/host.js";
import { disableNagle } from "./session.js";
import { logger } from "../utils/logger.js";

/**
 * SDK DRIVER websocket — `/api/cards/:id/sdk`. EXPERIMENTAL and gated by the `sdkDriver` setting
 * (OFF by default); ADDITIVE and entirely SEPARATE from the terminal/chat routes. With the flag off
 * it refuses to start, so production is byte-for-byte unchanged.
 *
 * It spawns the per-card driver in the runner (a Node process, NOT the tmux TUI) and bridges its
 * structured protocol both ways:
 *   driver stdout (NDJSON events)  ->  one JSON text frame per event, to the front
 *   front message (a user message) ->  a JSON control line on the driver's stdin
 *
 * The wire contract the front consumes (see services/sdk/protocol.ts `DriverEvent`):
 *   { "type": "ready", "resume"?: string }
 *   { "type": "session", "sessionId": string }
 *   { "type": "assistant_delta", "text": string }        // live token stream
 *   { "type": "assistant_text", "text": string }          // consolidated block
 *   { "type": "tool_use", "id": string, "name": string, "input": unknown }
 *   { "type": "permission", "tool": string, "decision": "allow"|"deny", "sensitive": boolean, "reason"?: string, "id"?: string, "timedOut"?: boolean }
 *   { "type": "permission_request", "id": string, "tool": string, "input"?: unknown, "reason"?: string }
 *   { "type": "result", "isError": boolean, "sessionId"?: string, "subtype"?: string, "result"?: string, "permissionDenials"?: unknown[] }
 *   { "type": "error", "message": string }
 *   { "type": "parse_error", "raw": string }              // synthesised by the back for a bad line
 *
 * The front sends, per message: either a JSON object { "type": "user", "text": "..." },
 * { "type": "interrupt" }, or { "type": "permission_decision", "id": string, "allow": boolean }
 * (the answer to a `permission_request`) — or a bare string, treated as a user message.
 */

const KEEPALIVE_MS = 25_000;

/** Interpret a browser frame as a driver control message. A bare string = a user message. PURE. */
export function parseSdkClientFrame(raw: string): DriverControl | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as { type?: unknown; text?: unknown; id?: unknown; allow?: unknown };
      if (parsed.type === "interrupt") return { type: "interrupt" };
      if (parsed.type === "user" && typeof parsed.text === "string") return { type: "user", text: parsed.text };
      if (parsed.type === "permission_decision" && typeof parsed.id === "string" && typeof parsed.allow === "boolean") {
        return { type: "permission_decision", id: parsed.id, allow: parsed.allow };
      }
      return null;
    } catch {
      // not JSON — fall through and treat as a bare user message
    }
  }
  return { type: "user", text: raw };
}

/**
 * Wire a driver child process to a websocket: NDJSON events out (one frame each), control lines in.
 * Both sides close together. Exported for the route; the child is spawned by the caller.
 */
export interface BridgeHooks {
  /** Called (deduplicated) whenever the driver reports a session id — the resume key to persist. */
  onSessionId?: (sessionId: string) => void;
  /** Every parsed driver event, after it went to the socket — the history recorder taps in here. */
  onEvent?: (event: DriverEvent) => void;
  /** Every parsed control from the browser, after it went to the driver's stdin. */
  onControl?: (control: DriverControl) => void;
}

export function bridgeSdkDriver(
  socket: WebSocket,
  child: ChildProcessWithoutNullStreams,
  label: string,
  hooks: BridgeHooks = {},
): void {
  const { onSessionId, onEvent, onControl } = hooks;
  disableNagle(socket);
  const keepalive = setInterval(() => {
    try { socket.ping?.(); } catch { /* the close handler cleans up */ }
  }, KEEPALIVE_MS);

  let buffer = "";
  let lastSessionId: string | undefined;
  child.stdout.on("data", (chunk: Buffer) => {
    buffer += chunk.toString();
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      const event = parseDriverLine(line);
      if (event) {
        // The session id is the RESUME key: persisting it on the card is what lets a reconnect (or
        // reopening the card tomorrow) continue the same conversation. Deduplicated here so the
        // registry is only touched when the id actually changes.
        if (onSessionId && (event.type === "session" || event.type === "result")) {
          const sessionId = event.sessionId;
          if (sessionId && sessionId !== lastSessionId) {
            lastSessionId = sessionId;
            onSessionId(sessionId);
          }
        }
        try { socket.send(JSON.stringify(event)); } catch { /* socket going away; teardown tidies */ }
        onEvent?.(event);
      }
    }
  });
  child.stderr.on("data", (chunk: Buffer) => {
    logger.debug({ label, stderr: chunk.toString().slice(0, 500) }, "sdk driver stderr");
  });
  child.on("close", (code) => {
    clearInterval(keepalive);
    try { socket.send(JSON.stringify({ type: "error", message: `driver exited (code ${code ?? "?"})` })); } catch { /* ignore */ }
    try { socket.close(); } catch { /* already closed */ }
    logger.debug({ label, code }, "sdk driver exited");
  });

  socket.on("message", (raw: Buffer) => {
    const control = parseSdkClientFrame(raw.toString());
    if (!control) return;
    try { child.stdin.write(encodeControl(control)); } catch { /* driver gone; close will fire */ }
    onControl?.(control);
  });

  const teardown = (): void => {
    clearInterval(keepalive);
    try { child.kill(); } catch { /* already gone */ }
  };
  socket.on("close", teardown);
  socket.on("error", teardown);
}

export async function cardSdkRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { id: string } }>(
    "/api/cards/:id/sdk",
    { websocket: true, preHandler: requireCardWork },
    async (socket: WebSocket, req) => {
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
      try {
        await installCardSdkDriver();
      } catch (err) {
        try { socket.send(JSON.stringify({ type: "error", message: `could not install the driver in the runner: ${(err as Error).message}` })); } catch { /* ignore */ }
        socket.close();
        return;
      }
      // ONE read-only probe: the newest transcript in the card's worktree. It answers two things —
      // which session the driver must RESUME (the card's one conversation, whichever mode wrote it
      // last: the TUI or a previous driver), and what the TUI-era of that conversation looked like,
      // so flipping the beta toggle never makes the conversation vanish from the screen.
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
      // conversation "sumia" even though it was delivered (the production bug). The TUI era comes
      // from the transcript, the SDK era from the per-card history log; the cutoff (where the log
      // begins) keeps a conversation that lived in both modes from being drawn twice.
      try {
        const sdkHistory = await readHistory(card.id);
        const cutoffAt = sdkHistory.find((e) => typeof e.at === "number")?.at ?? Number.POSITIVE_INFINITY;
        // TUI-era user lines carry no sender; the provenance log (best-effort text+time match, see
        // services/chat/provenance.ts) restores who really typed them. SDK-era events need nothing:
        // their `from` is on the ndjson line itself.
        await primeProvenance(card.id).catch(() => undefined);
        const tuiEvents = transcriptToSdkHistory(tuiJsonl, cutoffAt).map((past) => {
          if (past.type !== "user" || past.from) return past;
          const from = matchOrigin(card.id, past.text, past.at ?? 0);
          return from ? { ...past, from } : past;
        });
        for (const past of [...tuiEvents, ...sdkHistory]) {
          try { socket.send(JSON.stringify(past)); } catch { /* socket going away */ }
        }
      } catch (err) {
        logger.warn({ card: card.worktreeSlug, detail: (err as Error).message }, "could not replay sdk chat history");
      }
      const { file, args } = sdkDriverCommand(project, {
        ...card,
        resumeSessionId: resumeTargetFor(card, latestSessionId),
      });
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
      // An agent's send (`vibehub_send_to_terminal`) lands in the history log, not on this socket's
      // driver stdout — forward it live so "the cards talking" is visible as it happens.
      const offExternal = onExternalMessage(card.id, (event) => {
        try { socket.send(JSON.stringify(event)); } catch { /* socket going away */ }
      });
      socket.on("close", offExternal);
      const child = spawn(file, args, { stdio: ["pipe", "pipe", "pipe"] }) as ChildProcessWithoutNullStreams;
      logger.info({ card: card.worktreeSlug }, "sdk driver attached");
      bridgeSdkDriver(socket, child, card.worktreeSlug, {
        onSessionId: (sessionId) => {
          // Persist the resume key on the card (board.json) so the NEXT driver spawn — a reconnect,
          // a reopened card — continues this very conversation (`--resume` in sdkDriverCommand).
          void registry.updateCard(card.id, { resumeSessionId: sessionId }).catch((err: unknown) => {
            logger.warn({ card: card.worktreeSlug, detail: (err as Error).message }, "could not persist the sdk session id");
          });
        },
        // The history log is what the next connect replays: every event worth re-drawing, and the
        // person's own messages (they cross on stdin, so stdout alone would forget them).
        onEvent: (event) => {
          if (replayableHistoryEvent(event)) void appendHistory(card.id, { ...event, at: Date.now() });
        },
        onControl: (control) => {
          if (control.type === "user") {
            void appendHistory(card.id, { type: "user", text: control.text, at: Date.now(), from: wsOrigin });
          }
        },
      });
    },
  );
}
