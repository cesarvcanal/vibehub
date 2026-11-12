/**
 * Map and Set keep insertion order: the first key is the oldest. That is what keeps the per-card
 * memories (receipts, drafts, question cards, the mirror's dedupe) bounded with no clock or
 * counter. PURE-ish (mutates the collection it receives).
 */

/** Drops the oldest keys until at most `keep` remain. */
export function dropOldest(keyed: Map<unknown, unknown> | Set<unknown>, keep: number): void {
  for (const oldest of keyed.keys()) {
    if (keyed.size <= keep) return;
    keyed.delete(oldest);
  }
}
