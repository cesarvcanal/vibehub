import type { UserGitIdentity } from "../../auth/userGit.js";
import type { GithubConnection, Project } from "../board/registry.js";
import type { Settings } from "../settings/settings.js";

/**
 * WHOSE identity a card operates with, resolved FIELD BY FIELD — not "the first complete record".
 * Somebody who registered only a connection keeps the install's commit author, and somebody who
 * registered only a name keeps the project's connection; treating the identity as one indivisible
 * record would silently drop half of what was configured.
 *
 * Order per field: the card's ACTOR (whoever touched it last) -> the PROJECT -> the INSTALL. A card
 * with no actor resolves to exactly what it resolved to before this file existed, which is what
 * makes the whole feature additive.
 *
 * The actor's connection is only honoured while it still EXISTS. An id left behind by a connection
 * the owner removed falls through to the project, because the alternative is every push of that
 * person failing with a credential that is not in the vault.
 *
 * PURE — no vault, no GitHub, no disk. The caller turns `connectionId` into a token.
 */
export interface EffectiveIdentity {
  /** GitHub connection whose token to use. Absent = this install has no GitHub account at all. */
  connectionId?: string;
  name: string;
  email: string;
}

export function resolveIdentity(opts: {
  actor?: UserGitIdentity | null;
  project: Pick<Project, "githubConnectionId">;
  settings: Pick<Settings, "git">;
  connections: Pick<GithubConnection, "id">[];
}): EffectiveIdentity {
  const { actor, project, settings, connections } = opts;
  const live = (id?: string | null): string | undefined =>
    id && connections.some((c) => c.id === id) ? id : undefined;
  return {
    // `?? connections[0]?.id` is the SAME last resort the clone uses (github/client.ts
    // resolveConnection): a project that names no connection operates as the first account.
    connectionId: live(actor?.githubConnectionId) ?? live(project?.githubConnectionId) ?? connections[0]?.id,
    name: actor?.gitName ?? settings.git.name,
    email: actor?.gitEmail ?? settings.git.email,
  };
}
