/**
 * WHO this tab is, as far as the chat socket cares. The back resolves a message's author ONCE per
 * connection (see back/src/routes/cardSdk.ts), so a socket opened as one account keeps stamping
 * that account after the tab signs in as another (the focus revalidation in SessionGuard flips the
 * sidebar name, but not the open socket). The `epoch` is what the socket effect depends on: it moves
 * only on a REAL switch between two known accounts.
 */
export interface ViewerIdentity {
  /** The last KNOWN account id (a vanished session does not erase it). */
  id: string | null;
  /** Bumps on every switch from one known account to another. */
  epoch: number;
}

/** Fold the current `/auth/me` id in. Returns the SAME object when nothing changes. PURE. */
export function nextIdentity(prev: ViewerIdentity, id: string | null | undefined): ViewerIdentity {
  if (!id || id === prev.id) return prev;
  if (prev.id === null) return { id, epoch: prev.epoch };
  return { id, epoch: prev.epoch + 1 };
}
