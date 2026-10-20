import type { PublicUser } from "../../auth/users.js";
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
 * The actor each card is known to have, as this process last saw or wrote it. Every stamp goes
 * through {@link recordCardActor}, so this is what lets a caller ask SYNCHRONOUSLY whether a message
 * needs to wait for a switch ({@link isCardActor}) — the common case, the same person again, must
 * not cost the chat an await per frame.
 */
const knownActors = new Map<string, string>();

/** Is this person already the card's author, as far as this process knows? PURE read, sync. */
export function isCardActor(user: PublicUser | null, cardId: string): boolean {
  return !!user && knownActors.get(cardId) === user.id;
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
    // Already the author: nothing to decide, nothing to write, nobody to ask about access.
    if ((await getCard(cardId))?.actorUserId === user.id) {
      knownActors.set(cardId, user.id);
      return;
    }
    if ((await cardLevel(user, cardId)) !== "work") return;
    const stamped = await stampCardActor(cardId, user.id);
    if (!stamped) return;
    knownActors.set(cardId, user.id);
    if (!stamped.changed) return;
    let timer: NodeJS.Timeout | undefined;
    const landed = reapplyCardIdentity(cardId).catch((err: unknown) => {
      logger.warn({ card: cardId, detail: (err as Error).message }, "could not reapply the card's git identity");
    });
    const late = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        logger.warn({ card: cardId }, "the card's new identity is still landing — the order goes on");
        resolve();
      }, opts.waitMs ?? IDENTITY_WAIT_MS);
    });
    await Promise.race([landed, late]);
    clearTimeout(timer);
  } catch (err) {
    logger.warn({ card: cardId, detail: (err as Error).message }, "could not record the card's actor");
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
