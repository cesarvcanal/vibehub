import type { PublicUser } from "../../auth/users.js";
import { creatorAccountSlug } from "../../auth/userGit.js";
import { createCard, type Card, type CreateCardInput } from "../board/registry.js";
import { prepareCard } from "../board/workspace.js";
import { logger } from "../../utils/logger.js";

export async function createCardAs(creator: PublicUser, input: CreateCardInput, fromCardSlug: string): Promise<Card> {
  const accountSlug = await creatorAccountSlug(creator.id);
  const card = await createCard(input, accountSlug ? { accountSlug } : {}, { actorUserId: creator.id });
  logger.info({ audit: true, action: "card.create", card: card.worktreeSlug, by: creator.username, from: fromCardSlug }, "card created by another card");
  void prepareCard(card.id, "card.create").catch((err: unknown) => {
    logger.warn({ card: card.worktreeSlug, detail: (err as Error).message }, "pre-provisioning of the new card failed (best-effort) — the first open will do it");
  });
  return card;
}
