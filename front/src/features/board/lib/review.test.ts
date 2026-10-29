import { describe, expect, it } from "vitest";
import {
  IMPASSE_HEAD_MOVED,
  REVIEW_MAX_ROUNDS,
  cardReviewKey,
  cardPeopleKey,
  findingCounts,
  mergeFailure,
  pendingQuestions,
  reviewActions,
  reviewPill,
  startErrorCode,
  startErrorRoles,
  stuckItems,
  visiblePrs,
} from "@/features/board/lib/review";
import type { CardPr, Finding, Review, ReviewSummary } from "@/api/types";

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

  it("PR mergeado some da lista", () => {
    const merged = { ...pr(12, 300, "prod"), mergedAt: 999 };
    expect(visiblePrs({ prs: [pr(10, 100), merged] }).map((p) => p.number)).toEqual([10]);
    // nenhum PR aberto sobrando: nada a mostrar
    expect(visiblePrs({ prs: [merged] })).toEqual([]);
  });

  it("...exceto o PR da revisão mergeada atual, que fica com a pill 'mergeado'", () => {
    const old = { ...pr(10, 100), mergedAt: 500 };
    const current = { ...pr(12, 300, "prod"), mergedAt: 999 };
    const summary = review({ prNumber: 12, phase: "merged" });
    expect(visiblePrs({ prs: [old, current], review: summary }).map((p) => p.number)).toEqual([12]);
    // a revisão mergeada de OUTRO PR não segura este
    expect(visiblePrs({ prs: [old, current], review: review({ prNumber: 10, phase: "merged" }) }).map((p) => p.number)).toEqual([10]);
    // uma revisão em andamento não devolve um PR já mergeado à lista
    expect(visiblePrs({ prs: [current], review: review({ prNumber: 12, phase: "fixing" }) })).toEqual([]);
  });

  it("um PR sem a marca de mergeado fica, mesmo com a revisão dele mergeada (dado de antes do mergedAt)", () => {
    const prs = [pr(552, 100), pr(553, 200, "prod")];
    expect(visiblePrs({ prs, review: review({ prNumber: 552, phase: "merged" }) }).map((p) => p.number)).toEqual([553, 552]);
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

  it("pr_mergeado is one of the codes", () => {
    expect(startErrorCode({ response: { status: 400, data: { error: "pr_mergeado: o PR #7 já foi mergeado" } } })).toBe("pr_mergeado");
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

function finding(overrides: Partial<Finding> = {}): Finding {
  return { id: "f1", severity: "blocking", title: "x", status: "open", introducedInRound: 1, ...overrides };
}

describe("findingCounts", () => {
  it("counts each severity from the data, whatever the status", () => {
    const list = [
      finding({ id: "a" }),
      finding({ id: "b", status: "fixed" }),
      finding({ id: "c", status: "contested" }),
      finding({ id: "d", severity: "suggestion" }),
      finding({ id: "e", severity: "refuted", status: "dropped" }),
      finding({ id: "f", severity: "question" }),
    ];
    expect(findingCounts(list)).toEqual({ blocking: 3, suggestion: 1, question: 1, refuted: 1 });
  });

  it("is all zeros for an empty list", () => {
    expect(findingCounts([])).toEqual({ blocking: 0, suggestion: 0, question: 0, refuted: 0 });
  });
});

describe("pendingQuestions", () => {
  it("is the questions nobody decided yet", () => {
    const list = [
      finding({ id: "q1", severity: "question" }),
      finding({ id: "q2", severity: "question", humanDecision: "drop", status: "dropped" }),
      finding({ id: "b1" }),
    ];
    expect(pendingQuestions(list).map((f) => f.id)).toEqual(["q1"]);
  });
});

describe("stuckItems", () => {
  it("is the blocking findings still open or contested", () => {
    const list = [
      finding({ id: "a", status: "open" }),
      finding({ id: "b", status: "contested" }),
      finding({ id: "c", status: "fixed" }),
      finding({ id: "d", status: "accepted_risk" }),
      finding({ id: "e", severity: "suggestion" }),
    ];
    expect(stuckItems(list).map((f) => f.id)).toEqual(["a", "b"]);
  });

  it("includes a question the human turned into a block, which weighs like one", () => {
    const list = [finding({ id: "q", severity: "question", humanDecision: "block" })];
    expect(stuckItems(list).map((f) => f.id)).toEqual(["q"]);
    expect(stuckItems([finding({ id: "q", severity: "question" })])).toEqual([]);
  });
});

function full(overrides: Partial<Review> = {}): Review {
  return {
    id: "r1", prNumber: 553, phase: "fixing", round: 2, cardId: "c1", projectId: "p1",
    prUrl: "https://github.com/acme/x/pull/553", prBranch: "card/x", base: "dev",
    reviewerUserId: "rev", authorUserId: "aut", mergerUserId: "mer", reviewerCardId: "rc1",
    findings: [], log: [], createdAt: 1, updatedAt: 2, ...overrides,
  };
}
const as = (id: string, isOwner = false) => ({ id, isOwner });

describe("reviewActions", () => {
  it("merge is the merger's alone, and only in ready — not even an owner", () => {
    const ready = full({ phase: "ready" });
    expect(reviewActions(ready, as("mer")).merge).toBe(true);
    expect(reviewActions(ready, as("rev")).merge).toBe(false);
    expect(reviewActions(ready, as("own", true)).merge).toBe(false);
    expect(reviewActions(full({ phase: "fixing" }), as("mer")).merge).toBe(false);
    expect(reviewActions(full({ phase: "merged" }), as("mer")).merge).toBe(false);
  });

  it("deciding is the reviewer's or an owner's, while the review is open to decisions", () => {
    expect(reviewActions(full(), as("rev")).decide).toBe(true);
    expect(reviewActions(full(), as("own", true)).decide).toBe(true);
    expect(reviewActions(full(), as("aut")).decide).toBe(false);
    expect(reviewActions(full(), as("mer")).decide).toBe(false);
    expect(reviewActions(full({ phase: "ready" }), as("rev")).decide).toBe(false);
    expect(reviewActions(full({ phase: "merged" }), as("rev")).decide).toBe(false);
  });

  it("trying again needs a failure impasse or a pending approve, and the reviewer, merger or an owner", () => {
    const failed = full({ phase: "impasse", impasseReason: "IA não respondeu" });
    expect(reviewActions(failed, as("rev")).retry).toBe(true);
    expect(reviewActions(failed, as("mer")).retry).toBe(true);
    expect(reviewActions(failed, as("own", true)).retry).toBe(true);
    expect(reviewActions(failed, as("aut")).retry).toBe(false);
    // An impasse with no reason at all is still a failure to try again (the server only refuses "rodadas" and the push).
    expect(reviewActions(full({ phase: "impasse" }), as("rev")).retry).toBe(true);
    expect(reviewActions(full({ phase: "impasse", impasseReason: "rodadas" }), as("rev")).retry).toBe(false);
    expect(reviewActions(full({ phase: "impasse", impasseReason: IMPASSE_HEAD_MOVED }), as("rev")).retry).toBe(false);
    expect(reviewActions(full({ phase: "ready", approvePending: true }), as("rev")).retry).toBe(true);
    expect(reviewActions(full({ phase: "ready" }), as("rev")).retry).toBe(false);
    expect(reviewActions(full({ phase: "fixing", approvePending: true }), as("rev")).retry).toBe(false);
  });

  it("cancelling is for the reviewer, author, merger or an owner, while the review is active", () => {
    for (const phase of ["reviewing", "fixing", "ready", "impasse"] as const) {
      expect(reviewActions(full({ phase }), as("aut")).cancel).toBe(true);
    }
    expect(reviewActions(full(), as("rev")).cancel).toBe(true);
    expect(reviewActions(full(), as("mer")).cancel).toBe(true);
    expect(reviewActions(full(), as("own", true)).cancel).toBe(true);
    expect(reviewActions(full(), as("co")).cancel).toBe(false);
    expect(reviewActions(full({ coauthorUserId: "co" }), as("co")).cancel).toBe(false);
    expect(reviewActions(full({ phase: "merged" }), as("aut")).cancel).toBe(false);
    expect(reviewActions(full({ phase: "cancelled" }), as("aut")).cancel).toBe(false);
  });

  it("nobody signed in can do anything", () => {
    expect(reviewActions(full({ phase: "ready" }), null)).toEqual({ decide: false, retry: false, cancel: false, merge: false });
  });
});

describe("mergeFailure", () => {
  const fail = (status: number | undefined, data?: unknown) =>
    Object.assign(new Error("x"), status === undefined ? {} : { response: { status, data } });

  it("head_moved is the 409 with that reason, carrying the review the server put back", () => {
    const back = full({ phase: "reviewing" });
    expect(mergeFailure(fail(409, { error: "o PR andou", reason: "head_moved", review: back }))).toEqual({
      kind: "head_moved", review: back,
    });
  });

  it("no answer at all (network) or a proxy giving up is a lost connection, not a refusal", () => {
    expect(mergeFailure(new Error("Network Error")).kind).toBe("lost");
    expect(mergeFailure(fail(502, "bad gateway")).kind).toBe("lost");
    expect(mergeFailure(fail(504, "")).kind).toBe("lost");
    expect(mergeFailure(fail(524, "")).kind).toBe("lost");
  });

  it("anything else the server answered is a refusal, with its reason and message", () => {
    expect(mergeFailure(fail(400, { error: "merger_sem_github: sem conexão", reason: "merger_sem_github" }))).toEqual({
      kind: "refused", reason: "merger_sem_github", message: "merger_sem_github: sem conexão", review: undefined,
    });
    const failed = mergeFailure(fail(409, { error: "gate vermelho", reason: "gate" }));
    expect(failed).toMatchObject({ kind: "refused", reason: "gate", message: "gate vermelho" });
    expect(mergeFailure(fail(500, { error: "boom" }))).toMatchObject({ kind: "refused", message: "boom" });
    expect(mergeFailure(fail(403, { error: "você não tem esse papel nesta revisão" }))).toMatchObject({ kind: "refused" });
  });
});
