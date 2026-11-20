import { post } from "@/lib/api";
import type { VoiceActionCall } from "./useVoiceDelegation";

export async function runVoiceAction(cardId: string, call: VoiceActionCall): Promise<unknown> {
  const { output } = await post<{ output: unknown }>(`/cards/${encodeURIComponent(cardId)}/voice/actions`, call);
  return output;
}
