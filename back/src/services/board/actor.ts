import type { PublicUser } from "../../auth/users.js";
import { cardLevel } from "../../auth/access.js";
import { stampCardActor } from "./registry.js";
import { reapplyCardIdentity } from "./workspace.js";

/**
 * WHO IS WORKING THIS CARD — recorded at the three moments a person touches one (opening it,
 * attaching its terminal, sending it a prompt), so its commits and pushes carry THEIR GitHub
 * identity instead of the install's.
 *
 * The rule lives here, once, because the four routes that call it do not share a guard: the terminal
 * websocket is `requireCardAccess` (a `view` share may watch it) while the others are
 * `requireCardWork`. Stamping on access alone would let a SPECTATOR become the author of somebody
 * else's commits — so the level is checked here regardless of which guard let the request in.
 *
 * Fire-and-forget on the runner side: the identity is reapplied only when the actor actually
 * CHANGED, and a runner that cannot be reached must never fail the prompt that triggered it.
 */
export async function recordCardActor(user: PublicUser | null, cardId: string): Promise<void> {
  if (!user || !cardId) return;
  if ((await cardLevel(user, cardId)) !== "work") return;
  const stamped = await stampCardActor(cardId, user.id);
  // Only on a real switch: this runs on every attach and every prompt, and re-running the script
  // for the same person would be a docker exec per keystroke-ish event for no change at all.
  if (stamped?.changed) void reapplyCardIdentity(cardId);
}
