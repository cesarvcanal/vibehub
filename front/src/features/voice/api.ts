import { post } from "@/lib/api";
import type { VoiceActionCall, VoiceActionResult } from "@/api/types";

export async function runVoiceAction(cardId: string, call: VoiceActionCall): Promise<unknown> {
  const { output } = await post<VoiceActionResult>(`/cards/${encodeURIComponent(cardId)}/voice/actions`, call);
  return output;
}
