/**
 * Map e Set guardam a ordem de inserção: a primeira chave é a mais antiga. É isso que mantém
 * limitadas as memórias por card (recibos, rascunhos, cartões de pergunta, dedupe do espelho) sem
 * relógio nem contador. PURE-ish (muda a coleção recebida).
 */

/** Tira as chaves mais antigas até sobrarem no máximo `keep`. */
export function dropOldest(keyed: Map<unknown, unknown> | Set<unknown>, keep: number): void {
  for (const oldest of keyed.keys()) {
    if (keyed.size <= keep) return;
    keyed.delete(oldest);
  }
}
