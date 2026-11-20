import type { PublicUser } from "../../auth/users.js";
import { cardLevel, visibleProjects } from "../../auth/access.js";
import { creatorAccountSlug } from "../../auth/userGit.js";
import * as registry from "../board/registry.js";
import * as workspace from "../board/workspace.js";
import { recordCardActor } from "../board/actor.js";
import { listTerminals, sendToTerminal, waitTerminalReady, SEND_READY_WAIT_MS } from "./maestro.js";
import { originOfUser } from "../chat/provenance.js";
import { sendAnswer } from "../../mcp/events.js";
import { moveCards, type CardMoveOutcome } from "../../mcp/cardMove.js";
import type { BoardColumn } from "../board/registry.js";
import { logger } from "../../utils/logger.js";

export class UserActionError extends Error {
  constructor(readonly status: 400 | 403 | 404, message: string) {
    super(message);
  }
}

export const OPEN_WAIT_MS = 20_000;

export async function requireCardLevel(user: PublicUser, cardId: string, need: "view" | "work"): Promise<registry.Card> {
  const level = await cardLevel(user, cardId);
  const card = level ? await registry.getCard(cardId) : undefined;
  if (!level || !card) throw new UserActionError(404, "card not found");
  if (need === "work" && level !== "work") throw new UserActionError(403, "this card is shared with you read-only");
  return card;
}

async function settleWithin<T>(work: Promise<T>, ms: number, what: string, cardId: string): Promise<{ done: true; value: T } | { done: false }> {
  // eslint-disable-next-line no-restricted-syntax -- live state: the timer is set inside the Promise executor and cleared in finally
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<{ done: false }>((resolve) => {
    timer = setTimeout(() => resolve({ done: false }), ms);
  });
  const settled = work.then((value) => ({ done: true as const, value }));
  try {
    return await Promise.race([settled, timeout]);
  } finally {
    clearTimeout(timer);
    void settled.catch((err: unknown) => {
      logger.warn({ card: cardId, detail: (err as Error).message }, `${what} failed`);
    });
  }
}

export async function openCardFor(user: PublicUser, card: registry.Card) {
  const opening = await settleWithin(workspace.openCard(card.id, user.id), OPEN_WAIT_MS, "open for a user", card.id);
  if (!opening.done) {
    return {
      cardId: card.id,
      title: card.title,
      opened: false,
      opening: true,
      hint: "still preparing the workspace (the first open of a project clones the repo). Check " +
        "vibehub_list_terminals until liveSession is true, then send the instruction.",
    };
  }
  const terminal = await waitTerminalReady(card.id, SEND_READY_WAIT_MS);
  if (terminal.ready) return { cardId: card.id, title: card.title, opened: true, ready: true };
  return {
    cardId: card.id, title: card.title, opened: true, ready: false, notReady: terminal.detail,
    hint: "the session is up but Claude cannot take a message yet — vibehub_send_to_terminal waits " +
      "for it on its own; if this names a menu, the user has to answer it in the Terminal tab.",
  };
}

export async function listProjectsFor(user: PublicUser) {
  const projects = await visibleProjects(user, await registry.listProjects());
  return {
    canCreateCards: user.role === "owner",
    projects: projects.map((project) => ({ id: project.id, name: project.name, repo: project.repoFullName ?? null, baseBranch: project.baseBranch })),
  };
}

export async function listCardsFor(user: PublicUser, project?: string) {
  const terminals = await listTerminals(project);
  const reachable = [];
  for (const terminal of terminals) {
    const access = await cardLevel(user, terminal.cardId);
    if (access) reachable.push({ ...terminal, access });
  }
  return reachable;
}

export async function createCardFor(user: PublicUser, input: { projectId: string; title: string; open?: boolean }) {
  if (user.role !== "owner") throw new UserActionError(403, "only the owner can create cards — ask them to create or share one");
  const accountSlug = await creatorAccountSlug(user.id);
  const card = await registry.createCard({ projectId: input.projectId, title: input.title }, accountSlug ? { accountSlug } : {});
  logger.info({ card: card.worktreeSlug, by: user.username }, "card created for a user");
  if (input.open === false) {
    void workspace.prepareCard(card.id, "card.create").catch((err: unknown) => {
      logger.warn({ card: card.worktreeSlug, detail: (err as Error).message }, "pre-provisioning of the new card failed (best-effort)");
    });
    return { cardId: card.id, title: card.title, projectId: card.projectId, opened: false };
  }
  return { ...(await openCardFor(user, card)), projectId: card.projectId };
}

export async function sendToCardAs(user: PublicUser, input: { cardId: string; text: string; inReplyTo?: string }) {
  await requireCardLevel(user, input.cardId, "work");
  const sentAt = Date.now();
  const sent = await sendAnswer(input.cardId, input.inReplyTo, input.text, (text) => sendToTerminal(input.cardId, text, {
    by: user.id,
    beforeDeliver: () => recordCardActor(user, input.cardId),
    guardInteractiveMenu: true,
    requireAgent: true,
    readyWaitMs: SEND_READY_WAIT_MS,
    wake: true,
    viaNativeChat: true,
    origin: originOfUser(user),
  }));
  return { ...sent, sentAt };
}

export async function moveCardsAs(user: PublicUser, cards: string[], column: BoardColumn) {
  const allowed: string[] = [];
  const refused: CardMoveOutcome[] = [];
  for (const cardId of cards) {
    try {
      await requireCardLevel(user, cardId, "work");
      allowed.push(cardId);
    } catch (e) {
      refused.push({ cardId, ok: false, error: (e as Error).message });
    }
  }
  if (allowed.length === 0) return { column, moved: 0, unchanged: 0, failed: refused.length, results: refused };
  const moved = await moveCards(allowed, column, { by: user.id });
  return { ...moved, failed: moved.failed + refused.length, results: [...moved.results, ...refused] };
}
