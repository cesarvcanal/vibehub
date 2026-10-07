import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { sessionTokenFromCookieHeader, verifySessionUser } from "./session.js";

/**
 * OPEN WEBSOCKETS, BY SESSION — so revoking a session reaches the sockets it already opened.
 *
 * Every websocket (terminal, /sdk, /chat, VNC, the preview tunnel) checks the cookie once, at the
 * handshake, and then lives as long as its tab. Sessions are stateless (session.ts), so a password
 * change or a removed account only stops the NEXT request: a shell opened with a stolen cookie kept
 * taking keystrokes after the owner changed the password. This registry closes that gap at the one
 * place every websocket passes through — the server's `upgrade` event — instead of in each route,
 * where the next websocket route would be the one that forgot.
 *
 * Sockets are indexed by the userId the cookie CLAIMS, read without verifying it: indexing is all
 * it is used for, and it keeps tracking synchronous (no window where a socket is open but not yet
 * registered). Whether a socket survives is decided by {@link verifySessionUser}, the same rule
 * every request answers to — a forged cookie filed under someone's id was refused at its handshake
 * anyway, and is simply closed along with the rest.
 */

/** userId → (raw socket → the session token it was opened with). */
const openSockets = new Map<string, Map<Duplex, string>>();

function claimedUserId(token: string): string {
  return token.split(".")[0] ?? "";
}

function track(req: IncomingMessage, socket: Duplex): void {
  const token = sessionTokenFromCookieHeader(req.headers.cookie);
  const userId = token ? claimedUserId(token) : "";
  if (!token || !userId || socket.destroyed) return;
  let sockets = openSockets.get(userId);
  if (!sockets) openSockets.set(userId, (sockets = new Map()));
  sockets.set(socket, token);
  socket.once("close", () => {
    sockets.delete(socket);
    if (sockets.size === 0 && openSockets.get(userId) === sockets) openSockets.delete(userId);
  });
}

/**
 * Registers every upgraded socket of `server`. A listener of its own rather than part of a route:
 * call it AFTER `installPreviewUpgrade`, which rewraps the listeners present when it runs — added
 * later, this one sees the preview tunnels as well as the @fastify/websocket routes.
 */
export function trackSessionSockets(server: Server): void {
  server.on("upgrade", track);
}

/**
 * Ends every open socket of `userId` whose session no longer passes {@link verifySessionUser} —
 * call it after anything that revokes sessions (`changePassword`, `removeUser`). Sockets of a
 * session that is still valid (the cookie re-issued to whoever made the change) stay open.
 *
 * `destroy()` on the raw socket, not a websocket close frame: it is what both kinds of socket here
 * have in common (the tunnel is bytes, not a `ws`), and each route's `close` handler already does
 * its teardown — the pty, the follow, the tunnel's child — when its socket goes away.
 */
export async function endRevokedSessionSockets(userId: string): Promise<void> {
  const sockets = openSockets.get(userId);
  if (!sockets) return;
  await Promise.all([...sockets].map(async ([socket, token]) => {
    if (!(await verifySessionUser(token))) socket.destroy();
  }));
}
