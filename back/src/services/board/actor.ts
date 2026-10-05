import type { PublicUser } from "../../auth/users.js";
import { cardLevel } from "../../auth/access.js";
import { stampCardActor, getCard } from "./registry.js";
import { reapplyCardIdentity } from "./workspace.js";
import { parseSdkClientFrame } from "../sdk/protocol.js";

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
 *
 * CHEAP WHEN NOTHING CHANGES, because it is called PER MESSAGE (see {@link authorsTheTurn}): the
 * early return below reads the cached board and stops there. Without it, every message would cost
 * an access query plus a full rewrite of `board.json` — `store.mutate` persists the whole document
 * even when the mutation changed nothing — for the common case of the same person typing again.
 */
export async function recordCardActor(user: PublicUser | null, cardId: string): Promise<void> {
  if (!user || !cardId) return;
  // Already the author: nothing to decide, nothing to write, nobody to ask about access.
  if ((await getCard(cardId))?.actorUserId === user.id) return;
  if ((await cardLevel(user, cardId)) !== "work") return;
  const stamped = await stampCardActor(cardId, user.id);
  // Only on a real switch: this runs on every attach and every prompt, and re-running the script
  // for the same person would be a docker exec per keystroke-ish event for no change at all.
  if (stamped?.changed) void reapplyCardIdentity(cardId);
}

/**
 * Does this chat frame mean "THIS person is asking for the work"? Only a user message does — the
 * typed turn and the edit of one. PURE.
 *
 * The exclusions are the point: ANSWERING is not commanding. Clicking "allow" on a permission the
 * other person's turn raised, answering its question, or hitting interrupt must not hand the
 * authorship of the next commit to whoever happened to click — the turn still belongs to the one
 * who asked for it. Anything unparseable is nobody's command.
 */
export function authorsTheTurn(frame: string): boolean {
  const control = parseSdkClientFrame(frame);
  return control?.type === "user" || control?.type === "edit_user";
}
