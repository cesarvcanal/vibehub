import * as React from "react";
import type { SdkRow } from "@/features/board/lib/sdkChat";

/**
 * What a conversation card needs to know about the REST of it, without going through the
 * props-memoized `SdkChatRow`: each subagent's rows (by id of the call that fired it), which
 * TodoWrite is the most recent, and how to draw a row (the subagent card draws its children with
 * the same `SdkChatRow` as the conversation — passed here so there is no circular import).
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
