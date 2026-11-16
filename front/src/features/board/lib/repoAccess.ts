import type { RepoAccessRefusal } from "@/api/types";

/**
 * The project PR list's no-access refusal (`GET /projects/:id/prs` → 403 `sem_acesso_repo`): the GitHub
 * account that read it and the repository it does not see. Null = any other failure — a 403 of another
 * shape (a proxy in front of the install) included, so the panel shows that error as it came. PURE.
 */
export function repoAccessRefusal(err: unknown): Pick<RepoAccessRefusal, "login" | "repo"> | null {
  const response = (err as { response?: { status?: number; data?: unknown } } | null)?.response;
  if (response?.status !== 403) return null;
  const data = response.data as Partial<Record<keyof RepoAccessRefusal, unknown>> | null | undefined;
  if (typeof data !== "object" || data === null) return null;
  const { error, login, repo } = data;
  if (typeof error !== "string" || !error.startsWith("sem_acesso_repo:")) return null;
  if (typeof login !== "string" || typeof repo !== "string") return null;
  return { login, repo };
}
