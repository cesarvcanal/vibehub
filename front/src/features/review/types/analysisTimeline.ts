import type { AnalysisTimelineEvent } from "@/api/types";

export interface AnalysisTimelineRow {
  id: string;
  at: number;
  kind: AnalysisTimelineEvent["kind"];
  textKey: string;
  vars: Record<string, string | number>;
  detail?: string;
  current: boolean;
  needsAttention: boolean;
}
