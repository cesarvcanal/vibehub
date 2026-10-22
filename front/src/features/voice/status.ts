import { useQuery } from "@tanstack/react-query";
import { get } from "@/lib/api";

/** `GET /api/voice/live` — booleans only, never a key. */
export interface VoiceLiveStatus {
  enabled: boolean;
  available: boolean;
  model: string;
}

export const VOICE_STATUS_KEY = ["voice", "live"] as const;

/**
 * Whether this install can hold a voice conversation. Shared by the /voice page and the card
 * composer's voice button; `enabled: false` asks nothing (a composer outside a card or a router).
 */
export function useVoiceStatus(enabled = true) {
  return useQuery({
    queryKey: VOICE_STATUS_KEY,
    queryFn: () => get<VoiceLiveStatus>("/voice/live"),
    enabled,
    // Changes only when the operator flips the flag or stores a key — no need to ask per card.
    staleTime: 5 * 60_000,
  });
}

/** Where /voice sends the person back to, carried in the navigation state by the composer. */
export interface VoiceReturnState {
  from?: string;
}
