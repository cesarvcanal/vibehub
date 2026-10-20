import { findUser, type PublicUser } from "../../auth/users.js";
import { cardLevel } from "../../auth/access.js";
import { stampCardActor, getCard } from "./registry.js";
import { reapplyCardIdentity } from "./workspace.js";
import { parseSdkClientFrame } from "../sdk/protocol.js";
import { logger } from "../../utils/logger.js";

/**
 * How long a message may be held while its author's identity lands in the runner. The application
 * is one docker exec (well under a second); past this the runner is in trouble, and the message goes
 * on rather than waiting for something that is not coming.
 */
const IDENTITY_WAIT_MS = 20_000;

/**
 * The author whose identity THIS PROCESS SAW LAND in the runner, per card. It is what lets a caller
 * ask SYNCHRONOUSLY whether a message must wait for a switch ({@link isCardActor}) — the common case,
 * the same person again, must not cost the chat an await per frame.
 *
 * Set only AFTER a landing succeeded, never at the stamp: an application that failed (runner down,
 * docker exec timeout) or a back that restarted mid-switch would otherwise read "already the author"
 * forever, and the person's commits would keep going out as the previous one — silently.
 */
const landedActors = new Map<string, string>();

/** Has this person's identity landed on the card, as far as this process saw? Sync. */
export function isCardActor(user: PublicUser | null, cardId: string): boolean {
  return !!user && landedActors.get(cardId) === user.id;
}

/** Forgets a card (it was deleted): nothing landed is assumed for an id that may come back. */
export function forgetCardActor(cardId: string): void {
  landedActors.delete(cardId);
}

/**
 * WHO IS WORKING THIS CARD — recorded when a person gives it an ORDER (a chat message, a prompt, a
 * keystroke in its terminal, a delivery), so its commits, pushes, PRs and reviews carry THEIR GitHub
 * identity. Opening or watching a card is not an order: it never takes the authorship from whoever
 * asked for the work in flight.
 *
 * The level is checked here regardless of which guard let the request in: a `view` share must never
 * become the author of somebody else's commits.
 *
 * On a REAL switch it resolves only once the new identity LANDED in the runner (token file, git
 * config, gh wrapper — see workspace.ts buildIdentityScript), bounded by `waitMs`. That is what lets
 * the caller hold the message until then: otherwise the first commit of the new person's request
 * could still go out as the previous one. When nothing changes it returns without a write, a docker
 * exec or an access query.
 *
 * NEVER REJECTS: some callers run it as `void recordCardActor(...)`, and an unowned rejection ends
 * the Node process — every terminal and chat with it. A failed stamp (full disk) only costs the
 * attribution of the next commit; it is logged, and the order goes on.
 */
export async function recordCardActor(
  user: PublicUser | null, cardId: string, opts: { waitMs?: number } = {},
): Promise<void> {
  if (!user || !cardId) return;
  try {
    // Already the author AND seen landing: nothing to decide, write, ask or apply.
    if (isCardActor(user, cardId)) return;
    const card = await getCard(cardId);
    if (!card) return;
    if (card.actorUserId !== user.id) {
      if ((await cardLevel(user, cardId)) !== "work") return;
      if (!(await stampCardActor(cardId, user.id))) return;
    }
    // Stamped now, or stamped before this process could see it land (a restart, a failed apply):
    // either way the identity is applied, and only a CONFIRMED landing is remembered.
    landedActors.delete(cardId);
    let timer: NodeJS.Timeout | undefined;
    const landed = reapplyCardIdentity(cardId);
    const late = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => {
        logger.warn({ card: cardId }, "the card's new identity is still landing — the order goes on");
        resolve(false);
      }, opts.waitMs ?? IDENTITY_WAIT_MS);
    });
    const ok = await Promise.race([landed, late]);
    clearTimeout(timer);
    if (ok !== false && (await getCard(cardId))?.actorUserId === user.id) landedActors.set(cardId, user.id);
  } catch (err) {
    logger.warn({ card: cardId, detail: (err as Error).message }, "could not record the card's actor");
  }
}

/**
 * A card delegating to another (the maestro's `vibehub_send_to_terminal`) passes on an order a
 * PERSON gave it: the sender card's author becomes the destination's, so what that order makes the
 * other card commit, push or merge carries the person behind it. Same rules as a message — the level
 * is checked, and the switch lands before the caller sends. No sender, no author: nothing changes.
 * Never rejects.
 */
export async function relayCardActor(fromCardId: string | undefined, toCardId: string): Promise<void> {
  if (!fromCardId) return;
  try {
    const authorId = (await getCard(fromCardId))?.actorUserId;
    if (!authorId) return;
    await recordCardActor(await findUser(authorId), toCardId);
  } catch (err) {
    logger.warn({ card: toCardId, detail: (err as Error).message }, "could not relay the sender card's author");
  }
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
