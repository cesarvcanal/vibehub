import type { SdkRow } from "@/features/board/lib/sdkChat";

type ToolRow = Extract<SdkRow, { kind: "tool" }>;

export function findDispatchingSkill(rows: readonly SdkRow[], agentRowId: string): string | undefined {
  const agentRow = rows.find((row): row is ToolRow => row.kind === "tool" && row.id === agentRowId);
  if (!agentRow) return undefined;
  const rowsBeforeDispatch = rows.slice(0, rows.indexOf(agentRow));
  const turnStart = rowsBeforeDispatch.findLastIndex((row) => row.kind === "user") + 1;
  const skillCall = rowsBeforeDispatch
    .slice(turnStart)
    .findLast((row): row is ToolRow => row.kind === "tool" && row.name === "Skill" && row.parent === agentRow.parent);
  const skillInput = skillCall?.input as { skill?: unknown } | undefined;
  return typeof skillInput?.skill === "string" && skillInput.skill !== "" ? skillInput.skill : undefined;
}
