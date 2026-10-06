import { beforeEach, describe, expect, it } from "vitest";
import {
  dequeue,
  enqueue,
  headOfQueue,
  lastQueued,
  markEditing,
  newQueueId,
  readQueue,
  foreignToOutbox,
  releaseEditing,
  updateQueued,
  writeQueue,
  type QueuedMessage,
} from "@/features/board/lib/sdkQueue";

const msg = (id: string, text: string, at = 1): QueuedMessage => ({ id, text, at });

describe("sdkQueue — ordem", () => {
  it("entra no fim: a ordem de entrega é a ordem em que a pessoa escreveu", () => {
    const q = enqueue(enqueue([], msg("a", "primeira")), msg("b", "segunda"));
    expect(q.map((m) => m.text)).toEqual(["primeira", "segunda"]);
    expect(headOfQueue(q)).toMatchObject({ text: "primeira" });
    expect(lastQueued(q)).toMatchObject({ text: "segunda" });
  });

  it("uma fila vazia não tem cabeça nem última", () => {
    expect(headOfQueue([])).toBeNull();
    expect(lastQueued([])).toBeNull();
  });

  it("o mesmo id não duplica — ele reentra no fim com o texto novo", () => {
    const q = enqueue(enqueue([msg("a", "primeira")], msg("b", "segunda")), msg("a", "primeira corrigida"));
    expect(q.map((m) => m.text)).toEqual(["segunda", "primeira corrigida"]);
  });

  it("dequeue tira só a citada e devolve a mesma lista quando o id não existe", () => {
    const q = [msg("a", "um"), msg("b", "dois")];
    expect(dequeue(q, "a").map((m) => m.id)).toEqual(["b"]);
    expect(dequeue(q, "z")).toHaveLength(2);
  });

  it("não muta a lista que recebeu", () => {
    const q = [msg("a", "um")];
    enqueue(q, msg("b", "dois"));
    dequeue(q, "a");
    expect(q.map((m) => m.id)).toEqual(["a"]);
  });
});

describe("sdkQueue — ids", () => {
  it("dá um id por espera, estável para o mesmo relógio e sorteio", () => {
    expect(newQueueId(1, () => 0.5)).toBe(newQueueId(1, () => 0.5));
    expect(newQueueId(1, () => 0.5)).not.toBe(newQueueId(2, () => 0.5));
  });
});

describe("sdkQueue — durabilidade (o F5 no meio de um turno longo)", () => {
  beforeEach(() => localStorage.clear());

  it("o que foi escrito volta depois do reload, por card", () => {
    writeQueue("card-1", [msg("a", "não esqueça o teste")]);
    expect(readQueue("card-1")).toEqual([msg("a", "não esqueça o teste")]);
    expect(readQueue("card-2")).toEqual([]);
  });

  it("uma fila vazia não deixa lixo no storage", () => {
    writeQueue("card-1", [msg("a", "x")]);
    writeQueue("card-1", []);
    expect(localStorage.getItem("vibehub.sdkQueue.card-1")).toBeNull();
  });

  it("lixo gravado por uma versão antiga não derruba a tela", () => {
    localStorage.setItem("vibehub.sdkQueue.card-1", "{isso não é json}");
    expect(readQueue("card-1")).toEqual([]);
    localStorage.setItem("vibehub.sdkQueue.card-1", JSON.stringify([{ id: 1 }, { text: "sem id" }, msg("a", "boa")]));
    expect(readQueue("card-1")).toEqual([msg("a", "boa")]);
  });

  it("uma entrada sem relógio ganha um — a ordem nunca fica indefinida", () => {
    localStorage.setItem("vibehub.sdkQueue.card-1", JSON.stringify([{ id: "a", text: "antiga" }]));
    expect(readQueue("card-1")[0]!.at).toEqual(expect.any(Number));
  });
});

/**
 * EM EDIÇÃO — a mensagem que está no campo de texto.
 *
 * Ela não sai da fila: guarda o lugar dela (senão cancelar a edição a mandaria pro fim, atrás de
 * quem chegou depois) e guarda o texto (senão um F5 no meio da correção apagaria justamente o que
 * a fila existe pra não perder). O que muda é só isto: o despacho a pula.
 */
describe("sdkQueue — a mensagem que está no campo", () => {
  it("o despacho pula quem está sendo reescrita, sem furar a ordem dos outros", () => {
    const q = markEditing([msg("a", "um"), msg("b", "dois")], "a");
    expect(headOfQueue(q)).toMatchObject({ id: "b" });
    expect(q.map((m) => m.id)).toEqual(["a", "b"]); // ninguém saiu do lugar
  });

  it("uma fila inteiramente em edição não tem o que despachar", () => {
    expect(headOfQueue(markEditing([msg("a", "um")], "a"))).toBeNull();
    expect(lastQueued(markEditing([msg("a", "um")], "a"))).toBeNull();
  });

  it("só uma por vez: marcar a segunda devolve a primeira à fila, no lugar dela", () => {
    const q = markEditing(markEditing([msg("a", "um"), msg("b", "dois")], "a"), "b");
    expect(q.map((m) => [m.id, m.editing === true])).toEqual([
      ["a", false],
      ["b", true],
    ]);
  });

  it("soltar devolve todo mundo ao jogo, sem remexer na ordem (o F5 no meio da correção)", () => {
    const q = releaseEditing(markEditing([msg("a", "um"), msg("b", "dois")], "a"));
    expect(headOfQueue(q)).toMatchObject({ id: "a" });
    expect(releaseEditing(q)).toBe(q); // nada a soltar: a mesma lista, sem re-render à toa
  });

  it("o texto reescrito entra NO LUGAR do antigo — cancelar ou salvar não reordena nada", () => {
    const q = updateQueued(markEditing([msg("a", "um"), msg("b", "dois")], "a"), "a", "um, corrigido", 9);
    expect(q.map((m) => m.text)).toEqual(["um, corrigido", "dois"]);
    expect(q[0]).toMatchObject({ at: 9, editing: false });
  });

  it("um Enter nunca faz palavras sumirem: sem a entrada original, o texto entra como nova", () => {
    const q = updateQueued([msg("b", "dois")], "sumiu", "o que eu escrevi", 9);
    expect(q.map((m) => m.text)).toEqual(["dois", "o que eu escrevi"]);
  });

  it("o que estava sendo reescrito sobrevive ao reload — com o texto de antes da correção", () => {
    writeQueue("card-1", markEditing([msg("a", "o original")], "a"));
    expect(releaseEditing(readQueue("card-1"))).toEqual([{ id: "a", text: "o original", at: 1, editing: false }]);
  });
});

describe("a fila de OUTRA conta (a aba trocou de conta com mensagens esperando)", () => {
  const MUSSA = { kind: "owner" as const, name: "mussa" };

  it("guarda quem escreveu, e um autor corrompido vira \"sem autor\"", () => {
    writeQueue("card-q-autor", [{ id: "q1", text: "oi", at: 1, from: MUSSA }]);
    expect(readQueue("card-q-autor")[0]!.from).toEqual(MUSSA);
    writeQueue("card-q-autor", [{ id: "q1", text: "oi", at: 1, from: { kind: "x", name: 1 } as never }]);
    expect(readQueue("card-q-autor")[0]!.from).toBeUndefined();
    writeQueue("card-q-autor", []);
  });

  it("separa o que é de outra conta: vira cópia NÃO ENTREGUE dela, nunca um envio da conta atual", () => {
    const queue = [
      { id: "q1", text: "da mussa", at: 1, from: MUSSA },
      { id: "q2", text: "do cesar", at: 2, from: { kind: "user" as const, name: "cesar" } },
      { id: "q3", text: "antiga, sem autor", at: 3 },
    ];
    const { own, foreign } = foreignToOutbox(queue, "cesar");
    // sem autor = de antes desta versão: continua com quem está na aba (o comportamento de sempre)
    expect(own.map((m) => m.id)).toEqual(["q2", "q3"]);
    expect(foreign).toEqual([{ cid: "q1", text: "da mussa", at: 1, from: MUSSA, undelivered: true }]);
  });

  it("sem leitor conhecido ainda, nada é separado (não se decide no escuro)", () => {
    const queue = [{ id: "q1", text: "da mussa", at: 1, from: MUSSA }];
    expect(foreignToOutbox(queue, undefined)).toEqual({ own: queue, foreign: [] });
  });
});
