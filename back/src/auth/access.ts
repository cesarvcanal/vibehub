import type { FastifyReply, FastifyRequest } from "fastify";
import { currentUser } from "./session.js";
import type { PublicUser } from "./users.js";
import * as registry from "../services/board/registry.js";
import type { Card, Project, ShareLevel } from "../services/board/registry.js";

/**
 * ACCESS — who may see and touch a given piece of WORK (a project, a card), as opposed to
 * {@link requireOwner}, which guards what belongs to the INSTALL.
 *
 * The owner sees everything. A member sees what has been SHARED with them, at the level of that
 * share:
 *  - `work` — the card is theirs to work in: the terminal takes their keystrokes, they can send a
 *    message, upload an image, pause, restart, rename.
 *  - `view` — they can read it: the chat, the transcript, the terminal's output. Nothing they do
 *    reaches the session.
 *
 * A card can be reached two ways (shared directly, or through its project) and the STRONGER of the
 * two wins — see `strongerLevel`.
 *
 * Every card-scoped route wears one of the two preHandlers below, so the rules live here instead of
 * in forty handlers: {@link requireCardAccess} to read, {@link requireCardWork} to change anything.
 */

/** What this user may do on this card: "work", "view", or null when the card is not theirs at all. */
export async function cardLevel(user: PublicUser | null, cardId: string): Promise<ShareLevel | null> {
  if (!user) return null;
  if (user.role === "owner") return "work";
  const id = String(cardId ?? "");
  if (!id) return null;
  const card = await registry.getCard(id);
  if (!card) return null;
  const shares = await registry.sharesForUser(user.id);
  const direct = shares.find((s) => s.kind === "card" && s.targetId === id)?.level ?? null;
  const viaProject = shares.find((s) => s.kind === "project" && s.targetId === card.projectId)?.level ?? null;
  return registry.strongerLevel(direct, viaProject);
}

/** May this user see this card at all? */
export async function canAccessCard(user: PublicUser | null, cardId: string): Promise<boolean> {
  return (await cardLevel(user, cardId)) !== null;
}

/**
 * May this user see this project? The project itself may be shared, or ONE of its cards may be —
 * a card you were given has to appear somewhere, and where it appears is under its project.
 */
export async function canAccessProject(user: PublicUser | null, projectId: string): Promise<boolean> {
  if (!user) return false;
  if (user.role === "owner") return true;
  const shares = await registry.sharesForUser(user.id);
  if (shares.some((s) => s.kind === "project" && s.targetId === projectId)) return true;
  const cardIds = new Set(shares.filter((s) => s.kind === "card").map((s) => s.targetId));
  if (cardIds.size === 0) return false;
  const cards = await registry.listAllCards();
  return cards.some((c) => c.projectId === projectId && cardIds.has(c.id));
}

/** Narrows a project list to what this user may see. */
export async function visibleProjects(user: PublicUser | null, projects: Project[]): Promise<Project[]> {
  if (!user) return [];
  if (user.role === "owner") return projects;
  const allowed = await Promise.all(projects.map((p) => canAccessProject(user, p.id)));
  return projects.filter((_, i) => allowed[i]);
}

/** Narrows a card list to what this user may see. */
export async function visibleCards(user: PublicUser | null, cards: Card[]): Promise<Card[]> {
  if (!user) return [];
  if (user.role === "owner") return cards;
  const shares = await registry.sharesForUser(user.id);
  if (shares.length === 0) return [];
  const sharedCards = new Set(shares.filter((s) => s.kind === "card").map((s) => s.targetId));
  const sharedProjects = new Set(shares.filter((s) => s.kind === "project").map((s) => s.targetId));
  return cards.filter((c) => sharedCards.has(c.id) || sharedProjects.has(c.projectId));
}

/**
 * Fastify preHandler for a card-scoped route (`/api/cards/:id/...`): 401 without a session, 404
 * when the card is not visible to this user.
 *
 * 404 and not 403, on purpose: to somebody who cannot see a card, that card does not exist, and a
 * 403 would confirm the id names something real.
 */
export async function requireCardAccess(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const user = await currentUser(req);
  if (!user) {
    await reply.code(401).send({ error: "not authenticated" });
    return;
  }
  const cardId = String((req.params as { id?: string } | undefined)?.id ?? "");
  const level = await cardLevel(user, cardId);
  if (level === null) {
    await reply.code(404).send({ error: "card not found" });
    return;
  }
  stamp(req, user.id, level);
}

/**
 * The same, for a route that CHANGES the card or reaches its session (typing, sending, pausing,
 * uploading, renaming). A read-only share is refused with 403 — here the card is visibly theirs, so
 * hiding it behind a 404 would only be confusing: the honest answer is "you have this one to read".
 */
export async function requireCardWork(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const user = await currentUser(req);
  if (!user) {
    await reply.code(401).send({ error: "not authenticated" });
    return;
  }
  const cardId = String((req.params as { id?: string } | undefined)?.id ?? "");
  const level = await cardLevel(user, cardId);
  if (level === null) {
    await reply.code(404).send({ error: "card not found" });
    return;
  }
  if (level !== "work") {
    await reply.code(403).send({ error: "this card is shared with you read-only" });
    return;
  }
  stamp(req, user.id, level);
}

/** Carries who the caller is and what they may do into the handler (the websockets read it). */
function stamp(req: FastifyRequest, userId: string, level: ShareLevel): void {
  const r = req as FastifyRequest & { userId?: string; cardLevel?: ShareLevel };
  r.userId = userId;
  r.cardLevel = level;
}

/** What the preHandler decided for this request — "work" unless a read-only share said otherwise. */
export function requestCardLevel(req: FastifyRequest): ShareLevel {
  return (req as FastifyRequest & { cardLevel?: ShareLevel }).cardLevel ?? "work";
}
