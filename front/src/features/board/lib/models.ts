import { useQuery } from "@tanstack/react-query";
import { MODELS_KEY, boardApi, catalogModels } from "@/features/board/api";

/**
 * The model menu's rows, named with the release each alias resolves to today ("Opus 5.5"). Until
 * the server answers — or on a server without the route — the rows are the plain family names, so
 * the menu never waits on this. The server caches for hours; ten minutes here is plenty.
 */
export function useClaudeModels(): readonly { id: string; label: string }[] {
  const { data } = useQuery({ queryKey: MODELS_KEY, queryFn: boardApi.models, staleTime: 10 * 60_000, retry: false });
  return catalogModels(data);
}
