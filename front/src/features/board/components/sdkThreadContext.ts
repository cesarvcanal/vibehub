import * as React from "react";
import type { SdkRow } from "@/features/board/lib/sdkChat";

/**
 * O que um card da conversa precisa saber sobre o RESTO dela, sem atravessar o `SdkChatRow`
 * memoizado por props: as linhas de cada subagente (por id da chamada que o disparou), qual
 * TodoWrite é o mais recente, e como desenhar uma linha (o card do subagente desenha as filhas com
 * o mesmo `SdkChatRow` da conversa — passado aqui para não haver import circular).
 */
export interface SdkThread {
  subagentRows: ReadonlyMap<string, readonly SdkRow[]>;
  latestTodoId: string | null;
  renderRow: (row: SdkRow) => React.ReactNode;
}

export const SdkThreadContext = React.createContext<SdkThread>({
  subagentRows: new Map(),
  latestTodoId: null,
  renderRow: () => null,
});
