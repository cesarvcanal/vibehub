import { useQuery, useQueryClient } from "@tanstack/react-query";
import { boardApi, githubBranchesKey } from "@/features/board/api";

/**
 * A list younger than this counts as fresh: opening and closing the picker several times in a row
 * does not send one trip to GitHub per click.
 */
const LIST_FRESH_MS = 15_000;

/**
 * The repository's real branches. The list refreshes when the picker OPENS (`refreshIfStale`),
 * never on an interval: that way a new branch shows up and a deleted one disappears at the moment of
 * choosing, without polling. `forceRefresh` is the refresh button, which ignores the freshness. Two
 * calls at the same time become one (react-query reuses the request in flight).
 */
export function useRepoBranches({
  connection,
  owner,
  repo,
  enabled,
}: {
  connection: string;
  owner: string | null;
  repo: string | null;
  enabled: boolean;
}) {
  const queryClient = useQueryClient();
  const queryOptionsFor = (ownerName: string, repoName: string) => ({
    queryKey: githubBranchesKey(connection, ownerName, repoName),
    queryFn: () => boardApi.githubBranches(connection, ownerName, repoName),
    staleTime: LIST_FRESH_MS,
  });
  const query = useQuery({
    ...queryOptionsFor(owner ?? "", repo ?? ""),
    enabled: enabled && Boolean(owner && repo),
    retry: false,
  });

  const refreshIfStale = () => {
    if (!owner || !repo) return;
    void queryClient.prefetchQuery(queryOptionsFor(owner, repo));
  };

  const forceRefresh = () => {
    void query.refetch({ cancelRefetch: false });
  };

  return {
    branches: query.data?.branches,
    defaultBranch: query.data?.defaultBranch ?? null,
    truncated: query.data?.truncada ?? false,
    refreshing: query.isFetching,
    failed: query.isError,
    refreshIfStale,
    forceRefresh,
  };
}
