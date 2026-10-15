/**
 * SUBAGENTES NO CHAT NATIVO — quem fez o quê.
 *
 * Um Agent/Task dispara um subagente, e o driver marca o que ele faz com `parentToolUseId` (a linha
 * guarda como `parent`). Sem separar, o trabalho do subagente aparecia no fio da conversa como se
 * fosse o agente principal mudando de assunto. Aqui o fio é dividido: o principal segue como
 * sempre (é ele que `groupSdkRows` dobra), e o que é de cada subagente vai para debaixo do card
 * da chamada que o disparou. PURE.
 */

import type { SdkRow } from "@/features/board/lib/sdkChat";

/** As tools que disparam um subagente: `Agent` (nome atual no Claude Code) e `Task` (o antigo). */
export function isAgentTool(name: string): boolean {
  return name === "Agent" || name === "Task";
}

export interface SubagentSplit {
  /** O fio principal: tudo que não é de um subagente com pai na tela. */
  main: SdkRow[];
  /** As linhas de cada subagente, pelo id da chamada que o disparou, na ordem em que chegaram. */
  children: ReadonlyMap<string, readonly SdkRow[]>;
}

const NO_CHILDREN: ReadonlyMap<string, readonly SdkRow[]> = new Map();

/**
 * Divide as linhas entre o fio principal e os subagentes. Uma filha cujo pai NÃO está na tela (o
 * replay tem janela e pode ter cortado a chamada) fica no fio principal: escondê-la seria apagar
 * trabalho que aconteceu. Sem subagente nenhum, devolve o MESMO array — o memo da tela não
 * redesenha a conversa por causa disto. PURE.
 */
export function splitSubagentRows(
  rows: SdkRow[],
  previous?: ReadonlyMap<string, readonly SdkRow[]>,
): SubagentSplit {
  const toolIds = new Set<string>();
  let anyChild = false;
  for (const row of rows) {
    if (row.kind === "tool") toolIds.add(row.id);
    if (parentOf(row) !== undefined) anyChild = true;
  }
  if (!anyChild) return { main: rows, children: NO_CHILDREN };
  const main: SdkRow[] = [];
  const children = new Map<string, SdkRow[]>();
  for (const row of rows) {
    const parent = parentOf(row);
    if (parent === undefined || !toolIds.has(parent)) {
      main.push(row);
      continue;
    }
    const list = children.get(parent);
    if (list) list.push(row);
    else children.set(parent, [row]);
  }
  return { main, children: previous && sameChildren(previous, children) ? previous : children };
}

/** Os dois mapas têm as mesmas linhas, pelas mesmas referências (o reducer preserva as intocadas). PURE. */
function sameChildren(a: ReadonlyMap<string, readonly SdkRow[]>, b: ReadonlyMap<string, readonly SdkRow[]>): boolean {
  if (a.size !== b.size) return false;
  for (const [parent, list] of b) {
    const other = a.get(parent);
    if (!other || other.length !== list.length || other.some((row, i) => row !== list[i])) return false;
  }
  return true;
}

/** O id do TodoWrite mais recente do fio principal — o único que a tela mostra aberto. PURE. */
export function latestTodoRowId(rows: readonly SdkRow[]): string | null {
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const row = rows[i] as SdkRow;
    if (row.kind === "tool" && row.name === "TodoWrite" && row.parent === undefined) return row.id;
  }
  return null;
}

function parentOf(row: SdkRow): string | undefined {
  return (row.kind === "tool" || row.kind === "assistant") && row.parent ? row.parent : undefined;
}
