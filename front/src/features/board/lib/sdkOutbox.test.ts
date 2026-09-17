import { describe, it, expect, beforeEach } from "vitest";
import {
  OUTBOX_ACK_TIMEOUT_MS,
  addToOutbox,
  dropFromOutbox,
  newCid,
  overdueMessages,
  readOutbox,
  reconcileOutbox,
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
