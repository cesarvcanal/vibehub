import { afterEach, describe, it, expect, vi } from "vitest";
import {
  DRAFT_SEND_EVERY_MS,
  applyPeerQuestionDraft,
  createDraftSender,
  isEmptyDraft,
  peerDraftsOf,
  readPeerQuestionDraft,
  type QuestionDraft,
} from "./peerQuestionDraft";

/**
 * Duas pessoas no mesmo card, uma pergunta: cada uma vê em tempo real o que a outra marca e escreve
 * no cartão, para não mandarem duas respostas diferentes (só a primeira vale).
 */

const d = (other: string, picked: string[] = []): QuestionDraft => ({ picked: [picked], other: [other] });

describe("applyPeerQuestionDraft / peerDraftsOf — o que os outros estão respondendo", () => {
  it("guarda o rascunho por pergunta e por pessoa, e solta quando a pessoa apaga tudo", () => {
    let drafts = applyPeerQuestionDraft({}, "q1", "albert", d("abre o pr"));
    expect(peerDraftsOf(drafts.q1, "cesar")).toEqual([{ name: "albert", draft: d("abre o pr") }]);
    drafts = applyPeerQuestionDraft(drafts, "q1", "albert", d(""));
    expect(drafts).toEqual({});
  });

  it("só a pergunta tocada muda de objeto (o memo das outras linhas segura)", () => {
    const before = applyPeerQuestionDraft(applyPeerQuestionDraft({}, "q1", "albert", d("a")), "q2", "albert", d("b"));
    const after = applyPeerQuestionDraft(before, "q1", "albert", d("ab"));
    expect(after.q2).toBe(before.q2);
    expect(after.q1).not.toBe(before.q1);
  });

  it("apagar o que não existia não cria estado novo", () => {
    const drafts = applyPeerQuestionDraft({}, "q1", "albert", d("a"));
    expect(applyPeerQuestionDraft(drafts, "q1", "mussa", d(""))).toBe(drafts);
    expect(applyPeerQuestionDraft(drafts, "q9", "albert", d(""))).toBe(drafts);
  });

  it("duas pessoas na mesma pergunta: em ordem, sem o próprio leitor", () => {
    let drafts = applyPeerQuestionDraft({}, "q1", "mussa", d("x"));
    drafts = applyPeerQuestionDraft(drafts, "q1", "albert", d("y"));
    drafts = applyPeerQuestionDraft(drafts, "q1", "cesar", d("z"));
    expect(peerDraftsOf(drafts.q1, "cesar").map((p) => p.name)).toEqual(["albert", "mussa"]);
    expect(peerDraftsOf(undefined, "cesar")).toEqual([]);
  });

  it("vazio = nada marcado e nada escrito", () => {
    expect(isEmptyDraft({ picked: [[], []], other: [" ", ""] })).toBe(true);
    expect(isEmptyDraft(d("", ["A"]))).toBe(false);
  });
});

describe("readPeerQuestionDraft — o frame conferido", () => {
  it("lê o frame e descarta o que não é texto", () => {
    expect(readPeerQuestionDraft({ id: "q1", name: "albert", picked: [["A", 3]], other: ["oi", null] })).toEqual({
      id: "q1", name: "albert", draft: { picked: [["A"]], other: ["oi"] },
    });
  });

  it("sem id ou sem nome não é nada", () => {
    expect(readPeerQuestionDraft({ id: "", name: "albert" })).toBeNull();
    expect(readPeerQuestionDraft({ id: "q1" })).toBeNull();
  });
});

describe("createDraftSender — tempo real sem um frame por tecla", () => {
  afterEach(() => { vi.useRealTimers(); });

  it("o primeiro sai na hora; os do meio se juntam e o ÚLTIMO estado sempre chega", () => {
    vi.useFakeTimers();
    const sent: Array<[string, string]> = [];
    const sender = createDraftSender((id, draft) => sent.push([id, draft.other[0]!]));
    sender.push("q1", d("a"));
    sender.push("q1", d("ab"));
    sender.push("q1", d("abc"));
    expect(sent).toEqual([["q1", "a"]]);
    vi.advanceTimersByTime(DRAFT_SEND_EVERY_MS);
    expect(sent).toEqual([["q1", "a"], ["q1", "abc"]]);
    vi.advanceTimersByTime(DRAFT_SEND_EVERY_MS * 3);
    expect(sent.length).toBe(2);
  });

  it("perguntas diferentes não esperam uma pela outra", () => {
    vi.useFakeTimers();
    const sent: string[] = [];
    const sender = createDraftSender((id) => sent.push(id));
    sender.push("q1", d("a"));
    sender.push("q2", d("b"));
    expect(sent).toEqual(["q1", "q2"]);
  });

  it("socket fechado não quebra o cartão; dispose descarta o pendente", () => {
    vi.useFakeTimers();
    const send = vi.fn(() => { throw new Error("offline"); });
    const sender = createDraftSender(send);
    expect(() => sender.push("q1", d("a"))).not.toThrow();
    sender.push("q1", d("ab"));
    sender.dispose();
    vi.advanceTimersByTime(DRAFT_SEND_EVERY_MS * 2);
    expect(send).toHaveBeenCalledTimes(1);
  });
});
