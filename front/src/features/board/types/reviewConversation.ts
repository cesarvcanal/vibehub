import type { AnalysisConversation } from "@/api/types";

export interface RunConversationRead {
  conversation: AnalysisConversation | null;
  lastReadFailed: boolean;
}
