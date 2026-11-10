import { useQuery, useQueryClient } from "@tanstack/react-query";
import { boardApi, githubBranchesKey } from "@/features/board/api";

/**
 * Lista abaixo disso é considerada fresca: abrir e fechar o seletor várias vezes seguidas não
 * dispara uma ida ao GitHub por clique.
 */
const VALIDADE_LISTA_MS = 15_000;

/**
 * As branches reais do repositório. A lista se atualiza quando o seletor ABRE (`atualizarSeVelha`),
 * nunca por intervalo: assim branch nova aparece e branch apagada some na hora de escolher, sem
 * polling. `forcarAtualizacao` é o botão de atualizar, que ignora a validade. Duas chamadas ao mesmo
 * tempo viram uma só (a do react-query em andamento é reaproveitada).
 */
export function useBranchesDoRepo({
  connection,
  owner,
  repo,
  habilitado,
}: {
  connection: string;
  owner: string | null;
  repo: string | null;
  habilitado: boolean;
}) {
  const queryClient = useQueryClient();
  const opcoesConsulta = (dono: string, repositorio: string) => ({
    queryKey: githubBranchesKey(connection, dono, repositorio),
    queryFn: () => boardApi.githubBranches(connection, dono, repositorio),
    staleTime: VALIDADE_LISTA_MS,
  });
  const consulta = useQuery({
    ...opcoesConsulta(owner ?? "", repo ?? ""),
    enabled: habilitado && Boolean(owner && repo),
    retry: false,
  });

  const atualizarSeVelha = () => {
    if (!owner || !repo) return;
    void queryClient.prefetchQuery(opcoesConsulta(owner, repo));
  };

  const forcarAtualizacao = () => {
    void consulta.refetch({ cancelRefetch: false });
  };

  return {
    branches: consulta.data?.branches,
    branchPadrao: consulta.data?.defaultBranch ?? null,
    atualizando: consulta.isFetching,
    falhou: consulta.isError,
    atualizarSeVelha,
    forcarAtualizacao,
  };
}
