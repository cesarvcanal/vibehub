import { beforeEach, describe, expect, it } from "vitest";
import {
  dequeue,
  enqueue,
  headOfQueue,
  lastQueued,
  newQueueId,
  readQueue,
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
