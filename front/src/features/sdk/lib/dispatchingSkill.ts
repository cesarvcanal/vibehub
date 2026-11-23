import type { SdkRow } from "@/features/board/lib/sdkChat";
import { readSkillName } from "./skillName";

export function findDispatchingSkill(rows: readonly SdkRow[], agentRowId: string): string | undefined {
  const lastSkillByCaller = new Map<string | undefined, string | undefined>();
  for (const row of rows) {
    if (row.kind === "user") lastSkillByCaller.clear();
    if (row.kind !== "tool") continue;
    if (row.id === agentRowId) return lastSkillByCaller.get(row.parent);
    if (row.name === "Skill") lastSkillByCaller.set(row.parent, readSkillName(row.input));
  }
  return undefined;
}
