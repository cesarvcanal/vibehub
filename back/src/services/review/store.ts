import { JsonStore } from "../../store/jsonStore.js";
import { dataPath } from "../../config/env.js";
import { isReviewClosed, type Review } from "./model.js";

/**
 * REVIEWS STORE — `reviews.json`, a file of its own next to `board.json`.
 *
 * It stays out of the board on purpose: the orchestrator mutates the review every round (findings, log,
 * phase) and must not compete for the board's write queue, which the status hooks hammer. Same mould as
 * `card-events.json`: a JsonStore, tolerant hydration and the store's mutation queue so that two
 * simultaneous writes (the reviewer submitting and the author answering) never undo each other.
 *
 * Readers get a COPY. The store keeps live objects in the cache; returning the object itself would let a
 * caller change the review outside the queue and make the next mutation record that change.
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

const copy = (r: Review): Review => structuredClone(r);

/** The most recent one in the list (tie: the one inserted later). */
export const newest = (list: Review[]): Review | undefined =>
  list.reduce<Review | undefined>((latest, r) => (!latest || r.createdAt >= latest.createdAt ? r : latest), undefined);

export async function getReview(id: string): Promise<Review | undefined> {
  const found = (await store.load()).reviews.find((r) => r.id === id);
  return found && copy(found);
}

/**
 * The card's review in progress (and the PR's, when given). There should never be more than one; if there
 * is, the most recent wins, which is the one the author is looking at.
 */
export async function activeReviewFor(cardId: string, prNumber?: number): Promise<Review | undefined> {
  const found = newest(
    (await store.load()).reviews.filter(
      (r) => r.cardId === cardId && !isReviewClosed(r.phase) && (prNumber === undefined || r.prNumber === prNumber),
    ),
  );
  return found && copy(found);
}

/** A PR's review in progress, by URL, on any card (the most recent, if there is more than one). */
export async function activeReviewForPr(prUrl: string): Promise<Review | undefined> {
  const found = newest((await store.load()).reviews.filter((r) => r.prUrl === prUrl && !isReviewClosed(r.phase)));
  return found && copy(found);
}

/**
 * The reviews a card FOLLOWS, of any phase: its own as the author and those of the PRs it attached
 * (`hubCardId`). It is what the card shows, one line per PR.
 */
export async function listReviewsFollowedBy(cardIds: string[]): Promise<Review[]> {
  const ids = new Set(cardIds);
  return (await store.load()).reviews.filter((r) => ids.has(r.cardId) || (r.hubCardId !== undefined && ids.has(r.hubCardId))).map(copy);
}

/** The review a reviewer card belongs to (active or already closed: the history does not disappear). */
export async function reviewByReviewerCard(reviewerCardId: string): Promise<Review | undefined> {
  const found = newest((await store.load()).reviews.filter((r) => r.reviewerCardId === reviewerCardId));
  return found && copy(found);
}

/** The reviews of the requested cards, of any phase, in the order they were created. */
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
 * Mutates the review inside the store's queue and stamps `updatedAt`. All or nothing: if `fn` throws, none
 * of what it changed reaches the disk (the JsonStore discards the cache). Returns the already mutated review.
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
