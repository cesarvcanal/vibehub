import { describe, it, expect, beforeEach } from "vitest";
import {
  AUTO_RESEND_DELAYS_MS,
  AUTO_RESEND_MAX_AGE_MS,
  OUTBOX_ACK_TIMEOUT_MS,
  addToOutbox,
  askResend,
  planAutoResend,
  dropFromOutbox,
  newCid,
  markUndelivered,
  overdueMessages,
  readOutbox,
  reconcileOutbox,
  retryOutbox,
  sendMark,
  writeOutbox,
  type OutboxMessage,
  type ServerText,
} from "@/features/board/lib/sdkOutbox";

/** What the server has, in replay order. Without `at`: the old history (or a test that does not care). */
function lines(...texts: string[]): ServerText[] {
  return texts.map((text) => ({ text }));
}

/**
 * THE BUG THIS FILE PINS (production, 2026-09-17): "mando a mensagem, fica carregando sem nada
 * acontecer; dou F5 e é como se eu não tivesse enviado nada". The bubble was React state drawn
 * because `socket.send()` did not complain — and a half-open socket accepts `send()` into the void.
 * With no receipt from the server and no copy on disk, the only witness of the message was the
 * screen, which the F5 wiped. The outbox is that copy, and `user_ack` is that receipt.
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
   * THE HOTFIX BUG (production, 2026-09-17): the "não entregue" bubble stays in the queue on purpose
   * — it is the copy that resend/discard uses — and its `at` no longer changes. Without marking the
   * verdict, it stayed OVERDUE on every watchdog tick, which dropped the socket every time: the
   * screen flashed "chat → Iniciando o agente… → histórico → chat" every 2 seconds, nonstop.
   */
  it("uma vencida JÁ cobrada não vence de novo (era o loop de reconexão a cada tique)", () => {
    const now = 100_000;
    const list = [msg("velha", "sem recibo há muito", now - OUTBOX_ACK_TIMEOUT_MS - 1)];
    const cobrada = markUndelivered(list, ["velha"]);
    expect(cobrada[0]!.undelivered).toBe(true);
    expect(overdueMessages(cobrada, now)).toEqual([]);
    expect(overdueMessages(cobrada, now + 10 * OUTBOX_ACK_TIMEOUT_MS)).toEqual([]);
    // …and the message stays stored: the verdict does not erase the text.
    expect(cobrada[0]!.text).toBe("sem recibo há muito");
  });

  it("markUndelivered: só mexe nos cids citados, e não recria a lista à toa", () => {
    const list = [msg("c1", "a"), msg("c2", "b")];
    const marked = markUndelivered(list, ["c1"]);
    expect(marked.map((m) => m.undelivered)).toEqual([true, undefined]);
    expect(markUndelivered(marked, ["c1"])).toBe(marked); // nothing changed: same reference
    expect(markUndelivered(list, ["não-existe"])).toBe(list);
  });

  it("o reenvio rearma o relógio e apaga o veredito — o watchdog volta a cobrar esse envio", () => {
    const now = 100_000;
    const entry = msg("c1", "instrução longa", now - OUTBOX_ACK_TIMEOUT_MS - 1);
    const cobrada = markUndelivered([entry], ["c1"]);
    const reenviada = retryOutbox(cobrada, cobrada[0]!, now, {});
    expect(reenviada).toHaveLength(1); // same cid: a single bubble, not two
    expect(overdueMessages(reenviada, now)).toEqual([]); // it just left
    expect(overdueMessages(reenviada, now + OUTBOX_ACK_TIMEOUT_MS).map((m) => m.cid)).toEqual(["c1"]);
  });


  /**
   * CÉSAR'S BUG (production, 2026-09-28): messages marked "não entregue" with the server up.
   *
   * The receipt deadline is an accusation — "I sent it and nobody answered" — and it only holds if
   * someone was in a position to answer. Nobody was: the browser's `onopen` fires on the websocket
   * handshake, but the back only starts SERVING frames after a setup of several seconds (driver
   * install over SSH+docker, transcript probe with a 15s timeout — alone longer than this
   * deadline —, history replay, spawn). Until then the frame waits buffered and IS delivered later.
   *
   * So the clock has a FLOOR: the instant the connection became able to answer (the `ready`).
   * Before it, no silence proves anything.
   */
  it("o prazo conta a partir do instante em que a conexão pôde responder, não do envio", () => {
    const now = 100_000;
    // Sent 30s ago, but the server only took over the socket 2s ago: nobody owes anything yet.
    const list = [msg("c1", "instrução longa", now - 30_000)];
    expect(overdueMessages(list, now, OUTBOX_ACK_TIMEOUT_MS, now - 2_000)).toEqual([]);
    // Once the WHOLE deadline has passed since the connection came up, then the silence is an answer.
    expect(
      overdueMessages(list, now, OUTBOX_ACK_TIMEOUT_MS, now - OUTBOX_ACK_TIMEOUT_MS - 1).map((m) => m.cid),
    ).toEqual(["c1"]);
  });

  it("o piso nunca ENCURTA o prazo de quem foi enviado com a conexão já de pé", () => {
    const now = 100_000;
    // Connection up for a long time; it is the message that just left — the deadline is its own, not the floor's.
    const list = [msg("c1", "instrução longa", now - 1_000)];
    expect(overdueMessages(list, now, OUTBOX_ACK_TIMEOUT_MS, now - 600_000)).toEqual([]);
  });
  it("newCid: ids distintos a cada envio", () => {
    expect(newCid(1, () => 0.1)).not.toBe(newCid(2, () => 0.1));
    expect(newCid(1, () => 0.1)).not.toBe(newCid(1, () => 0.9));
  });
});

/**
 * THE MANUAL RESEND BUG (production, 2026-10-27): the person sent the message, the connection failed
 * and the bubble stayed "não entregue" with the Reenviar button. She had left; the next day the
 * message was there, waiting for a click — hours of an idle agent over a message the first good
 * connection would have delivered.
 *
 * Now the screen itself resends, on its own, with growing intervals (`AUTO_RESEND_DELAYS_MS`) and a
 * double ceiling: counted attempts (never a loop) and message age (`AUTO_RESEND_MAX_AGE_MS` — an old
 * order does not become a turn without the person). Once the plan runs out, it goes back to being
 * the Reenviar from before.
 */
describe("o reenvio automático — sozinho, espaçado e com fim", () => {
  const T0 = 1_000_000;
  /** A message that already got the "não entregue" verdict, sent at `at`. */
  function failed(cid: string, at: number, extra: Partial<OutboxMessage> = {}): OutboxMessage {
    return { cid, text: `texto ${cid}`, at, undelivered: true, ...extra };
  }

  it("a primeira tentativa vence logo depois do envio que falhou, não na hora", () => {
    const list = [failed("c1", T0)];
    const early = planAutoResend(list, T0 + 1_000);
    expect(early.due).toEqual([]);
    expect(early.pending.has("c1")).toBe(true);
    expect(early.wakeAt).toBe(T0 + AUTO_RESEND_DELAYS_MS[0]!);

    const late = planAutoResend(list, T0 + AUTO_RESEND_DELAYS_MS[0]!);
    expect(late.due.map((m) => m.cid)).toEqual(["c1"]);
  });

  it("os intervalos CRESCEM a cada tentativa gasta — nunca várias por segundo", () => {
    for (let spent = 0; spent < AUTO_RESEND_DELAYS_MS.length; spent += 1) {
      const delay = AUTO_RESEND_DELAYS_MS[spent]!;
      if (spent > 0) expect(delay).toBeGreaterThan(AUTO_RESEND_DELAYS_MS[spent - 1]!);
      const list = [failed("c1", T0, { autoRetries: spent })];
      expect(planAutoResend(list, T0 + delay - 1).due).toEqual([]);
      expect(planAutoResend(list, T0 + delay).due.map((m) => m.cid)).toEqual(["c1"]);
    }
    // The shortest interval is already seconds: even a server that refuses right away does not become a hammer.
    expect(AUTO_RESEND_DELAYS_MS[0]).toBeGreaterThanOrEqual(5_000);
  });

  it("esgotadas as tentativas, ela sai do plano: fica o Reenviar de antes, e nenhum timer", () => {
    const list = [failed("c1", T0, { autoRetries: AUTO_RESEND_DELAYS_MS.length })];
    const plan = planAutoResend(list, T0 + 10 * 60 * 60_000);
    expect(plan.due).toEqual([]);
    expect(plan.pending.size).toBe(0);
    expect(plan.wakeAt).toBeNull();
  });

  it("a mensagem VELHA não sai sozinha: passou do teto de idade, a pessoa decide", () => {
    // Written longer ago than the ceiling — even with attempts left and the interval long elapsed.
    const list = [failed("c1", T0)];
    const plan = planAutoResend(list, T0 + AUTO_RESEND_MAX_AGE_MS);
    expect(plan.due).toEqual([]);
    expect(plan.pending.size).toBe(0);
    expect(plan.wakeAt).toBeNull();
  });

  it("a idade conta de quando foi ESCRITA (writtenAt), não do último reenvio", () => {
    const written = T0;
    const lastTry = T0 + AUTO_RESEND_MAX_AGE_MS - 1_000; // the previous resend rearmed `at`
    const list = [failed("c1", lastTry, { writtenAt: written, autoRetries: 1 })];
    expect(planAutoResend(list, written + AUTO_RESEND_MAX_AGE_MS).pending.size).toBe(0);
  });

  it("acorda no que vier primeiro: o próximo vencimento ou a mensagem envelhecer (a bolha muda)", () => {
    // Long interval (the last attempt) that would only elapse AFTER the age ceiling.
    const spent = AUTO_RESEND_DELAYS_MS.length - 1;
    const at = T0 + AUTO_RESEND_MAX_AGE_MS - 60_000;
    const list = [failed("c1", at, { writtenAt: T0, autoRetries: spent })];
    const plan = planAutoResend(list, at + 1_000);
    expect(plan.wakeAt).toBe(T0 + AUTO_RESEND_MAX_AGE_MS);
  });

  it("só as não entregues: a que está 'enviando' tem o watchdog, e a que nunca saiu (unsent) é da pessoa", () => {
    const list: OutboxMessage[] = [
      { cid: "voando", text: "a", at: T0 },
      failed("nunca-saiu", T0, { unsent: true }),
      failed("falhou", T0),
    ];
    const plan = planAutoResend(list, T0 + 60_000);
    expect(plan.due.map((m) => m.cid)).toEqual(["falhou"]);
    expect([...plan.pending]).toEqual(["falhou"]);
  });

  it("vencidas saem na ordem em que foram escritas — a conversa não embaralha", () => {
    const list = [failed("segunda", T0 + 2_000, { writtenAt: T0 + 2_000 }), failed("primeira", T0 + 1_000)];
    const plan = planAutoResend(list, T0 + 60_000);
    expect(plan.due.map((m) => m.cid)).toEqual(["primeira", "segunda"]);
  });

  it("o reenvio automático gasta UMA tentativa e guarda quando ela foi escrita", () => {
    const entry = failed("c1", T0);
    const once = retryOutbox([entry], entry, T0 + 5_000, {}, true);
    expect(once[0]).toMatchObject({ cid: "c1", at: T0 + 5_000, undelivered: false, autoRetries: 1, writtenAt: T0 });
    const twice = retryOutbox(once, { ...once[0]!, undelivered: true }, T0 + 30_000, {}, true);
    expect(twice[0]).toMatchObject({ autoRetries: 2, writtenAt: T0 });
  });

  it("o Reenviar na MÃO é intenção renovada: zera as tentativas e a idade", () => {
    const entry = failed("c1", T0, { autoRetries: AUTO_RESEND_DELAYS_MS.length, writtenAt: T0 - 5 * 60 * 60_000 });
    const manual = retryOutbox([entry], entry, T0 + 1_000, {});
    expect(manual[0]!.autoRetries).toBeUndefined();
    expect(manual[0]!.writtenAt).toBe(T0 + 1_000);
    // …and if this send also fails, the plan restarts from the first interval.
    const again = planAutoResend([{ ...manual[0]!, undelivered: true }], T0 + 1_000 + AUTO_RESEND_DELAYS_MS[0]!);
    expect(again.due.map((m) => m.cid)).toEqual(["c1"]);
  });

  it("o plano sobrevive ao F5: tentativas e idade vão pro disco e voltam saneadas", () => {
    writeOutbox(CARD, [failed("c1", T0, { autoRetries: 3, writtenAt: T0 - 1_000 })]);
    expect(readOutbox(CARD)[0]).toMatchObject({ autoRetries: 3, writtenAt: T0 - 1_000 });
    // localStorage is untrusted input: garbage becomes "no information", never an infinite plan.
    localStorage.setItem(
      "vibehub.sdkOutbox." + CARD,
      JSON.stringify([{ cid: "c1", text: "a", at: T0, undelivered: true, autoRetries: -4, writtenAt: "ontem" }]),
    );
    const sane = readOutbox(CARD)[0]!;
    expect(sane.autoRetries).toBeUndefined();
    expect(sane.writtenAt).toBeUndefined();
  });
});

describe("reconciliação no reconnect — quem foi gravado e quem morreu no caminho", () => {
  it("o replay traz a mensagem: o recibo é que se perdeu, não a mensagem", () => {
    const { delivered, missing } = reconcileOutbox(lines("roda os testes"), [msg("c1", "roda os testes")]);
    expect(delivered.map((m) => m.cid)).toEqual(["c1"]);
    expect(missing).toEqual([]);
  });

  it("o replay NÃO traz: é a mensagem perdida — e é ela que a tela precisa mostrar marcada", () => {
    const { delivered, missing } = reconcileOutbox(lines("outra coisa"), [msg("c1", "instrução longa")]);
    expect(delivered).toEqual([]);
    expect(missing.map((m) => m.text)).toEqual(["instrução longa"]);
  });

  it("casa por texto colapsando espaços (o servidor pode reflowar a mensagem)", () => {
    const { delivered } = reconcileOutbox(lines("roda  os\n testes"), [msg("c1", "roda os testes")]);
    expect(delivered.map((m) => m.cid)).toEqual(["c1"]);
  });

  it("cada linha do replay casa com UMA entrada: mandar a mesma frase duas vezes não entrega as duas", () => {
    const { delivered, missing } = reconcileOutbox(lines("oi"), [msg("c1", "oi"), msg("c2", "oi")]);
    expect(delivered.map((m) => m.cid)).toEqual(["c1"]);
    expect(missing.map((m) => m.cid)).toEqual(["c2"]);
  });

  it("fila vazia é um não-evento", () => {
    expect(reconcileOutbox(lines("oi"), [])).toEqual({ delivered: [], missing: [] });
  });

  /**
   * YESTERDAY'S "SIM". The replay brings the WHOLE conversation (the history window), not just what
   * came after the send — and a short answer repeats all the time. Matching against everything
   * counted today's "sim", lost in a half-open socket, as delivered just because yesterday someone
   * said "sim": the message vanished silently, which is exactly what the outbox exists to prevent.
   */
  it("um 'sim' que JÁ estava na conversa no envio não entrega o 'sim' de agora", () => {
    const today = { ...msg("c1", "sim"), seenBefore: 1 };
    const { delivered, missing } = reconcileOutbox(lines("sim"), [today]);
    expect(delivered).toEqual([]);
    expect(missing.map((m) => m.cid)).toEqual(["c1"]);
  });

  it("um 'sim' A MAIS do que havia no envio é o de agora: entregue", () => {
    const { delivered } = reconcileOutbox(lines("sim", "sim"), [{ ...msg("c1", "sim"), seenBefore: 1 }]);
    expect(delivered.map((m) => m.cid)).toEqual(["c1"]);
  });

  it("dois envios do mesmo texto: cada um precisa da SUA ocorrência depois do que já havia", () => {
    // c1 left with one "sim" in the conversation; c2 left after c1 was stored (two "sim" on screen).
    const pending = [{ ...msg("c1", "sim"), seenBefore: 1 }, { ...msg("c2", "sim"), seenBefore: 2 }];
    expect(reconcileOutbox(lines("sim", "sim", "sim"), pending).delivered.map((m) => m.cid)).toEqual(["c1", "c2"]);
    const partial = reconcileOutbox(lines("sim", "sim"), pending);
    expect(partial.delivered.map((m) => m.cid)).toEqual(["c1"]);
    expect(partial.missing.map((m) => m.cid)).toEqual(["c2"]);
  });

  it("a contagem do envio sobrevive ao F5 (vai pro disco com a mensagem)", () => {
    writeOutbox("card-seen", [{ cid: "c1", text: "sim", at: 1, seenBefore: 3, since: 40, unsent: true }]);
    expect(readOutbox("card-seen")[0]).toMatchObject({ seenBefore: 3, since: 40, unsent: true });
    writeOutbox("card-seen", [{ cid: "c1", text: "sim", at: 1, since: "x", unsent: "sim" } as never]);
    expect(readOutbox("card-seen")[0]).toMatchObject({ since: undefined, unsent: undefined });
  });

  /**
   * THE REPLAY WINDOW MOVES. The replay is the end of the history, not the whole history: in a long
   * conversation, the oldest "ok" leave it between the send and the reconnect. The send's mark is
   * therefore ANCHORED on the SERVER clock: `since` is the newest `at` the screen knew, and only what
   * was stored after it counts — what the window discards is always the OLDEST, never that.
   */
  describe("a marca do envio (sendMark) contra uma janela que anda", () => {
    const seis = [1, 2, 3, 4, 5, 6].map((at) => ({ text: "ok", at }));

    it("ancora no `at` mais novo da tela: nada gravado antes dele conta", () => {
      expect(sendMark(seis, "ok")).toEqual({ since: 6, seenBefore: 0 });
    });

    it("um envio desta conexão já confirmado (sem `at` ainda) conta: ele volta no replay depois da âncora", () => {
      expect(sendMark([...seis, { text: "ok" }], "ok")).toEqual({ since: 6, seenBefore: 1 });
    });

    it("sem nenhum `at` na tela (histórico antigo), conta tudo, como sempre foi", () => {
      expect(sendMark(lines("ok", "sim", "ok"), "ok")).toEqual({ since: undefined, seenBefore: 2 });
    });

    it("a janela perdeu os 'ok' antigos: o 'ok' gravado depois da âncora entrega", () => {
      const sent = { ...msg("c1", "ok"), ...sendMark(seis, "ok") };
      const replay = [{ text: "ok", at: 5 }, { text: "ok", at: 6 }, { text: "ok", at: 100 }];
      expect(reconcileOutbox(replay, [sent]).delivered.map((m) => m.cid)).toEqual(["c1"]);
    });

    it("…e sem ele, nenhum 'ok' antigo entrega — por mais que a janela ainda tenha vários", () => {
      const sent = { ...msg("c1", "ok"), ...sendMark(seis, "ok") };
      expect(reconcileOutbox(seis, [sent]).missing.map((m) => m.cid)).toEqual(["c1"]);
    });

    it("dois envios do mesmo texto depois da âncora: cada um precisa da SUA ocorrência", () => {
      const c1 = { ...msg("c1", "ok"), ...sendMark(seis, "ok") };
      const c2 = { ...msg("c2", "ok"), ...sendMark([...seis, { text: "ok" }], "ok") };
      const umSo = [...seis.slice(-2), { text: "ok", at: 50 }];
      expect(reconcileOutbox(umSo, [c1, c2])).toMatchObject({
        delivered: [{ cid: "c1" }],
        missing: [{ cid: "c2" }],
      });
    });
  });

  it("uma mensagem que NUNCA saiu deste navegador nunca é dada por entregue, nem com o texto no replay", () => {
    const { delivered, missing } = reconcileOutbox(lines("oi"), [{ ...msg("c1", "oi"), unsent: true }]);
    expect(delivered).toEqual([]);
    expect(missing.map((m) => m.cid)).toEqual(["c1"]);
  });

  it("o Reenviar é o envio de verdade: marca de novo contra a tela de agora, e deixa de ser 'nunca enviada'", () => {
    const old = { ...msg("c1", "ok"), seenBefore: 9, since: 2, undelivered: true, unsent: true };
    const [again] = retryOutbox([old], old, 5_000, { since: 7, seenBefore: 1 });
    expect(again).toMatchObject({ at: 5_000, since: 7, seenBefore: 1, undelivered: false });
    expect(again!.unsent).toBeUndefined();
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

describe("askResend — o Reenviar clicado sem fio (produção, 2026-11-06)", () => {
  const T0 = 1_800_000_000_000;
  const failed: OutboxMessage = { cid: "a", text: "instrução longa", at: T0, undelivered: true, autoRetries: 5 };

  it("vira devida JÁ, mesmo com o plano automático esgotado e antes de qualquer intervalo", () => {
    const list = askResend([failed], "a", T0);
    const plan = planAutoResend(list, T0 + 1);
    expect(plan.due.map((m) => m.cid)).toEqual(["a"]);
    expect(plan.pending.has("a")).toBe(true);
  });

  it("a idade conta do CLIQUE: mensagem velha pedida agora sai; pedido de ontem não dispara sozinho", () => {
    const later = T0 + AUTO_RESEND_MAX_AGE_MS + 1;
    expect(planAutoResend(askResend([failed], "a", later), later + 1).due.map((m) => m.cid)).toEqual(["a"]);
    expect(planAutoResend(askResend([failed], "a", T0), later).due).toHaveLength(0);
  });

  it("não toca no que está a caminho (sem veredito) nem no que não existe", () => {
    const sending: OutboxMessage = { cid: "b", text: "x", at: T0 };
    const list = [sending];
    expect(askResend(list, "b", T0)).toBe(list);
    expect(askResend(list, "zz", T0)).toBe(list);
  });

  it("o envio de verdade apaga o pedido — um segundo envio só com novo veredito e novo pedido", () => {
    const asked = askResend([failed], "a", T0);
    const sent = retryOutbox(asked, asked[0]!, T0 + 10, {});
    expect(sent[0]!.asked).toBeUndefined();
    expect(planAutoResend(sent, T0 + 20).due).toHaveLength(0);
  });

  it("o pedido não muda a ORDEM: a mais velha pedida sem fio sai antes da mais nova (revisão f1)", () => {
    const older: OutboxMessage = { cid: "a", text: "primeira", at: T0, writtenAt: T0, undelivered: true };
    const newer: OutboxMessage = { cid: "b", text: "segunda", at: T0 + 1_000, writtenAt: T0 + 1_000, undelivered: true };
    const asked = askResend([older, newer], "a", T0 + 60_000);
    expect(asked[0]!.writtenAt).toBe(T0);
    const plan = planAutoResend(asked, T0 + 60_000 + AUTO_RESEND_DELAYS_MS[0]!);
    expect(plan.due.map((m) => m.cid)).toEqual(["a", "b"]);
  });

  it("um clique depois do pedido vencido o renova (revisão f2)", () => {
    const first = askResend([failed], "a", T0);
    const later = T0 + AUTO_RESEND_MAX_AGE_MS + 1;
    expect(planAutoResend(first, later).due).toHaveLength(0);
    expect(planAutoResend(askResend(first, "a", later), later).due.map((m) => m.cid)).toEqual(["a"]);
  });

  it("o pedido acorda o plano quando vence, e a bolha para de prometer (revisão f3)", () => {
    const plan = planAutoResend(askResend([failed], "a", T0), T0 + 1);
    expect(plan.wakeAt).toBe(T0 + AUTO_RESEND_MAX_AGE_MS);
    expect(planAutoResend(askResend([failed], "a", T0), T0 + AUTO_RESEND_MAX_AGE_MS).pending.has("a")).toBe(false);
  });

  it("o pedido sobrevive ao F5 (vai pro disco com a entrada)", () => {
    writeOutbox("card-ask", askResend([failed], "a", T0));
    expect(readOutbox("card-ask")[0]).toMatchObject({ asked: true, askedAt: T0 });
    writeOutbox("card-ask", []);
  });
});
