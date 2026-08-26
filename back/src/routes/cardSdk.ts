import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import { requireSession } from "../auth/session.js";
import * as registry from "../services/board/registry.js";
import { getSettings } from "../services/settings/settings.js";
import { installCardSdkDriver, sdkDriverCommand } from "../services/sdk/driver.js";
import { parseDriverLine, encodeControl, type DriverControl } from "../services/sdk/protocol.js";
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
 *   { "type": "permission", "tool": string, "decision": "allow"|"deny", "sensitive": boolean, "reason"?: string }
 *   { "type": "result", "isError": boolean, "sessionId"?: string, "subtype"?: string, "result"?: string, "permissionDenials"?: unknown[] }
 *   { "type": "error", "message": string }
 *   { "type": "parse_error", "raw": string }              // synthesised by the back for a bad line
 *
 * The front sends, per message: either a JSON object { "type": "user", "text": "..." } (or
 * { "type": "interrupt" }), or a bare string which is treated as a user message.
 */

const KEEPALIVE_MS = 25_000;

/** Interpret a browser frame as a driver control message. A bare string = a user message. PURE. */
export function parseSdkClientFrame(raw: string): DriverControl | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as { type?: unknown; text?: unknown };
      if (parsed.type === "interrupt") return { type: "interrupt" };
      if (parsed.type === "user" && typeof parsed.text === "string") return { type: "user", text: parsed.text };
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
export function bridgeSdkDriver(socket: WebSocket, child: ChildProcessWithoutNullStreams, label: string): void {
  disableNagle(socket);
  const keepalive = setInterval(() => {
    try { socket.ping?.(); } catch { /* the close handler cleans up */ }
  }, KEEPALIVE_MS);

  let buffer = "";
  child.stdout.on("data", (chunk: Buffer) => {
    buffer += chunk.toString();
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      const event = parseDriverLine(line);
      if (event) {
        try { socket.send(JSON.stringify(event)); } catch { /* socket going away; teardown tidies */ }
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
    { websocket: true, preHandler: requireSession },
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
      const { file, args } = sdkDriverCommand(project, card);
      const child = spawn(file, args, { stdio: ["pipe", "pipe", "pipe"] }) as ChildProcessWithoutNullStreams;
      logger.info({ card: card.worktreeSlug }, "sdk driver attached");
      bridgeSdkDriver(socket, child, card.worktreeSlug);
    },
  );
}
