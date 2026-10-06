import { describe, it, expect, beforeEach } from "vitest";
import {
  OUTBOX_ACK_TIMEOUT_MS,
  addToOutbox,
  dropFromOutbox,
  newCid,
  markUndelivered,
  overdueMessages,
  readOutbox,
  reconcileOutbox,
  retryOutbox,
  writeOutbox,
  type OutboxMessage,
} from "@/features/board/lib/sdkOutbox";

/**
 * O BUG QUE ESTE ARQUIVO FIXA (produção, 2026-09-17): "mando a mensagem, fica carregando sem nada
 * acontecer; dou F5 e é como se eu não tivesse enviado nada". A bolha era estado React desenhado
 * porque `socket.send()` não reclamou — e um socket meio-aberto aceita `send()` no vácuo. Sem
 * recibo do servidor e sem cópia em disco, a única testemunha da mensagem era a tela, que o F5
 * apagava. O outbox é essa cópia, e o `user_ack` é esse recibo.
 */

const CARD = "card-1";

beforeEach(() => {
  localStorage.clear();
});

function msg(cid: string, text: string, at = 1_000): OutboxMessage {
  return { cid, text, at };
}

describe("persistência — o texto sobrevive ao F5", () => {
  it("o que foi escrito volta depois de recarregar (outro processo lendo o mesmo storage)", () => {
    writeOutbox(CARD, [msg("c1", "instrução longa")]);
    expect(readOutbox(CARD)).toEqual([{ cid: "c1", text: "instrução longa", at: 1_000 }]);
  });

  it("uma lista vazia LIMPA a chave (nada de lixo acumulado por card)", () => {
    writeOutbox(CARD, [msg("c1", "x")]);
    writeOutbox(CARD, []);
    expect(localStorage.getItem("vibehub.sdkOutbox." + CARD)).toBeNull();
    expect(readOutbox(CARD)).toEqual([]);
  });

  it("storage corrompido, ausente ou com entradas inválidas lê como vazio, nunca explode", () => {
    expect(readOutbox("nunca-usado")).toEqual([]);
    localStorage.setItem("vibehub.sdkOutbox." + CARD, "{não é json");
    expect(readOutbox(CARD)).toEqual([]);
    localStorage.setItem("vibehub.sdkOutbox." + CARD, JSON.stringify([{ cid: 1 }, { text: "sem cid" }, null]));
    expect(readOutbox(CARD)).toEqual([]);
  });

  it("uma entrada sem `at` (formato antigo) ganha o relógio agora, em vez de nascer vencida", () => {
    localStorage.setItem("vibehub.sdkOutbox." + CARD, JSON.stringify([{ cid: "c1", text: "oi" }]));
    const [entry] = readOutbox(CARD);
    expect(entry!.at).toBeGreaterThan(0);
    expect(overdueMessages([entry!], Date.now())).toEqual([]);
  });

  it("cards não se misturam", () => {
    writeOutbox("a", [msg("c1", "da a")]);
    writeOutbox("b", [msg("c2", "da b")]);
    expect(readOutbox("a").map((m) => m.text)).toEqual(["da a"]);
    expect(readOutbox("b").map((m) => m.text)).toEqual(["da b"]);
  });
});

describe("a fila em si", () => {
  it("acrescenta, e um reenvio com o mesmo cid substitui (não duplica a bolha)", () => {
    const one = addToOutbox([], msg("c1", "oi", 1));
    const again = addToOutbox(one, msg("c1", "oi", 50));
    expect(again).toEqual([{ cid: "c1", text: "oi", at: 50 }]);
  });

  it("o recibo tira a mensagem da fila; um cid desconhecido não mexe em nada", () => {
    const list = [msg("c1", "a"), msg("c2", "b")];
    expect(dropFromOutbox(list, "c1").map((m) => m.cid)).toEqual(["c2"]);
    expect(dropFromOutbox(list, "c9")).toEqual(list);
  });

  it("vencidas são as que passaram do prazo sem recibo — as recentes seguem 'enviando'", () => {
    const now = 100_000;
    const list = [
      msg("velha", "sem recibo há muito", now - OUTBOX_ACK_TIMEOUT_MS - 1),
      msg("nova", "acabou de sair", now - 500),
    ];
    expect(overdueMessages(list, now).map((m) => m.cid)).toEqual(["velha"]);
  });

  /**
   * O BUG DO HOTFIX (produção, 2026-09-17): a bolha "não entregue" fica na fila de propósito — é a
   * cópia que o reenviar/descartar usa — e o `at` dela não muda mais. Sem marcar o veredito, ela
   * seguia VENCIDA em todo tique do watchdog, que derrubava o socket a cada vez: a tela piscava
   * "chat → Iniciando o agente… → histórico → chat" de 2 em 2 segundos, sem parar.
   */
  it("uma vencida JÁ cobrada não vence de novo (era o loop de reconexão a cada tique)", () => {
    const now = 100_000;
    const list = [msg("velha", "sem recibo há muito", now - OUTBOX_ACK_TIMEOUT_MS - 1)];
    const cobrada = markUndelivered(list, ["velha"]);
    expect(cobrada[0]!.undelivered).toBe(true);
    expect(overdueMessages(cobrada, now)).toEqual([]);
    expect(overdueMessages(cobrada, now + 10 * OUTBOX_ACK_TIMEOUT_MS)).toEqual([]);
    // …e a mensagem continua guardada: o veredito não apaga o texto.
    expect(cobrada[0]!.text).toBe("sem recibo há muito");
  });

  it("markUndelivered: só mexe nos cids citados, e não recria a lista à toa", () => {
    const list = [msg("c1", "a"), msg("c2", "b")];
    const marked = markUndelivered(list, ["c1"]);
    expect(marked.map((m) => m.undelivered)).toEqual([true, undefined]);
    expect(markUndelivered(marked, ["c1"])).toBe(marked); // nada mudou: mesma referência
    expect(markUndelivered(list, ["não-existe"])).toBe(list);
  });

  it("o reenvio rearma o relógio e apaga o veredito — o watchdog volta a cobrar esse envio", () => {
    const now = 100_000;
    const entry = msg("c1", "instrução longa", now - OUTBOX_ACK_TIMEOUT_MS - 1);
    const cobrada = markUndelivered([entry], ["c1"]);
    const reenviada = retryOutbox(cobrada, cobrada[0]!, now);
    expect(reenviada).toHaveLength(1); // mesmo cid: uma bolha só, não duas
    expect(overdueMessages(reenviada, now)).toEqual([]); // acabou de sair
    expect(overdueMessages(reenviada, now + OUTBOX_ACK_TIMEOUT_MS).map((m) => m.cid)).toEqual(["c1"]);
  });


  /**
   * O BUG DO CÉSAR (produção, 2026-09-28): mensagens marcadas "não entregue" com o servidor no ar.
   *
   * O prazo do recibo é uma acusação — "mandei e ninguém respondeu" — e ela só vale se havia alguém
   * em condições de responder. Não havia: o `onopen` do navegador dispara no aperto de mão do
   * websocket, mas o back só passa a ATENDER frames depois de um setup de vários segundos (install
   * do driver por SSH+docker, sonda de transcript com timeout de 15s — sozinha maior que este
   * prazo —, replay do histórico, spawn). Até lá o frame espera bufferado e É entregue depois.
   *
   * Então o relógio tem um PISO: o instante em que a conexão passou a poder responder (o `ready`).
   * Antes dele nenhum silêncio prova nada.
   */
  it("o prazo conta a partir do instante em que a conexão pôde responder, não do envio", () => {
    const now = 100_000;
    // Enviada 30s atrás, mas o servidor só assumiu o socket 2s atrás: ninguém deve nada ainda.
    const list = [msg("c1", "instrução longa", now - 30_000)];
    expect(overdueMessages(list, now, OUTBOX_ACK_TIMEOUT_MS, now - 2_000)).toEqual([]);
    // Passado o prazo INTEIRO desde que a conexão está de pé, aí sim o silêncio é resposta.
    expect(
      overdueMessages(list, now, OUTBOX_ACK_TIMEOUT_MS, now - OUTBOX_ACK_TIMEOUT_MS - 1).map((m) => m.cid),
    ).toEqual(["c1"]);
  });

  it("o piso nunca ENCURTA o prazo de quem foi enviado com a conexão já de pé", () => {
    const now = 100_000;
    // Conexão de pé há muito tempo; a mensagem é que acabou de sair — o prazo é dela, não do piso.
    const list = [msg("c1", "instrução longa", now - 1_000)];
    expect(overdueMessages(list, now, OUTBOX_ACK_TIMEOUT_MS, now - 600_000)).toEqual([]);
  });
  it("newCid: ids distintos a cada envio", () => {
    expect(newCid(1, () => 0.1)).not.toBe(newCid(2, () => 0.1));
    expect(newCid(1, () => 0.1)).not.toBe(newCid(1, () => 0.9));
  });
});

describe("reconciliação no reconnect — quem foi gravado e quem morreu no caminho", () => {
  it("o replay traz a mensagem: o recibo é que se perdeu, não a mensagem", () => {
    const { delivered, missing } = reconcileOutbox(["roda os testes"], [msg("c1", "roda os testes")]);
    expect(delivered.map((m) => m.cid)).toEqual(["c1"]);
    expect(missing).toEqual([]);
  });

  it("o replay NÃO traz: é a mensagem perdida — e é ela que a tela precisa mostrar marcada", () => {
    const { delivered, missing } = reconcileOutbox(["outra coisa"], [msg("c1", "instrução longa")]);
    expect(delivered).toEqual([]);
    expect(missing.map((m) => m.text)).toEqual(["instrução longa"]);
  });

  it("casa por texto colapsando espaços (o servidor pode reflowar a mensagem)", () => {
    const { delivered } = reconcileOutbox(["roda  os\n testes"], [msg("c1", "roda os testes")]);
    expect(delivered.map((m) => m.cid)).toEqual(["c1"]);
  });

  it("cada linha do replay casa com UMA entrada: mandar a mesma frase duas vezes não entrega as duas", () => {
    const { delivered, missing } = reconcileOutbox(["oi"], [msg("c1", "oi"), msg("c2", "oi")]);
    expect(delivered.map((m) => m.cid)).toEqual(["c1"]);
    expect(missing.map((m) => m.cid)).toEqual(["c2"]);
  });

  it("fila vazia é um não-evento", () => {
    expect(reconcileOutbox(["oi"], [])).toEqual({ delivered: [], missing: [] });
  });
});

describe("o AUTOR da mensagem guardada (troca de conta na mesma aba)", () => {
  it("guarda quem escreveu e o devolve depois do F5", () => {
    writeOutbox("card-autor", [{ cid: "c1", text: "oi", at: 1, from: { kind: "owner", name: "mussa" } }]);
    expect(readOutbox("card-autor")[0]!.from).toEqual({ kind: "owner", name: "mussa" });
    writeOutbox("card-autor", []);
  });

  it("um autor corrompido no localStorage vira \"sem autor\", nunca lixo na tela", () => {
    localStorage.setItem("vibehub.sdkOutbox.card-lixo", JSON.stringify([{ cid: "c1", text: "oi", at: 1, from: { kind: "hacker", name: 3 } }]));
    expect(readOutbox("card-lixo")[0]!.from).toBeUndefined();
    localStorage.removeItem("vibehub.sdkOutbox.card-lixo");
  });
});
