import { afterEach, describe, expect, it, vi } from "vitest";
import {
  QUESTION_DRAFTS_MAX,
  QUESTION_DRAFT_TTL_MS,
  forgetQuestionDraftMemoryForTesting,
  pruneQuestionDrafts,
  readQuestionDraft,
  writeQuestionDraft,
} from "@/features/board/lib/questionDraftStore";

const KEY = "vibehub.questionDrafts";
const DRAFT = { picked: [["Faixa de capacidade"], []], other: ["pela", ""] };

afterEach(() => {
  forgetQuestionDraftMemoryForTesting();
  vi.restoreAllMocks();
});

describe("questionDraftStore", () => {
  it("o rascunho volta depois do F5 (a memória da aba some, o disco fica)", () => {
    writeQuestionDraft("c1", "q_1_1", DRAFT);
    forgetQuestionDraftMemoryForTesting();
    expect(readQuestionDraft("c1", "q_1_1")).toMatchObject(DRAFT);
  });

  it("o mesmo id de pergunta em dois cards são dois rascunhos", () => {
    writeQuestionDraft("c1", "q_1_1", DRAFT);
    writeQuestionDraft("c2", "q_1_1", { picked: [["Tipo no cadastro"], []], other: ["", ""] });
    forgetQuestionDraftMemoryForTesting();
    expect(readQuestionDraft("c1", "q_1_1")).toMatchObject(DRAFT);
    expect(readQuestionDraft("c2", "q_1_1")?.picked[0]).toEqual(["Tipo no cadastro"]);
  });

  it("desmarcou e apagou tudo: a entrada sai do disco", () => {
    writeQuestionDraft("c1", "q_1_1", DRAFT);
    writeQuestionDraft("c1", "q_1_1", { picked: [[], []], other: ["", "  "] });
    forgetQuestionDraftMemoryForTesting();
    expect(readQuestionDraft("c1", "q_1_1")).toBeUndefined();
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it("guarda QUANDO a pessoa mudou: regravar com o horário da mudança não rejuvenesce o rascunho", () => {
    writeQuestionDraft("c1", "q_1_1", { ...DRAFT, at: 1_000 }, 5_000);
    writeQuestionDraft("c1", "q_1_1", { ...DRAFT, at: 1_000 }, 9_000);
    forgetQuestionDraftMemoryForTesting();
    expect(readQuestionDraft("c1", "q_1_1")?.at).toBe(1_000);
    writeQuestionDraft("c1", "q_1_2", DRAFT, 7_000); // sem horário = agora
    expect(readQuestionDraft("c1", "q_1_2")?.at).toBe(7_000);
  });

  it("cartão nunca tocado não grava nada", () => {
    writeQuestionDraft("c1", "q_1_1", { picked: [[]], other: [""] });
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it("o velho sai na próxima gravação; o recente fica", () => {
    const now = 10 * QUESTION_DRAFT_TTL_MS;
    writeQuestionDraft("c1", "q_old", DRAFT, now - QUESTION_DRAFT_TTL_MS - 1);
    writeQuestionDraft("c1", "q_new", DRAFT, now);
    forgetQuestionDraftMemoryForTesting();
    expect(readQuestionDraft("c1", "q_old")).toBeUndefined();
    expect(readQuestionDraft("c1", "q_new")).toMatchObject(DRAFT);
  });

  it("acima do teto, os mais antigos saem primeiro", () => {
    for (let i = 0; i <= QUESTION_DRAFTS_MAX; i++) writeQuestionDraft("c1", `q_${i}`, DRAFT, 1_000 + i);
    forgetQuestionDraftMemoryForTesting();
    expect(readQuestionDraft("c1", "q_0")).toBeUndefined();
    expect(readQuestionDraft("c1", `q_${QUESTION_DRAFTS_MAX}`)).toMatchObject(DRAFT);
    expect(Object.keys(JSON.parse(localStorage.getItem(KEY)!))).toHaveLength(QUESTION_DRAFTS_MAX);
  });

  it("pruneQuestionDrafts — pura: sem o velho, sem o excesso, os recentes ficam", () => {
    const now = QUESTION_DRAFT_TTL_MS * 2;
    expect(pruneQuestionDrafts({ a: { at: now }, b: { at: now - QUESTION_DRAFT_TTL_MS - 1 }, c: { at: now - 5 } }, now))
      .toEqual({ a: { at: now }, c: { at: now - 5 } });
  });

  it("disco corrompido ou adulterado lê como sem rascunho, sem lançar", () => {
    localStorage.setItem(KEY, "{nope");
    expect(readQuestionDraft("c1", "q_1_1")).toBeUndefined();
    localStorage.setItem(KEY, JSON.stringify({
      "c1:q_1_1": { picked: "x", other: [], at: 1 },
      "c1:q_1_2": { picked: [[1]], other: [], at: 1 },
      "c1:q_1_3": { picked: [["ok"]], other: [""], at: 1 },
    }));
    expect(readQuestionDraft("c1", "q_1_1")).toBeUndefined();
    expect(readQuestionDraft("c1", "q_1_2")).toBeUndefined();
    expect(readQuestionDraft("c1", "q_1_3")).toEqual({ picked: [["ok"]], other: [""], at: 1 });
  });

  it("localStorage bloqueado: a memória da aba ainda segura o rascunho", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("QuotaExceededError"); });
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("SecurityError"); });
    expect(() => writeQuestionDraft("c1", "q_1_1", DRAFT)).not.toThrow();
    expect(readQuestionDraft("c1", "q_1_1")).toMatchObject(DRAFT);
  });
});
