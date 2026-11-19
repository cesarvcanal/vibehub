import { findUser } from "../../auth/users.js";
import { creatorAccountSlug } from "../../auth/userGit.js";
import { createCard, getCard, type Card } from "../board/registry.js";
import { prepareCard } from "../board/workspace.js";
import { logger } from "../../utils/logger.js";

export async function createCardFromCard(fromCardId: string, input: { projectId: string; title: string }): Promise<Card> {
  const fromCard = await getCard(fromCardId);
  if (!fromCard) throw new Error(`card not found: ${fromCardId}`);
  const creator = fromCard.actorUserId ? await findUser(fromCard.actorUserId) : null;
  if (!creator) throw new Error("nobody gave this card an order yet, so there is no one to create the card for");
  if (creator.role !== "owner") {
    throw new Error(`only the owner can create cards — '${creator.username}' gave this card its order; ask the owner to create it`);
  }
  const accountSlug = await creatorAccountSlug(creator.id);
  const card = await createCard(input, accountSlug ? { accountSlug } : {}, { actorUserId: creator.id });
  logger.info({ audit: true, action: "card.create", card: card.worktreeSlug, by: creator.username, from: fromCard.worktreeSlug }, "card created by another card");
  void prepareCard(card.id, "card.create").catch((err: unknown) => {
    logger.warn({ card: card.worktreeSlug, detail: (err as Error).message }, "pre-provisioning of the new card failed (best-effort) — the first open will do it");
  });
  return card;
}
