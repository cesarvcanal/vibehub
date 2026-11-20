import type { CardWait } from "@/api/types";

export type CardWaitPhase = "waiting" | "ready" | "failed";

export function cardWaitPhase(wait: CardWait): CardWaitPhase {
  if (wait.readyAt === undefined) return "waiting";
  return wait.failure ? "failed" : "ready";
}
