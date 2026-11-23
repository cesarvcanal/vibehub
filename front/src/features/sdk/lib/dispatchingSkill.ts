import type { SdkRow } from "@/features/board/lib/sdkChat";

type ToolRow = Extract<SdkRow, { kind: "tool" }>;

const isToolRow = (row: SdkRow): row is ToolRow => row.kind === "tool";

export function findDispatchingSkill(rows: readonly SdkRow[], agentRowId: string): string | undefined {
  const agentIndex = rows.findIndex((row) => isToolRow(row) && row.id === agentRowId);
  if (agentIndex < 0) return undefined;
  const agentRow = rows[agentIndex] as ToolRow;
  const rowsBeforeDispatch = rows.slice(0, agentIndex);
  const turnStart = rowsBeforeDispatch.findLastIndex((row) => row.kind === "user") + 1;
  const skillCall = rowsBeforeDispatch
    .slice(turnStart)
    .findLast((row): row is ToolRow => isToolRow(row) && row.name === "Skill" && row.parent === agentRow.parent);
  const skillInput = skillCall?.input as { skill?: unknown } | undefined;
  return typeof skillInput?.skill === "string" && skillInput.skill !== "" ? skillInput.skill : undefined;
}
