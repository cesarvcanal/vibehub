import { describe, expect, it } from "vitest";
import {
  buildDecisionReply,
  decisionKey,
  decisionReplies,
  parseDecisionReply,
  pendingDecisions,
  proseQuestion,
  splitProseQuestion,
} from "./pendingDecisions";
import type { SdkRow } from "./sdkChat";

/* ------------------------------------------------------------ heuristic */

describe("proseQuestion — perguntas dirigidas ao usuário (conservadora)", () => {
  it("catches a final directed question", () => {
    expect(proseQuestion("Analisei as duas rotas.\n\nQual das duas você prefere?")).toBe(
      "Qual das duas você prefere?",
    );
    expect(proseQuestion("Posso seguir com a opção A?")).toBe("Posso seguir com a opção A?");
    expect(proseQuestion("Fiz o levantamento.\n\nMe confirma o CNPJ da filial 5?")).toBe(
      "Me confirma o CNPJ da filial 5?",
    );
    expect(proseQuestion("Two builds exist.\n\nWhich one do you prefer?")).toBe("Which one do you prefer?");
  });

  it("catches an explicit decision request even without a question mark", () => {
    expect(proseQuestion("Segue o plano.\n\nDecisão sua: A (rápida) ou B (completa).")).toBe(
      "Decisão sua: A (rápida) ou B (completa).",
    );
    expect(proseQuestion("Preciso que você aprove o merge antes de eu seguir.")).toMatch(/^Preciso que você/);
  });

  it("tolerates markdown noise after the question mark", () => {
    expect(proseQuestion("Pronto.\n\n**Qual opção você quer?**")).toBe("**Qual opção você quer?**");
  });

  it("stays QUIET on rhetorical or undirected questions", () => {
    expect(proseQuestion("Faz sentido?")).toBeNull(); // no directed word
    expect(proseQuestion("O que será que acontece aqui? Vamos descobrir.")).toBeNull(); // does not end in ?
    expect(proseQuestion("Rodei os testes e está tudo verde.")).toBeNull();
    expect(proseQuestion("")).toBeNull();
  });

  it("only the FINAL paragraph counts — a question the text itself answers is not pending", () => {
    expect(proseQuestion("Qual você prefere?\n\nFui de A: é a mais simples e já está pronta.")).toBeNull();
  });

  it("never matches quoted or code paragraphs", () => {
    expect(proseQuestion("Contexto.\n\n> Qual você prefere?")).toBeNull();
    expect(proseQuestion("Contexto.\n\n```\nQual você prefere?\n```")).toBeNull();
  });
});

describe("splitProseQuestion", () => {
  it("splits body and question for the highlighted render", () => {
    expect(splitProseQuestion("Fiz A e B.\n\nQual dos dois você prefere?")).toEqual({
      body: "Fiz A e B.",
      question: "Qual dos dois você prefere?",
    });
  });
  it("a message that IS the question has an empty body", () => {
    expect(splitProseQuestion("Posso seguir com a opção A?")).toEqual({
      body: "",
      question: "Posso seguir com a opção A?",
    });
  });
  it("null when there is nothing to highlight", () => {
    expect(splitProseQuestion("Tudo verde.")).toBeNull();
  });
});

/* ---------------------------------------------------------------- tray */

const QUESTIONS = [{ question: "Formato do relatório?", options: [{ label: "Resumo" }] }];

function assistant(id: string, text: string, streaming = false): SdkRow {
  return { kind: "assistant", id, text, streaming };
}
function user(id: string, text: string): SdkRow {
  return { kind: "user", id, text, state: "sent" };
}

describe("pendingDecisions — a bandeja", () => {
  it("lists a pending user_question and drops it once answered", () => {
    const pendingRow: SdkRow = { kind: "question", id: "q_1", questions: QUESTIONS, outcome: "pending" };
    expect(pendingDecisions([pendingRow])).toEqual([
      {
        kind: "question",
        rowId: "q_1",
        text: "Formato do relatório?",
        summary: "Formato do relatório?",
        answerable: true,
      },
    ]);
    expect(pendingDecisions([{ ...pendingRow, outcome: "answered" }])).toEqual([]);
    expect(pendingDecisions([{ ...pendingRow, outcome: "unanswered" }])).toEqual([]);
  });

  it("a structured question stays pending even after later user messages", () => {
    const rows: SdkRow[] = [
      { kind: "question", id: "q_1", questions: QUESTIONS, outcome: "pending" },
      user("u1", "vou olhar outra coisa antes"),
    ];
    expect(pendingDecisions(rows)).toHaveLength(1);
  });

  it("lists a prose question and clears it when ANY user message follows", () => {
    const rows: SdkRow[] = [
      user("u1", "planeja a tela"),
      assistant("a1", "Plano feito.\n\nQual layout você prefere?"),
    ];
    expect(pendingDecisions(rows)).toEqual([
      {
        kind: "prose",
        rowId: "a1",
        text: "Qual layout você prefere?",
        summary: "Qual layout você prefere?",
        answerable: true,
      },
    ]);
    expect(pendingDecisions([...rows, user("u2", "o segundo")])).toEqual([]);
  });

  it("ignores a still-streaming assistant row", () => {
    expect(pendingDecisions([assistant("a1", "Qual você prefere?", true)])).toEqual([]);
  });

  it("keeps chronological order and mixes both kinds", () => {
    const rows: SdkRow[] = [
      assistant("a1", "Contexto.\n\nQual banco você quer usar?"),
      { kind: "question", id: "q_1", questions: QUESTIONS, outcome: "pending" },
    ];
    expect(pendingDecisions(rows).map((d) => d.rowId)).toEqual(["a1", "q_1"]);
  });

  it("truncates a long summary", () => {
    const long = `Contexto.\n\n${"muito texto ".repeat(20)}qual você prefere?`;
    const [d] = pendingDecisions([assistant("a1", long)]);
    expect(d!.summary.length).toBeLessThanOrEqual(100);
    expect(d!.summary.endsWith("…")).toBe(true);
  });

  it("a multi-question card is NOT answerable by a typed line (its own fields are)", () => {
    const rows: SdkRow[] = [
      {
        kind: "question",
        id: "q_1",
        questions: [
          { question: "Formato?", options: [{ label: "Resumo" }] },
          { question: "Idioma?", options: [{ label: "pt-BR" }] },
        ],
        outcome: "pending",
      },
    ];
    expect(pendingDecisions(rows)[0]!.answerable).toBe(false);
  });

  it("STALE: the agent spoke again, so the older prose question stops being pending", () => {
    const rows: SdkRow[] = [
      assistant("a1", "Plano feito.\n\nQual layout você prefere?"),
      assistant("a2", "Enquanto isso adiantei o CSS."),
    ];
    expect(pendingDecisions(rows)).toEqual([]);

    // and when the NEWEST message is itself a question, that one is the pending decision
    const asksAgain: SdkRow[] = [...rows, assistant("a3", "Agora sim: qual você prefere?")];
    expect(pendingDecisions(asksAgain).map((d) => d.rowId)).toEqual(["a3"]);
  });

  it("a structured question survives the agent speaking again (it has a real channel)", () => {
    const rows: SdkRow[] = [
      { kind: "question", id: "q_1", questions: QUESTIONS, outcome: "pending" },
      assistant("a1", "Fui adiantando o resto."),
    ];
    expect(pendingDecisions(rows).map((d) => d.rowId)).toEqual(["q_1"]);
  });
});

/* -------------------------------------------------------- resposta explícita */

describe("buildDecisionReply / parseDecisionReply — a resposta ancorada", () => {
  it("round-trips the question and the answer", () => {
    const wrapped = buildDecisionReply("Qual layout você prefere?", "o segundo");
    expect(wrapped).toContain("Qual layout você prefere?");
    expect(wrapped).toContain("o segundo");
    expect(parseDecisionReply(wrapped)).toEqual({ question: "Qual layout você prefere?", answer: "o segundo" });
  });

  it("flattens a multi-line question so the anchor still matches", () => {
    const wrapped = buildDecisionReply("Qual layout\n  você prefere?", "o segundo");
    expect(parseDecisionReply(wrapped)!.question).toBe("Qual layout você prefere?");
  });

  it("keeps line breaks inside the answer", () => {
    const wrapped = buildDecisionReply("Qual?", "primeiro isso\ndepois aquilo");
    expect(parseDecisionReply(wrapped)!.answer).toBe("primeiro isso\ndepois aquilo");
  });

  it("a plain message is NOT a reply", () => {
    expect(parseDecisionReply("o segundo")).toBeNull();
    expect(parseDecisionReply("[resposta à decisão pendente: sem o resto")).toBeNull();
  });

  it("decisionReplies anchors each answer to the ROW it answered", () => {
    const rows: SdkRow[] = [
      assistant("a1", "Fiz A e B.\n\nQual dos dois você prefere?"),
      user("u1", buildDecisionReply("Qual dos dois você prefere?", "o B")),
      user("u2", "e roda os testes depois"),
    ];
    expect(decisionReplies(rows)).toEqual(new Map([["a1", "o B"]]));
  });

  it("the SAME question asked twice keeps each answer under its own message", () => {
    const rows: SdkRow[] = [
      assistant("a1", "Qual dos dois você prefere?"),
      user("u1", buildDecisionReply("Qual dos dois você prefere?", "o B")),
      assistant("a2", "Qual dos dois você prefere?"),
      user("u2", buildDecisionReply("Qual dos dois você prefere?", "agora o A")),
    ];
    expect(decisionReplies(rows)).toEqual(new Map([["a1", "o B"], ["a2", "agora o A"]]));
  });

  it("decisionKey ignores case and spacing (the wrapper flattens the question)", () => {
    expect(decisionKey("  QUAL dos dois   você prefere? ")).toBe(decisionKey("Qual dos dois você prefere?"));
  });
});
