import type { PublicUser } from "../../auth/users.js";
import { creatorAccountSlug, getUserGit } from "../../auth/userGit.js";
import { createCard, listGithubConnections, type Card, type CreateCardInput, type Project } from "../board/registry.js";
import { prepareCard } from "../board/workspace.js";
import { canPushToRepo } from "../github/client.js";
import { resolveIdentity } from "../github/identity.js";
import { getSettings } from "../settings/settings.js";
import { logger } from "../../utils/logger.js";

export async function repoPushRefusals(creator: PublicUser, projects: Project[]): Promise<Map<string, string | null>> {
  const [connections, actor, settings] = await Promise.all([listGithubConnections(), getUserGit(creator.id), getSettings()]);
  const pushChecks = new Map<string, Promise<boolean>>();
  const pushCheckFor = (connectionId: string, repoFullName: string): Promise<boolean> => {
    const key = `${connectionId} ${repoFullName}`;
    const check = pushChecks.get(key) ?? canPushToRepo(connectionId, repoFullName);
    pushChecks.set(key, check);
    return check;
  };
  const refusalFor = async (project: Project): Promise<string | null> => {
    if (!project.repoFullName) return null;
    const { connectionId } = resolveIdentity({ actor, project, settings, connections });
    const connection = connections.find((candidate) => candidate.id === connectionId);
    if (!connection) {
      return `no GitHub account is connected on vibehub, so a card of '${project.name}' could not push to ${project.repoFullName}`;
    }
    try {
      if (await pushCheckFor(connection.id, project.repoFullName)) return null;
    } catch (err) {
      return `could not check whether the GitHub account '${connection.login}' can push to ${project.repoFullName}: ${(err as Error).message}`;
    }
    return `the GitHub account '${connection.login}', which ${creator.username}'s cards use, cannot push to ${project.repoFullName}`;
  };
  return new Map(await Promise.all(projects.map(async (project) => [project.id, await refusalFor(project)] as const)));
}

export async function createCardAs(creator: PublicUser, input: CreateCardInput, fromCardId: string): Promise<Card> {
  const accountSlug = await creatorAccountSlug(creator.id);
  const card = await createCard(input, accountSlug ? { accountSlug } : {}, { actorUserId: creator.id });
  logger.info({ audit: true, action: "card.create", card: card.worktreeSlug, by: creator.username, from: fromCardId }, "card created by another card");
  void prepareCard(card.id, "card.create").catch((err: unknown) => {
    logger.warn({ card: card.worktreeSlug, detail: (err as Error).message }, "pre-provisioning of the new card failed (best-effort) — the first open will do it");
  });
  return card;
}
