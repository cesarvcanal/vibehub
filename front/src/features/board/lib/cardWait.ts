import type { Card, CardWait } from "@/api/types";

export type CardWaitPhase = "waiting" | "paused" | "waking" | "failed";

export function cardWaitPhase(wait: CardWait, card: Pick<Card, "column" | "pausedAt">): CardWaitPhase {
  if (wait.readyAt === undefined) return "waiting";
  if (wait.failure) return "failed";
  return card.column === "paused" || card.pausedAt ? "paused" : "waking";
}
