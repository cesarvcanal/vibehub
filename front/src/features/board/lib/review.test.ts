import { describe, expect, it } from "vitest";
import {
  REVIEW_MAX_ROUNDS,
  cardReviewKey,
  cardPeopleKey,
  reviewPill,
  startErrorCode,
  startErrorRoles,
  visiblePrs,
} from "@/features/board/lib/review";
import type { CardPr, ReviewSummary } from "@/api/types";

function pr(number: number, openedAt: number, base = "dev"): CardPr {
  return { number, url: `https://github.com/acme/x/pull/${number}`, base, branch: "card/x", openedAt };
}
function review(overrides: Partial<ReviewSummary> = {}): ReviewSummary {
  return { id: "r1", prNumber: 553, phase: "reviewing", round: 1, ...overrides };
}

describe("reviewPill", () => {
  it("no review reads 'sem revisão' and is quiet", () => {
    expect(reviewPill(undefined)).toEqual({ key: "review.pill.none", tone: "muted" });
  });

  it("reviewing and fixing both read as the round — the AIs are working", () => {
    expect(reviewPill(review({ phase: "reviewing", round: 1 }))).toEqual({
      key: "review.pill.round", vars: { round: 1, max: REVIEW_MAX_ROUNDS }, tone: "warn",
    });
    expect(reviewPill(review({ phase: "fixing", round: 2 }))).toEqual({
      key: "review.pill.round", vars: { round: 2, max: 3 }, tone: "warn",
    });
  });

  it("ready, impasse and merged each have their own label", () => {
    expect(reviewPill(review({ phase: "ready" }))).toMatchObject({ key: "review.pill.ready", tone: "ok" });
    expect(reviewPill(review({ phase: "impasse" }))).toMatchObject({ key: "review.pill.impasse", tone: "info" });
    expect(reviewPill(review({ phase: "merged" }))).toMatchObject({ key: "review.pill.merged", tone: "muted" });
  });

  it("a cancelled review is no review — the server omits it, a stale cache must not show it", () => {
    expect(reviewPill(review({ phase: "cancelled" }))).toEqual({ key: "review.pill.none", tone: "muted" });
  });
});

describe("visiblePrs", () => {
  it("lists the newest PR first", () => {
    const list = visiblePrs({ prs: [pr(10, 100, "dev"), pr(12, 300, "prod"), pr(11, 200, "hml")] });
    expect(list.map((p) => p.number)).toEqual([12, 11, 10]);
  });

  it("is empty for a card that never opened a PR", () => {
    expect(visiblePrs({})).toEqual([]);
    expect(visiblePrs({ prs: [] })).toEqual([]);
  });

  it("hides the PR whose review was merged, and keeps the one under review", () => {
    const prs = [pr(552, 100), pr(553, 200, "prod")];
    expect(visiblePrs({ prs, review: review({ prNumber: 552, phase: "merged" }) }).map((p) => p.number)).toEqual([553]);
    expect(visiblePrs({ prs, review: review({ prNumber: 553, phase: "fixing" }) }).map((p) => p.number)).toEqual([553, 552]);
  });

  it("does not mutate the card's own list", () => {
    const prs = [pr(1, 1), pr(2, 2)];
    visiblePrs({ prs });
    expect(prs.map((p) => p.number)).toEqual([1, 2]);
  });
});

describe("startErrorCode", () => {
  it("reads the code the server puts before the colon", () => {
    expect(startErrorCode({ response: { status: 400, data: { error: "revisor_sem_conta: o revisor não tem uma conta" } } }))
      .toBe("revisor_sem_conta");
    expect(startErrorCode({ response: { status: 400, data: { error: "papel_sem_work: authorUserId só tem leitura" } } }))
      .toBe("papel_sem_work");
  });

  it("a 403 is its own code, whatever the body says", () => {
    expect(startErrorCode({ response: { status: 403, data: { error: "forbidden" } } })).toBe("forbidden");
  });

  it("an unknown message has no code — the caller shows it as it came", () => {
    expect(startErrorCode({ response: { status: 400, data: { error: "prNumber inválido" } } })).toBeNull();
    expect(startErrorCode(new Error("Network Error"))).toBeNull();
  });
});

describe("startErrorRoles", () => {
  it("lists the roles the server named, in the order it named them", () => {
    expect(
      startErrorRoles({ response: { status: 400, data: { error: "papel_sem_work: authorUserId, mergerUserId só tem leitura neste card" } } }),
    ).toEqual(["author", "merger"]);
    expect(
      startErrorRoles({ response: { status: 400, data: { error: "pessoa_sem_acesso: coauthorUserId não alcança este card" } } }),
    ).toEqual(["coauthor"]);
  });

  it("is empty when the message names none", () => {
    expect(startErrorRoles({ response: { status: 400, data: { error: "sem_pr: o card não tem o PR #3" } } })).toEqual([]);
  });
});

describe("query keys", () => {
  it("are the ones the panel (next task) reads", () => {
    expect(cardPeopleKey("c1")).toEqual(["card-people", "c1"]);
    expect(cardReviewKey("c1")).toEqual(["card-review", "c1"]);
  });
});
