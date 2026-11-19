import type { PublicUser } from "../../auth/users.js";
import { creatorAccountSlug, getUserGit } from "../../auth/userGit.js";
import { createCard, listGithubConnections, type Card, type CreateCardInput, type Project } from "../board/registry.js";
import { prepareCard } from "../board/workspace.js";
import { canPushToRepo } from "../github/client.js";
import { resolveIdentity } from "../github/identity.js";
import { getSettings } from "../settings/settings.js";
import { logger } from "../../utils/logger.js";

export async function repoPushRefusal(creator: PublicUser, project: Project): Promise<string | null> {
  if (!project.repoFullName) return null;
  const connections = await listGithubConnections();
  const { connectionId } = resolveIdentity({
    actor: await getUserGit(creator.id), project, settings: await getSettings(), connections,
  });
  const connection = connections.find((candidate) => candidate.id === connectionId);
  if (!connection) {
    return `no GitHub account is connected on vibehub, so a card of '${project.name}' could not push to ${project.repoFullName}`;
  }
  if (await canPushToRepo(connection.id, project.repoFullName)) return null;
  return `the GitHub account '${connection.login}', which ${creator.username}'s cards use, cannot push to ${project.repoFullName}`;
}

export async function createCardAs(creator: PublicUser, input: CreateCardInput, fromCardSlug: string): Promise<Card> {
  const accountSlug = await creatorAccountSlug(creator.id);
  const card = await createCard(input, accountSlug ? { accountSlug } : {}, { actorUserId: creator.id });
  logger.info({ audit: true, action: "card.create", card: card.worktreeSlug, by: creator.username, from: fromCardSlug }, "card created by another card");
  void prepareCard(card.id, "card.create").catch((err: unknown) => {
    logger.warn({ card: card.worktreeSlug, detail: (err as Error).message }, "pre-provisioning of the new card failed (best-effort) — the first open will do it");
  });
  return card;
}
