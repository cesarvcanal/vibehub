import { randomBytes } from "node:crypto";
import type { FastifyRequest } from "fastify";
import { config } from "../config/env.js";
import { createUser, findUser, listUsers, type PublicUser } from "./users.js";
import { logger } from "../utils/logger.js";

/**
 * DEV ONLY — a vibehub served through ANOTHER vibehub's preview proxy (`/preview/<port>/`), signed
 * in by that proxy instead of by its own setup and login.
 *
 * The outer panel's proxy already authenticated the person: its session cookie, and access to the
 * card that owns the port (routes/preview.ts). It then STRIPS that cookie and hands the request to
 * 127.0.0.1:<port> inside the runner, carrying nothing about who it was — and this instance has
 * its own empty user store, so without this mode it asks for a brand-new owner account.
 *
 * With `VIBEHUB_PREVIEW_PROXY_AUTH=1`, every request that arrived through such a proxy acts as ONE
 * local owner, created on boot with a random password nobody ever sees. No outer account, password
 * or database is read or copied. The trust boundary is the runner: the instance must listen on
 * loopback (config refuses to boot otherwise), so only the proxy's tunnel and the runner's own
 * processes reach it — and those already own the data directory, vault key included.
 */

export const PREVIEW_OWNER = "preview-owner";

/** What the outer proxy adds to every relayed request (services/preview/preview.ts). */
const PREFIX_RE = /^\/preview\/\d{1,5}$/;

let ownerId: string | null = null;

/** Creates the local owner once (or finds it after a restart). Idempotent. */
export async function ensurePreviewOwner(): Promise<PublicUser> {
  const existing = (await listUsers()).find((u) => u.username === PREVIEW_OWNER);
  const user = existing ?? (await createUser(PREVIEW_OWNER, randomBytes(32).toString("hex"), "owner"));
  ownerId = user.id;
  if (!existing) logger.info({ audit: true, action: "preview.owner" }, "preview proxy auth: local owner created");
  return { id: user.id, username: user.username, role: user.role, createdAt: user.createdAt };
}

/** Did this request come through a vibehub preview proxy? PURE. */
export function cameThroughPreviewProxy(headers: FastifyRequest["headers"]): boolean {
  const prefix = headers["x-forwarded-prefix"];
  return typeof prefix === "string" && PREFIX_RE.test(prefix);
}

/** The local owner for a proxied request when the mode is on; null otherwise. */
export async function previewProxyUser(req: FastifyRequest): Promise<PublicUser | null> {
  if (!config.previewProxyAuth || !cameThroughPreviewProxy(req.headers)) return null;
  if (ownerId) {
    const user = await findUser(ownerId);
    if (user) return user;
  }
  return await ensurePreviewOwner();
}

export function resetPreviewOwnerForTesting(): void {
  ownerId = null;
}
