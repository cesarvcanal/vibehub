import { useQuery } from "@tanstack/react-query";
import { get } from "@/lib/api";
import { Paths } from "@/lib/paths";

/** `GET /api/voice/live` — booleans only, never a key. */
export interface VoiceLiveStatus {
  enabled: boolean;
  available: boolean;
  model: string;
}

export const VOICE_STATUS_KEY = ["voice", "live"] as const;

/**
 * Whether this install can hold a voice call. Read by the card composer's voice button;
 * `enabled: false` asks nothing (a composer outside a card chat or a router).
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

/** Where an old `/voice?project=…&card=…` link leads: that card on the board, or the board. PURE. */
export function voiceReturn(search: string): { to: string; card: string | null } {
  const query = new URLSearchParams(search);
  const card = query.get("card");
  if (!card) return { to: Paths.BOARD, card: null };
  const params = new URLSearchParams();
  const project = query.get("project");
  if (project) params.set("project", project);
  params.set("card", card);
  return { to: `${Paths.BOARD}?${params.toString()}`, card };
}
