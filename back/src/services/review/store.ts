import { JsonStore } from "../../store/jsonStore.js";
import { dataPath } from "../../config/env.js";
import type { Review } from "./model.js";

/**
 * STORE DAS REVISÕES — `reviews.json`, um arquivo próprio ao lado do `board.json`.
 *
 * Fica fora do board de propósito: o orquestrador muta a revisão a cada rodada (achados, log, fase) e
 * não deve disputar a fila de escrita do board, que os hooks de status martelam. Mesmo molde do
 * `card-events.json`: um JsonStore, hidratação tolerante e a fila de mutações do store pra que duas
 * escritas simultâneas (o revisor submetendo e o autor respondendo) nunca se desfaçam.
 *
 * Quem lê recebe CÓPIA. O store guarda objetos vivos no cache; devolver o próprio objeto deixaria um
 * chamador alterar a revisão fora da fila e fazer a próxima mutação gravar a alteração dele.
 */

interface ReviewsDoc {
  reviews: Review[];
}

const store = new JsonStore<ReviewsDoc>(
  dataPath("reviews.json"),
  () => ({ reviews: [] }),
  (raw) => {
    const doc = (raw ?? {}) as Partial<ReviewsDoc>;
    return { reviews: Array.isArray(doc.reviews) ? doc.reviews : [] };
  },
);

/** Revisão encerrada: o PR foi mergeado ou a revisão cancelada. `impasse` NÃO está aqui: espera um humano. */
const FINISHED: ReadonlySet<Review["phase"]> = new Set(["merged", "cancelled"]);

const copy = (r: Review): Review => structuredClone(r);

/** A mais recente da lista (empate: a inserida depois). */
const newest = (list: Review[]): Review | undefined =>
  list.reduce<Review | undefined>((latest, r) => (!latest || r.createdAt >= latest.createdAt ? r : latest), undefined);

export async function getReview(id: string): Promise<Review | undefined> {
  const found = (await store.load()).reviews.find((r) => r.id === id);
  return found && copy(found);
}

/**
 * A revisão em andamento do card (e do PR, quando dado). Mais de uma não deveria existir; se existir,
 * a mais recente vence, que é a que o autor está olhando.
 */
export async function activeReviewFor(cardId: string, prNumber?: number): Promise<Review | undefined> {
  const found = newest(
    (await store.load()).reviews.filter(
      (r) => r.cardId === cardId && !FINISHED.has(r.phase) && (prNumber === undefined || r.prNumber === prNumber),
    ),
  );
  return found && copy(found);
}

/** A revisão a que um card de revisor pertence (ativa ou já encerrada: o histórico não some). */
export async function reviewByReviewerCard(reviewerCardId: string): Promise<Review | undefined> {
  const found = newest((await store.load()).reviews.filter((r) => r.reviewerCardId === reviewerCardId));
  return found && copy(found);
}

/** As revisões dos cards pedidos, de qualquer fase, na ordem em que foram criadas. */
export async function listReviewsForCards(cardIds: string[]): Promise<Review[]> {
  if (cardIds.length === 0) return [];
  const wanted = new Set(cardIds);
  return (await store.load()).reviews.filter((r) => wanted.has(r.cardId)).map(copy);
}

export async function insertReview(r: Review): Promise<void> {
  await store.mutate((doc) => {
    if (doc.reviews.some((x) => x.id === r.id)) throw new Error(`review ${r.id} already exists`);
    doc.reviews.push(copy(r));
  });
}

/**
 * Muta a revisão dentro da fila do store e carimba `updatedAt`. Tudo ou nada: se `fn` lança, nada do
 * que ela alterou chega ao disco (o JsonStore descarta o cache). Devolve a revisão já mutada.
 */
export async function mutateReview(id: string, fn: (r: Review) => void): Promise<Review> {
  return await store.mutate((doc) => {
    const found = doc.reviews.find((r) => r.id === id);
    if (!found) throw new Error(`review ${id} not found`);
    fn(found);
    found.updatedAt = Date.now();
    return copy(found);
  });
}
