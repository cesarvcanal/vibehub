import { describe, expect, it } from "vitest";
import {
  mergeGateStatus,
  IMPASSE_HEAD_MOVED,
  MERGE_CONFIRM_MS,
  REVIEW_MAX_ROUNDS,
  cardReviewKey,
  cardPeopleKey,
  conversationRows,
  autonomySummary,
  findingCounts,
  findingIsOpen,
  githubAuthor,
  mergeFailure,
  pendingQuestions,
  prStripCounts,
  requestedAtText,
  readsPerPr,
  reviewActions,
  reviewIsOpen,
  reviewPill,
  reviewTurn,
  startErrorCode,
  startErrorRoles,
  stuckItems,
  suggestedRoles,
  summaryForPr,
  visiblePrs,
} from "@/features/board/lib/review";
import type { CardPr, Finding, MergeGate, Person, Review, ReviewSummary } from "@/api/types";

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

  it("ready with the author's AI working reads 'IA trabalhando' in the orange of work; no other phase changes", () => {
    expect(reviewPill(review({ phase: "ready" }), { authorWorking: true })).toEqual({ key: "review.pill.authorWorking", tone: "warn" });
    expect(reviewPill(review({ phase: "ready" }), { authorWorking: false })).toMatchObject({ key: "review.pill.ready" });
    expect(reviewPill(review({ phase: "fixing", round: 2 }), { authorWorking: true })).toMatchObject({ key: "review.pill.round" });
    expect(reviewPill(review({ phase: "impasse" }), { authorWorking: true })).toMatchObject({ key: "review.pill.impasse" });
    expect(reviewPill(review({ phase: "merged" }), { authorWorking: true })).toMatchObject({ key: "review.pill.merged" });
  });

  it("caso real (PR #247): ready com o gate do merge vermelho ou rodando não diz 'pronto pra merge'", () => {
    expect(reviewPill(review({ phase: "ready" }), { gate: "failed" })).toEqual({ key: "review.pill.gateFailed", tone: "critical" });
    expect(reviewPill(review({ phase: "ready" }), { gate: "running" })).toEqual({ key: "review.pill.gateRunning", tone: "info" });
    expect(reviewPill(review({ phase: "ready" }), { gate: "passed" })).toMatchObject({ key: "review.pill.ready", tone: "ok" });
    // the author's AI working still comes first: its push changes the commit, and the gate with it
    expect(reviewPill(review({ phase: "ready" }), { authorWorking: true, gate: "failed" })).toMatchObject({ key: "review.pill.authorWorking" });
    expect(reviewPill(review({ phase: "fixing", round: 2 }), { gate: "failed" })).toMatchObject({ key: "review.pill.round" });
  });

  it("caso real (PR #218): gate vermelho que a IA do autor ainda corrige sozinha fica no laranja de trabalho, não no vermelho", () => {
    expect(reviewPill(review({ phase: "ready" }), { gate: "fixing" })).toEqual({ key: "review.pill.gateFixing", tone: "warn" });
  });

  it("mergeGateStatus: vermelho com volta sozinha é fixing; esgotado ou da época de uma volta só é failed", () => {
    const sha = "a".repeat(40);
    const at = (mergeGate: MergeGate) => mergeGateStatus({ reviewedSha: sha, mergeGate });
    expect(at({ sha, state: "failed", at: 1, failures: 1 })).toBe("fixing");
    expect(at({ sha, state: "failed", at: 1 })).toBe("fixing");
    expect(at({ sha, state: "failed", at: 1, failures: 4, exhausted: true })).toBe("failed");
    expect(at({ sha, state: "failed", at: 1, autoRetried: true })).toBe("failed");
    expect(at({ sha, state: "running", at: 1, failures: 2 })).toBe("running");
    expect(at({ sha, state: "passed", at: 1 })).toBeUndefined();
    expect(mergeGateStatus({ reviewedSha: "b".repeat(40), mergeGate: { sha, state: "failed", at: 1 } })).toBeUndefined();
  });

  it("reviewIsOpen: every phase but merged and cancelled (and no review at all)", () => {
    for (const phase of ["reviewing", "fixing", "ready", "impasse"] as const) expect(reviewIsOpen(phase)).toBe(true);
    for (const phase of ["merged", "cancelled", undefined] as const) expect(reviewIsOpen(phase)).toBe(false);
  });

  it("a cancelled review is no review — the server omits it, a stale cache must not show it", () => {
    expect(reviewPill(review({ phase: "cancelled" }))).toEqual({ key: "review.pill.none", tone: "muted" });
  });

  it("reviewing with a doubt nobody decided reads 'aguardando decisão', in the blue of 'needs a person'", () => {
    const waiting = { key: "review.pill.decision", tone: "info" };
    // The card's summary carries the count; the panel's whole review counts from its findings.
    expect(reviewPill(review({ phase: "reviewing", pendingQuestions: 1 }))).toEqual(waiting);
    expect(reviewPill(full({ phase: "reviewing", round: 1, findings: [finding({ severity: "question" })] }))).toEqual(waiting);
    // A doubt already decided waits for nobody.
    expect(reviewPill(full({ phase: "reviewing", round: 1, findings: [finding({ severity: "question", humanDecision: "drop" })] })))
      .toMatchObject({ key: "review.pill.round" });
    expect(reviewPill(review({ phase: "reviewing", pendingQuestions: 0 }))).toMatchObject({ key: "review.pill.round" });
    // While the author fixes the rest, the AIs are working: the round still reads.
    expect(reviewPill(review({ phase: "fixing", pendingQuestions: 2 }))).toMatchObject({ key: "review.pill.round", tone: "warn" });
  });
});

describe("vários PRs por card", () => {
  const attached = (n: number): CardPr => ({ ...pr(n, n), attached: true, author: "albert-gh" });

  it("visiblePrs tira cada PR que a revisão DELE diz mergeado, não só o da mais recente", () => {
    const list = visiblePrs({
      prs: [attached(1), attached(2), attached(3)],
      review: review({ prNumber: 3, phase: "fixing" }),
      reviews: [review({ prNumber: 3, phase: "fixing" }), review({ prNumber: 1, phase: "merged" })],
    });
    expect(list.map((p) => p.number)).toEqual([3, 2]);
  });

  it("lê uma revisão por PR quando o card anexou PRs ou tem mais de um revisado; senão, a do card", () => {
    expect(readsPerPr({ prs: [pr(1, 1)] })).toBe(false);
    expect(readsPerPr({ prs: [pr(1, 1), pr(2, 2, "prod")], reviews: undefined })).toBe(false);
    expect(readsPerPr({ prs: [pr(1, 1)], reviews: [review({ prNumber: 1 }), review({ prNumber: 2 })] })).toBe(true);
    expect(readsPerPr({ prs: [attached(5)] })).toBe(true);
  });

  it("summaryForPr acha a revisão do PR na lista, ou na mais recente quando a lista não veio", () => {
    const card = { review: review({ id: "b", prNumber: 2 }), reviews: [review({ id: "b", prNumber: 2 }), review({ id: "a", prNumber: 1 })] };
    expect(summaryForPr(card, 1)?.id).toBe("a");
    expect(summaryForPr(card, 3)).toBeUndefined();
    expect(summaryForPr({ review: review({ id: "only", prNumber: 7 }) }, 7)?.id).toBe("only");
  });

  it("o cabeçalho conta cada PR onde ele está, na ordem fixa, só o que não é zero", () => {
    expect(prStripCounts([
      review({ phase: "ready" }),
      review({ phase: "fixing" }),
      review({ phase: "fixing" }),
      review({ phase: "reviewing", pendingQuestions: 1 }),
      review({ phase: "impasse" }),
      undefined,
      review({ phase: "cancelled" }),
    ])).toEqual([
      { kind: "ready", n: 1 }, { kind: "fixing", n: 2 }, { kind: "decision", n: 2 }, { kind: "none", n: 2 },
    ]);
    expect(prStripCounts([review({ phase: "reviewing" })])).toEqual([{ kind: "reviewing", n: 1 }]);
  });

  it("a chave da revisão de um PR fica debaixo da do card (invalidar o card renova todas)", () => {
    expect(cardReviewKey("c1", 5).slice(0, 2)).toEqual([...cardReviewKey("c1")]);
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
    // no open PR left over: nothing to show
    expect(visiblePrs({ prs: [merged] })).toEqual([]);
  });

  it("o PR da revisão mergeada também sai: mergeado é trabalho feito, não fica na tela", () => {
    const current = { ...pr(12, 300, "prod"), mergedAt: 999 };
    expect(visiblePrs({ prs: [pr(10, 100), current], review: review({ prNumber: 12, phase: "merged" }) }).map((p) => p.number)).toEqual([10]);
    expect(visiblePrs({ prs: [current], review: review({ prNumber: 12, phase: "merged" }) })).toEqual([]);
    // a review in progress does not bring an already merged PR back to the list
    expect(visiblePrs({ prs: [current], review: review({ prNumber: 12, phase: "fixing" }) })).toEqual([]);
  });

  it("a revisão mergeada tira o PR dela mesmo sem a marca mergedAt (dado antigo, ou o board ainda não leu)", () => {
    const prs = [pr(552, 100), pr(553, 200, "prod")];
    expect(visiblePrs({ prs, review: review({ prNumber: 552, phase: "merged" }) }).map((p) => p.number)).toEqual([553]);
    // only that review's PR: the others, open, stay
    expect(visiblePrs({ prs, review: review({ prNumber: 553, phase: "fixing" }) }).map((p) => p.number)).toEqual([553, 552]);
    // a cancelled review says nothing about the PR: it is still open
    expect(visiblePrs({ prs, review: review({ prNumber: 552, phase: "cancelled" }) }).map((p) => p.number)).toEqual([553, 552]);
  });

  it("does not mutate the card's own list", () => {
    const prs = [pr(1, 1), pr(2, 2)];
    visiblePrs({ prs });
    expect(prs.map((p) => p.number)).toEqual([1, 2]);
  });
});

describe("startErrorCode", () => {
  it("reconhece a recusa da ordem de merge dada por quem não mergeia", () => {
    expect(startErrorCode({ response: { status: 400, data: { error: "merge_autorizado_de_outro: só quem mergeia" } } }))
      .toBe("merge_autorizado_de_outro");
  });

  it("reads the code the server puts before the colon", () => {
    expect(startErrorCode({ response: { status: 400, data: { error: "revisor_sem_conta: o revisor não tem uma conta" } } }))
      .toBe("revisor_sem_conta");
    expect(startErrorCode({ response: { status: 400, data: { error: "papel_sem_work: authorUserId só tem leitura" } } }))
      .toBe("papel_sem_work");
  });

  it("revisor_sem_github is one of the codes (the reviews would go out on somebody else's account)", () => {
    expect(startErrorCode({ response: { status: 400, data: { error: "revisor_sem_github: o revisor não tem uma conexão GitHub própria" } } }))
      .toBe("revisor_sem_github");
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
    expect(findingCounts([...list, finding({ id: "g", severity: "improvement" })]))
      .toEqual({ blocking: 3, improvement: 1, suggestion: 1, question: 1, refuted: 1 });
  });

  it("is all zeros for an empty list", () => {
    expect(findingCounts([])).toEqual({ blocking: 0, improvement: 0, suggestion: 0, question: 0, refuted: 0 });
  });
});

describe("autonomySummary", () => {
  it("separates what the AI fixed, what it improved and what waits on a person", () => {
    const list = [
      finding({ id: "a", status: "fixed" }),
      finding({ id: "b", status: "fixed" }),
      // a person made this one block: fixed, but not on the AI's own call
      finding({ id: "c", severity: "question", humanDecision: "block", status: "fixed" }),
      finding({ id: "d", severity: "improvement", status: "fixed" }),
      finding({ id: "e", severity: "improvement", status: "wontfix" }),
      finding({ id: "f", severity: "question" }),
      finding({ id: "g", severity: "question", humanDecision: "drop", status: "dropped" }),
      finding({ id: "h" }),
    ];
    expect(autonomySummary(list)).toEqual({ fixed: 2, improved: 1, human: 1 });
  });

  it("is all zeros for an empty list", () => {
    expect(autonomySummary([])).toEqual({ fixed: 0, improved: 0, human: 0 });
  });
});

describe("findingIsOpen", () => {
  it("is what still stands: open or contested", () => {
    expect(findingIsOpen(finding({ status: "open" }))).toBe(true);
    expect(findingIsOpen(finding({ status: "contested" }))).toBe(true);
    expect(findingIsOpen(finding({ status: "fixed" }))).toBe(false);
  });

  it("never a refuted finding: the reviewer already knocked it down, whatever status it was saved with", () => {
    expect(findingIsOpen(finding({ severity: "refuted", status: "open" }))).toBe(false);
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
  it("merge is anyone with a role in the review (merger, reviewer, author, co-author), only in ready — not an owner without one", () => {
    const ready = full({ phase: "ready", coauthorUserId: "coa" });
    for (const id of ["mer", "rev", "aut", "coa"]) expect({ id, merge: reviewActions(ready, as(id)).merge }).toEqual({ id, merge: true });
    expect(reviewActions(ready, as("own", true)).merge).toBe(false);
    expect(reviewActions(ready, as("someone")).merge).toBe(false);
    expect(reviewActions(full({ phase: "fixing" }), as("mer")).merge).toBe(false);
    expect(reviewActions(full({ phase: "merged" }), as("mer")).merge).toBe(false);
  });

  it("gate do merge vermelho no commit aprovado: retry aparece (roda os testes de novo); num commit antigo, não", () => {
    const failed = { sha: "a".repeat(40), state: "failed" as const, output: "FAIL x", at: 1 };
    expect(reviewActions(full({ phase: "ready", reviewedSha: "a".repeat(40), mergeGate: failed }), as("mer")).retry).toBe(true);
    expect(reviewActions(full({ phase: "ready", reviewedSha: "b".repeat(40), mergeGate: failed }), as("mer")).retry).toBe(false);
    expect(reviewActions(full({ phase: "ready", reviewedSha: "a".repeat(40), mergeGate: { ...failed, state: "passed" } }), as("mer")).retry).toBe(false);
  });

  it("the co-author carries the work on: retry, cancel and request like the author and the merger", () => {
    const open = full({ phase: "fixing", coauthorUserId: "coa" });
    expect(reviewActions(open, as("coa"))).toMatchObject({ retry: true, cancel: true, request: true, decide: false });
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
  });

  it("trying again also hands a stalled turn back: the reviewer's round not in yet, or the author fixing", () => {
    expect(reviewActions(full({ phase: "fixing" }), as("mer")).retry).toBe(true);
    expect(reviewActions(full({ phase: "reviewing", round: 1 }), as("rev")).retry).toBe(true);
    expect(reviewActions(full({ phase: "reviewing", round: 2, lastSubmitRound: 1 }), as("own", true)).retry).toBe(true);
    // The reviewer's round is in and only doubts are left: the turn is the human's (the server answers nada_a_tentar).
    expect(reviewActions(full({ phase: "reviewing", round: 2, lastSubmitRound: 2 }), as("rev")).retry).toBe(false);
    expect(reviewActions(full({ phase: "fixing" }), as("aut")).retry).toBe(false);
  });

  it("cancelling is for the reviewer, author, co-author, merger or an owner, while the review is active", () => {
    for (const phase of ["reviewing", "fixing", "ready", "impasse"] as const) {
      expect(reviewActions(full({ phase }), as("aut")).cancel).toBe(true);
    }
    expect(reviewActions(full(), as("rev")).cancel).toBe(true);
    expect(reviewActions(full(), as("mer")).cancel).toBe(true);
    expect(reviewActions(full(), as("own", true)).cancel).toBe(true);
    expect(reviewActions(full(), as("co")).cancel).toBe(false);
    // the co-author carries on without the owner (production, 2026-11-09)
    expect(reviewActions(full({ coauthorUserId: "co" }), as("co")).cancel).toBe(true);
    expect(reviewActions(full({ phase: "merged" }), as("aut")).cancel).toBe(false);
    expect(reviewActions(full({ phase: "cancelled" }), as("aut")).cancel).toBe(false);
  });

  it("nobody signed in can do anything", () => {
    expect(reviewActions(full({ phase: "ready" }), null)).toEqual({ decide: false, retry: false, cancel: false, merge: false, request: false });
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

  it("409 merging is a merge still running: not a refusal, the result is yet to be confirmed", () => {
    expect(mergeFailure(fail(409, { error: "merge já em andamento", reason: "merging" }))).toEqual({ kind: "running" });
  });

  it("the unconfirmed wait is capped at the server's own merge limit (~15 min) plus a margin", () => {
    expect(MERGE_CONFIRM_MS).toBe(16 * 60_000);
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

describe("reviewTurn", () => {
  const idle = { author: false, reviewer: false };
  const base = { round: 1, findings: [] as Finding[] };

  it("reviewing before the reviewer's round: the reviewer's turn, working or still to start", () => {
    expect(reviewTurn({ ...base, phase: "reviewing" }, idle)).toEqual({ who: "reviewer", working: false });
    expect(reviewTurn({ ...base, phase: "reviewing", round: 2, lastSubmitRound: 1 }, { author: false, reviewer: true }))
      .toEqual({ who: "reviewer", working: true });
  });

  it("reviewing after the reviewer's round: only the doubts are left, and they are a person's", () => {
    expect(reviewTurn({ ...base, phase: "reviewing", lastSubmitRound: 1 }, idle)).toEqual({ who: "person", why: "decision" });
  });

  it("fixing is the author's turn; a ready PR is the author's only while its AI works on it", () => {
    expect(reviewTurn({ ...base, phase: "fixing" }, { author: true, reviewer: false }))
      .toEqual({ who: "author", working: true, onReadyPr: false });
    expect(reviewTurn({ ...base, phase: "ready" }, { author: true, reviewer: false }))
      .toEqual({ who: "author", working: true, onReadyPr: true });
    expect(reviewTurn({ ...base, phase: "ready" }, idle)).toEqual({ who: "person", why: "merge" });
  });

  it("impasse waits for a person; merged and cancelled for nobody", () => {
    expect(reviewTurn({ ...base, phase: "impasse" }, idle)).toEqual({ who: "person", why: "impasse" });
    expect(reviewTurn({ ...base, phase: "merged" }, idle)).toEqual({ who: "nobody" });
    expect(reviewTurn({ ...base, phase: "cancelled" }, idle)).toEqual({ who: "nobody" });
  });
});

describe("conversationRows", () => {
  it("a divider before the first line of each round, then the lines in order", () => {
    const log = [
      { at: 1, round: 1, who: "system" as const, text: "início" },
      { at: 2, round: 1, who: "reviewer" as const, text: "r1" },
      { at: 3, round: 2, who: "author" as const, text: "a1" },
      { at: 4, round: 2, who: "reviewer" as const, text: "r2" },
    ];
    expect(conversationRows(log).map((r) => (r.kind === "round" ? `#${r.round}` : r.event.text)))
      .toEqual(["#1", "início", "r1", "#2", "a1", "r2"]);
  });

  it("an AI line with findings becomes its summary, then its findings as one group of messages, in order", () => {
    const log = [
      { at: 1, round: 1, who: "reviewer" as const, text: "achei duas coisas", items: [{ id: "f1", status: "open" as const, isNew: true }, { id: "f2", status: "open" as const, isNew: true }] },
      { at: 2, round: 1, who: "author" as const, text: "corrigi", items: [{ id: "f1", status: "fixed" as const, reply: "feito", commit: "abc1234" }] },
    ];
    const rows = conversationRows(log);
    expect(rows.map((r) => (r.kind === "round" ? `#${r.round}` : r.kind === "items" ? `${r.event.who}:${r.event.items!.map((it) => it.id).join(",")}` : r.event.text)))
      .toEqual(["#1", "achei duas coisas", "reviewer:f1,f2", "corrigi", "author:f1"]);
    // The summary and its findings are the same line: same index, so they animate (or not) together.
    expect(rows.filter((r) => r.kind !== "round").map((r) => r.index)).toEqual([0, 0, 1, 1]);
    const keys = rows.map((r) => r.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("system and human lines are not split: no findings group follows them", () => {
    const log = [{ at: 1, round: 1, who: "human" as const, by: "albert", text: "Decisão humana em f6: retira.", items: [{ id: "f6", status: "dropped" as const }] }];
    const rows = conversationRows(log);
    expect(rows.map((r) => r.kind)).toEqual(["round", "line"]);
  });

  it("an empty log has no rows, and every key is unique", () => {
    expect(conversationRows([])).toEqual([]);
    const same = [{ at: 5, round: 1, who: "system" as const, text: "x" }, { at: 5, round: 1, who: "system" as const, text: "x" }];
    const keys = conversationRows(same).map((r) => r.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("requestedAtText", () => {
  it("dá a hora de São Paulo, qualquer que seja o fuso do navegador", () => {
    expect(requestedAtText(Date.UTC(2026, 10, 9, 22, 40))).toBe("09/11/2026 19:40");
    expect(requestedAtText(Date.UTC(2026, 10, 10, 2, 5))).toBe("09/11/2026 23:05");
  });
});

describe("githubAuthor", () => {
  const people: Person[] = [
    { id: "u1", username: "ana", canReview: true, githubLogin: "Ana-GH" },
    { id: "u2", username: "bia", canReview: false, githubLogin: "bia-gh" },
  ];

  it("finds the person whose own GitHub login opened the PR, ignoring case", () => {
    expect(githubAuthor(people, "ana-gh")?.id).toBe("u1");
  });

  it("skips somebody without a Claude account for the fixes", () => {
    expect(githubAuthor(people, "bia-gh")).toBeUndefined();
  });

  it("no login, or nobody with it, is nobody", () => {
    expect(githubAuthor(people, undefined)).toBeUndefined();
    expect(githubAuthor(people, "outro")).toBeUndefined();
  });
});

describe("suggestedRoles", () => {
  const me: Person = { id: "me", username: "eu", canReview: true };
  const actor: Person = { id: "actor", username: "ator", canReview: true, githubLogin: "ator-gh" };
  const delivered = pr(7, 1);

  it("I review and merge, the card's actor fixes", () => {
    expect(suggestedRoles([me, actor], "me", "actor", delivered)).toEqual({
      reviewer: "me", author: "actor", coauthor: "", merger: "me",
    });
  });

  it("an actor who is not among the card's people is not suggested", () => {
    expect(suggestedRoles([me], "me", "actor", delivered).author).toBe("");
  });

  it("I am not the reviewer when I am the author or cannot review", () => {
    expect(suggestedRoles([me], "me", "me", delivered).reviewer).toBe("");
    expect(suggestedRoles([{ ...me, canReview: false }], "me", undefined, delivered)).toEqual({
      reviewer: "", author: "", coauthor: "", merger: "me",
    });
  });

  it("an attached PR suggests its GitHub author, not the card's actor", () => {
    const attached: CardPr = { ...delivered, attached: true, author: "ATOR-GH" };
    expect(suggestedRoles([me, actor], "me", "me", attached).author).toBe("actor");
    expect(suggestedRoles([me, actor], "me", "actor", { ...attached, author: "ninguem" }).author).toBe("");
  });

  it("nobody signed in among the people: no reviewer, no merger", () => {
    expect(suggestedRoles([actor], undefined, "actor", delivered)).toEqual({
      reviewer: "", author: "actor", coauthor: "", merger: "",
    });
  });
});
