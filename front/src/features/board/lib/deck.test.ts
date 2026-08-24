import { describe, expect, it } from "vitest";
import {
  DECK_LIMIT_DESKTOP,
  DECK_LIMIT_MOBILE,
  deckLimit,
  dropFromDeck,
  pruneDeck,
  touchDeck,
  type DeckEntry,
} from "@/features/board/lib/deck";

/** Shorthand: the deck as `card@project` pairs, in render order. */
const shape = (deck: readonly DeckEntry[]) => deck.map((e) => `${e.cardId}@${e.projectId}`);

/** Opens a run of cards in the same project, in order. */
function open(cards: string[], limit = DECK_LIMIT_DESKTOP, projectId = "p1"): DeckEntry[] {
  return cards.reduce<DeckEntry[]>((deck, cardId) => touchDeck(deck, { cardId, projectId }, limit), []);
}

describe("touchDeck", () => {
  it("keeps every card that has been opened, so switching back is instant", () => {
    expect(shape(open(["a", "b", "c"]))).toEqual(["a@p1", "b@p1", "c@p1"]);
  });

  it("appends in INSERTION order and never reshuffles — the panes are real DOM nodes", () => {
    // Re-opening `a` must not move it to the end: the deck is rendered as a list, and reordering it
    // would move a live terminal's element for no visible gain.
    const deck = touchDeck(open(["a", "b", "c"]), { cardId: "a", projectId: "p1" }, DECK_LIMIT_DESKTOP);
    expect(shape(deck)).toEqual(["a@p1", "b@p1", "c@p1"]);
  });

  it("returns the SAME array when the card is already the most recent one", () => {
    const deck = open(["a", "b"]);
    expect(touchDeck(deck, { cardId: "b", projectId: "p1" }, DECK_LIMIT_DESKTOP)).toBe(deck);
  });

  it("is pure: running it twice on the same deck answers the same thing", () => {
    const deck = open(["a", "b"]);
    const once = touchDeck(deck, { cardId: "a", projectId: "p1" }, DECK_LIMIT_DESKTOP);
    const twice = touchDeck(deck, { cardId: "a", projectId: "p1" }, DECK_LIMIT_DESKTOP);
    expect(twice).toEqual(once);
  });

  it("drops the LEAST RECENTLY USED card when the deck is full", () => {
    // `a` is opened again, so `b` is now the oldest and it is `b` that leaves.
    let deck = open(["a", "b", "c"], 3);
    deck = touchDeck(deck, { cardId: "a", projectId: "p1" }, 3);
    deck = touchDeck(deck, { cardId: "d", projectId: "p1" }, 3);
    expect(shape(deck)).toEqual(["a@p1", "c@p1", "d@p1"]);
  });

  it("never evicts the card being opened, whatever the limit says", () => {
    const deck = touchDeck(open(["a", "b"], 1), { cardId: "c", projectId: "p1" }, 1);
    expect(shape(deck)).toEqual(["c@p1"]);
  });

  it("follows a card that moved to another project", () => {
    const deck = touchDeck(open(["a"]), { cardId: "a", projectId: "p2" }, DECK_LIMIT_DESKTOP);
    expect(shape(deck)).toEqual(["a@p2"]);
  });
});

describe("dropFromDeck", () => {
  it("removes a card whose session is gone", () => {
    expect(shape(dropFromDeck(open(["a", "b"]), "a"))).toEqual(["b@p1"]);
  });

  it("leaves the deck untouched — same array — when the card is not in it", () => {
    const deck = open(["a"]);
    expect(dropFromDeck(deck, "zzz")).toBe(deck);
  });
});

describe("pruneDeck", () => {
  it("drops the cards of a project that no longer exists", () => {
    const deck = [...open(["a"], DECK_LIMIT_DESKTOP, "p1"), ...open(["b"], DECK_LIMIT_DESKTOP, "p2")];
    expect(shape(pruneDeck(deck, ["p1"]))).toEqual(["a@p1"]);
  });

  it("returns the same array when every project is still live", () => {
    const deck = open(["a", "b"]);
    expect(pruneDeck(deck, ["p1", "p2"])).toBe(deck);
  });
});

describe("deckLimit", () => {
  it("is tighter on a phone, where memory and contexts are", () => {
    expect(deckLimit(true)).toBe(DECK_LIMIT_MOBILE);
    expect(deckLimit(false)).toBe(DECK_LIMIT_DESKTOP);
    expect(DECK_LIMIT_MOBILE).toBeLessThan(DECK_LIMIT_DESKTOP);
  });
});
