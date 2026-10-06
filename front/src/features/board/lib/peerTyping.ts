/**
 * "Cesar está digitando…" — the two halves of the native chat's typing indicator, kept out of the
 * component so they can be tested without a socket or a DOM.
 *
 * INBOUND: who is typing on this card right now, as `name → expiresAt`. The back relays
 * `peer_typing` frames from the card's other sockets (see back/services/sdk/manager.ts); an entry
 * EXPIRES on its own, so a lost "parou" (a tab killed mid-sentence, a dropped network) can never
 * leave the indicator on screen forever.
 *
 * OUTBOUND: what this tab tells the others. Cheap on purpose — one frame on the first keystroke,
 * then at most one per `TYPING_SEND_EVERY_MS` while typing continues, and one "parou" when the
 * person goes quiet, clears the field, or sends. Never one frame per key.
 */

/** While typing continues, a fresh "digitando" goes out at most this often (it renews the TTL). */
export const TYPING_SEND_EVERY_MS = 2_500;
/** No keystroke for this long ⇒ the person stopped typing. */
export const TYPING_IDLE_MS = 3_000;
/** A peer not heard from for this long is no longer typing. Comfortably > TYPING_SEND_EVERY_MS. */
export const PEER_TYPING_TTL_MS = 6_000;

/** `name → epoch ms the indicator expires at`. */
export type PeerTyping = Readonly<Record<string, number>>;

/** One `peer_typing` frame folded in. Returns the SAME object when nothing changes. PURE. */
export function applyPeerTyping(peers: PeerTyping, name: string, active: boolean, now: number): PeerTyping {
  if (active) return { ...peers, [name]: now + PEER_TYPING_TTL_MS };
  if (!(name in peers)) return peers;
  const next = { ...peers };
  delete next[name];
  return next;
}

/** Who is typing at `now`, the viewer excluded (the same account in two tabs), sorted. PURE. */
export function typingNames(peers: PeerTyping, now: number, viewer: string | undefined): string[] {
  return Object.keys(peers)
    .filter((name) => name !== viewer && peers[name]! > now)
    .sort((a, b) => a.localeCompare(b));
}

/** The soonest expiry still ahead of `now` — when the view must look again. PURE. */
export function nextPeerExpiry(peers: PeerTyping, now: number): number | null {
  let soonest: number | null = null;
  for (const at of Object.values(peers)) {
    if (at > now && (soonest === null || at < soonest)) soonest = at;
  }
  return soonest;
}

export interface TypingSignal {
  /** The field's text after a keystroke. Empty = the person cleared it (stopped). */
  input: (text: string) => void;
  /** Stopped for an outside reason: sent the message, left the card, lost the socket. */
  stop: () => void;
}

/**
 * This tab's outbound signal. `send` may throw (socket not open): typing is best-effort and must
 * never break the composer, so the throw is swallowed.
 */
export function createTypingSignal(send: (active: boolean) => void): TypingSignal {
  let on = false;
  let sentAt = 0;
  let idle: ReturnType<typeof setTimeout> | null = null;

  const emit = (active: boolean): void => {
    try { send(active); } catch { /* offline: the peers' TTL cleans up */ }
  };
  const clearIdle = (): void => {
    if (idle) clearTimeout(idle);
    idle = null;
  };
  const stop = (): void => {
    clearIdle();
    if (!on) return;
    on = false;
    emit(false);
  };
  const input = (text: string): void => {
    if (text.trim() === "") {
      stop();
      return;
    }
    const now = Date.now();
    if (!on || now - sentAt >= TYPING_SEND_EVERY_MS) {
      on = true;
      sentAt = now;
      emit(true);
    }
    clearIdle();
    idle = setTimeout(stop, TYPING_IDLE_MS);
  };
  return { input, stop };
}
