import type { FastifyReply, FastifyRequest } from "fastify";
import { currentUser } from "./session.js";
import type { PublicUser } from "./users.js";
import type { Card, Project } from "../services/board/registry.js";

/**
 * ACCESS — who may see and touch a given piece of WORK (a project, a card), as opposed to
 * {@link requireOwner}, which guards what belongs to the INSTALL.
 *
 * Today the answer is short: the owner sees everything, a member sees nothing. Sharing a card (or a
 * whole project) with a member is the next increment, and it lands HERE — every route that is
 * card-scoped already asks this module instead of asking for a role, so the sharing rules arrive in
 * one file rather than in forty route handlers.
 *
 * The functions are deliberately async and take the user: a share lookup is a store read.
 */

/** May this user see/act on this card? PURE apart from the (future) share lookup. */
export async function canAccessCard(user: PublicUser | null, _cardId: string): Promise<boolean> {
  if (!user) return false;
  return user.role === "owner";
}

/** May this user see this project (and the cards under it)? */
export async function canAccessProject(user: PublicUser | null, _projectId: string): Promise<boolean> {
  if (!user) return false;
  return user.role === "owner";
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
  const allowed = await Promise.all(cards.map((c) => canAccessCard(user, c.id)));
  return cards.filter((_, i) => allowed[i]);
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
  if (!(await canAccessCard(user, cardId))) {
    await reply.code(404).send({ error: "card not found" });
    return;
  }
  (req as FastifyRequest & { userId?: string }).userId = user.id;
}
