import { describe, expect, it, vi } from "vitest";
import {
  buildDecisionReply,
  decisionKey,
  decisionReplies,
  parseDecisionReply,
  pendingDecisions,
  proseOptions,
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

describe("proseQuestion — pergunta que fecha com uma lista de opções", () => {
  it.each([
    ["lista colada na pergunta", "Resumo.\n\nQual caminho você prefere?\n1. A\n2. B", "Qual caminho você prefere?\n1. A\n2. B"],
    ["lista num parágrafo próprio", "Resumo.\n\nQual caminho você prefere?\n\n1. A\n2. B", "Qual caminho você prefere?\n\n1. A\n2. B"],
    ["pedido de decisão com lista", "Resumo.\n\nDecisão sua:\n\n- A\n- B", "Decisão sua:\n\n- A\n- B"],
  ])("pega a pergunta junto com as opções: %s", (_, text, expected) => {
    expect(proseQuestion(text)).toBe(expected);
  });

  it.each([
    ["lista sem pergunta antes", "Fiz:\n\n1. A\n2. B"],
    ["um item só não é escolha", "Qual você prefere?\n\n1. A"],
  ])("fica quieta: %s", (_, text) => {
    expect(proseQuestion(text)).toBeNull();
  });
});

describe("proseQuestion — lista que não é escolha continua pendência", () => {
  it.each([
    ["perguntas numeradas", "Duas perguntas:\n1. Você quer A?\n2. Você prefere B?", "Duas perguntas:\n1. Você quer A?\n2. Você prefere B?"],
    ["pergunta no último item", "Próximos passos:\n\n- Rodo os testes\n- Quer que eu abra o PR?", "Próximos passos:\n\n- Rodo os testes\n- Quer que eu abra o PR?"],
  ])("%s", (_, text, expected) => {
    expect(proseQuestion(text)).toBe(expected);
    expect(proseOptions(expected)).toBeNull();
  });
});

describe("proseOptions — as opções clicáveis de uma pergunta em prosa", () => {
  it("separa o enunciado das opções numeradas (o caso do 'Decisão sua:')", () => {
    expect(
      proseOptions("Decisão sua:\n1. Eu crio esse PR de teste (recomendado).\n2. Você autoriza o merge em `main`, o que já é deploy."),
    ).toEqual({
      lead: "Decisão sua:",
      options: [
        { label: "Eu crio esse PR de teste (recomendado)." },
        { label: "Você autoriza o merge em main, o que já é deploy." },
      ],
    });
  });

  it.each([
    ["negrito seguido de travessão", "**Rápida** — só o front.", { label: "Rápida", description: "só o front." }],
    ["negrito seguido de dois-pontos", "**Rápida (recomendado):** só o front.", { label: "Rápida (recomendado)", description: "só o front." }],
    ["título e travessão sem negrito", "Rápida — só o front.", { label: "Rápida", description: "só o front." }],
    ["só negrito, sem explicação", "**Rápida**", { label: "Rápida" }],
  ])("o título vira rótulo e o resto vira explicação: %s", (_, item, expected) => {
    expect(proseOptions(`Qual você prefere?\n1. ${item}\n2. B`)?.options[0]).toEqual(expected);
  });

  it("a linha de continuação de um item entra na explicação dele", () => {
    expect(proseOptions("Qual você prefere?\n\n1. **A**\n   explica o A\n2. **B**\n   explica o B")?.options).toEqual([
      { label: "A", description: "explica o A" },
      { label: "B", description: "explica o B" },
    ]);
  });

  it("sub-item indentado é explicação do item de cima, não opção própria", () => {
    expect(proseOptions("Qual você prefere?\n1. **A** — rápido\n   - custo: baixo\n   - risco: médio\n2. **B** — lento")?.options).toEqual([
      { label: "A", description: "rápido\n- custo: baixo\n- risco: médio" },
      { label: "B", description: "lento" },
    ]);
  });

  it("a saída livre ('Outra: descreva') não vira botão: a resposta livre já tem o seu", () => {
    expect(proseOptions("Qual você prefere?\n1. Rápida\n2. Lenta\n3. Outra: descreva")?.options).toEqual([
      { label: "Rápida" },
      { label: "Lenta" },
    ]);
  });

  it("itálico e link saem do rótulo e da explicação", () => {
    expect(proseOptions("Qual você prefere?\n1. *Rápida* — ver [o PR](https://x.y/1)\n2. _Lenta_")?.options).toEqual([
      { label: "Rápida", description: "ver o PR" },
      { label: "Lenta" },
    ]);
  });

  it.each([
    ["sem lista", "Qual você prefere?"],
    ["um item só", "Qual você prefere?\n1. A"],
    ["texto depois da lista", "Qual você prefere?\n1. A\n2. B\n\nOu outra coisa."],
  ])("sem opções clicáveis: %s", (_, question) => {
    expect(proseOptions(question)).toBeNull();
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

/* -------------------------------------------------------- explicit answer */

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

/**
 * THE COST PER TOKEN. Each `assistant_delta` gives the component a new `rows` array, and the map of
 * answers is recalculated — but the closed rows are the SAME objects as before (the reducer only
 * swaps the one that changed). Rereading the whole text of every old answer on every token made the cost of
 * each token grow with the card's history.
 */
describe("decisionReplies — linhas que não mudaram não são relidas", () => {
  const closed = Array.from({ length: 50 }, (_, i) =>
    assistant(`a${i}`, `Resposta ${i}, com contexto.\n\nQual das opções você prefere no passo ${i}?`),
  );
  /** How many times the text of one of these rows was split into paragraphs. */
  function splitsOf(rows: readonly SdkRow[], run: () => void): number {
    const texts = new Set(rows.map((row) => ("text" in row ? row.text : "")));
    const split = vi.spyOn(String.prototype, "split");
    try {
      run();
      return split.mock.contexts.filter((self) => texts.has(String(self))).length;
    } finally {
      split.mockRestore();
    }
  }

  it("um token novo no fim não relê as respostas fechadas", () => {
    const before = decisionReplies(closed);
    const streaming: SdkRow = { kind: "assistant", id: "live", text: "Come", streaming: true };
    const next = [...closed, streaming];

    let after = new Map<string, string>();
    expect(splitsOf(closed, () => { after = decisionReplies(next); })).toBe(0);
    expect(after).toEqual(before);
  });

  it("uma linha que mudou de texto (objeto novo) é relida", () => {
    decisionReplies(closed);
    const changed = assistant("a0", "Mudei de ideia.\n\nPosso seguir com a opção B?");
    const rows = [changed, ...closed.slice(1), user("u1", buildDecisionReply("Posso seguir com a opção B?", "pode"))];

    let result = new Map<string, string>();
    expect(splitsOf([changed], () => { result = decisionReplies(rows); })).toBeGreaterThan(0);
    expect(result).toEqual(new Map([["a0", "pode"]]));
  });
});
