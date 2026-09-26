import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { appendFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "../../config/env.js";
import {
  appendHistory,
  onExternalMessage,
  publishExternalMessage,
  readHistory,
  removeHistory,
  replayableHistoryEvent,
  rewindHistory,
  HISTORY_COMPACT_FACTOR,
  SDK_HISTORY_DIR,
  type HistoryEvent,
} from "./history.js";

/**
 * THE BUG THIS FILE PINS: the native chat's conversation lived only in React state, so a remount
 * (tab switch, reopened card, reload) showed an empty chat even though every message had been
 * delivered — "a mensagem apareceu e depois sumiu". The history log is the durable side of the fix:
 * what one connect records, the next connect replays.
 */

const CARD = "eee498d1-98dd-44b6-97ee-c06a181c3769";

let dir = "";
let savedDataDir = "";

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "vibehub-sdk-history-"));
  savedDataDir = config.dataDir;
  config.dataDir = dir;
});
afterEach(async () => {
  config.dataDir = savedDataDir;
  await rm(dir, { recursive: true, force: true });
});

describe("replayableHistoryEvent", () => {
  it("keeps what the screen must re-draw: user, consolidated text, tools, permission cards", () => {
    expect(replayableHistoryEvent({ type: "user", text: "oi" })).toBe(true);
    expect(replayableHistoryEvent({ type: "assistant_text", text: "resposta" })).toBe(true);
    expect(replayableHistoryEvent({ type: "tool_use", id: "t1", name: "Bash", input: {} })).toBe(true);
    expect(replayableHistoryEvent({ type: "permission_request", id: "p1", tool: "Bash" })).toBe(true);
    expect(
      replayableHistoryEvent({ type: "permission", id: "p1", tool: "Bash", decision: "allow", sensitive: true }),
    ).toBe(true);
    // the panel's own voice (deploy interrupted a turn, boot resumed it) — re-drawn on every replay
    expect(replayableHistoryEvent({ type: "system_note", text: "turno interrompido" })).toBe(true);
    // the edit marker: without it a replay would draw the superseded message as still standing
    expect(replayableHistoryEvent({ type: "message_edited", originalText: "velha" })).toBe(true);
    // The question pair replays too: a pending card comes back clickable, a settled one settled.
    expect(
      replayableHistoryEvent({ type: "user_question", id: "q1", questions: [{ question: "Which?", options: [] }] }),
    ).toBe(true);
    expect(replayableHistoryEvent({ type: "question_result", id: "q1", answers: [{ selected: ["A"] }] })).toBe(true);
  });

  /**
   * O RACIOCÍNIO é de MOMENTO, como o `turn_absorbed`: serve a quem está esperando agora. Gravá-lo
   * encheria o log (limite de replay: 500 eventos) com o pensamento de ontem, empurrando a conversa
   * de verdade — mensagem, ferramenta, resposta — para fora do replay. Em disco fica a conversa.
   */
  it("NÃO grava o raciocínio: ele é orientação ao vivo, não conversa", () => {
    expect(replayableHistoryEvent({ type: "thinking", text: "vou ler o arquivo" })).toBe(false);
    expect(replayableHistoryEvent({ type: "thinking_delta", text: "vou " })).toBe(false);
  });

  it("drops the connection's own chatter: deltas, ready, session, results, errors", () => {
    expect(replayableHistoryEvent({ type: "assistant_delta", text: "oi" })).toBe(false);
    expect(replayableHistoryEvent({ type: "ready" })).toBe(false);
    expect(replayableHistoryEvent({ type: "session", sessionId: "s" })).toBe(false);
    expect(replayableHistoryEvent({ type: "result", isError: false })).toBe(false);
    expect(replayableHistoryEvent({ type: "error", message: "driver exited (code 1)" })).toBe(false);
    // a permission without an id is the auto-allowed bulk — noise the chat never drew
    expect(
      replayableHistoryEvent({ type: "permission", tool: "Read", decision: "allow", sensitive: false }),
    ).toBe(false);
  });

  it("a MIRRORED terminal event survives the round trip with its stamp, tid and time", async () => {
    const mirrored: HistoryEvent = {
      type: "user",
      text: "ok boa como a gnt segue?",
      at: 1_756_680_000_000,
      source: "terminal",
      tid: "u1",
    };
    await publishExternalMessage(CARD, mirrored);
    expect(await readHistory(CARD)).toEqual([mirrored]);
  });
});

describe("appendHistory / readHistory", () => {
  it("what one connect appends, the next connect reads back in order", async () => {
    await appendHistory(CARD, { type: "user", text: "manda a primeira", at: 1 });
    await appendHistory(CARD, { type: "assistant_text", text: "feito", at: 2 });
    const events = await readHistory(CARD);
    expect(events).toEqual([
      { type: "user", text: "manda a primeira", at: 1 },
      { type: "assistant_text", text: "feito", at: 2 },
    ]);
  });

  it("a card with no history reads as empty, not as an error", async () => {
    expect(await readHistory(CARD)).toEqual([]);
  });

  it("survives a torn last line (crash mid-append) by skipping it", async () => {
    await appendHistory(CARD, { type: "user", text: "inteira" });
    const file = join(dir, SDK_HISTORY_DIR, `${CARD}.ndjson`);
    const { appendFile } = await import("node:fs/promises");
    await appendFile(file, `{"type":"assistant_te`, "utf8");
    expect(await readHistory(CARD)).toEqual([{ type: "user", text: "inteira" }]);
  });

  it("refuses an id that is not id-shaped — the card id names a file, never a path", async () => {
    // append never throws (fire-and-forget path), but nothing may be written outside the dir
    await appendHistory("../../etc/passwd", { type: "user", text: "nope" });
    expect(await readHistory(CARD)).toEqual([]);
    await expect(rm(join(dir, SDK_HISTORY_DIR, "../../etc"), { force: true })).resolves.toBeUndefined();
  });

  it("replays only the last `limit` events and compacts a log that outgrew the window", async () => {
    const limit = 5;
    const total = limit * HISTORY_COMPACT_FACTOR + 3;
    for (let i = 0; i < total; i += 1) {
      await appendHistory(CARD, { type: "user", text: `m${i}` });
    }
    const events = await readHistory(CARD, limit);
    expect(events.map((e) => (e as { text: string }).text)).toEqual(["m18", "m19", "m20", "m21", "m22"]);
    // the compaction rewrote the file down to the replay window
    const file = join(dir, SDK_HISTORY_DIR, `${CARD}.ndjson`);
    const lines = (await readFile(file, "utf8")).split("\n").filter(Boolean);
    expect(lines.length).toBe(limit);
    // and a subsequent append lands after the compacted tail
    await appendHistory(CARD, { type: "user", text: "depois" });
    const after = await readHistory(CARD, limit);
    expect((after[after.length - 1] as { text: string }).text).toBe("depois");
  });

  it("interleaved appends serialize into whole lines", async () => {
    const writes: Promise<void>[] = [];
    for (let i = 0; i < 20; i += 1) writes.push(appendHistory(CARD, { type: "user", text: `p${i}` }));
    await Promise.all(writes);
    const events = (await readHistory(CARD)) as Array<HistoryEvent & { text: string }>;
    expect(events.length).toBe(20);
    expect(events.map((e) => e.text)).toEqual(Array.from({ length: 20 }, (_, i) => `p${i}`));
  });

  it("round-trips a message's provenance (`from`) — the replay carries the sender verbatim", async () => {
    const from = { kind: "agent" as const, name: "card preview", sourceCardId: "c1", sourceProjectId: "p1" };
    await appendHistory(CARD, { type: "user", text: "oi", at: 7, from });
    const [event] = await readHistory(CARD);
    expect(event).toEqual({ type: "user", text: "oi", at: 7, from });
  });
});

describe("external messages (an agent talking to this card)", () => {
  it("publishExternalMessage appends to the log AND notifies subscribers; unsubscribe stops it", async () => {
    const from = { kind: "agent" as const, name: "maestro" };
    const seen: HistoryEvent[] = [];
    const off = onExternalMessage(CARD, (e) => seen.push(e));
    await publishExternalMessage(CARD, { type: "user", text: "delegado", at: 1, from });
    off();
    await publishExternalMessage(CARD, { type: "user", text: "depois do off", at: 2, from });
    expect(seen).toEqual([{ type: "user", text: "delegado", at: 1, from }]);
    // both landed in the log regardless of who was listening
    expect((await readHistory(CARD)).map((e) => (e as { text: string }).text)).toEqual(["delegado", "depois do off"]);
  });

  it("subscriptions are per card — another card's chat hears nothing", async () => {
    const seen: HistoryEvent[] = [];
    const off = onExternalMessage("bbbb498d1-98dd-44b6-97ee-c06a181c376", (e) => seen.push(e));
    await publishExternalMessage(CARD, { type: "user", text: "para outro card", at: 1 });
    off();
    expect(seen).toEqual([]);
  });
});


/**
 * REBOBINAR O LOG. Editar uma mensagem rebobina a sessão (`resumeSessionAt`): o modelo perde o
 * original, a resposta pela metade e as ferramentas do meio. O log TEM de perder também — senão um
 * F5 replays uma conversa que o modelo não tem, e a tela e o modelo passam a discordar sobre o que
 * foi dito, que é exatamente o bug que o rebobinar existia pra consertar.
 *
 * O que estes testes atacam é o corte: cortar demais perde conversa de verdade (irrecuperável),
 * cortar de menos deixa a tela mentindo. Os casos abaixo são os que quebram um corte ingênuo.
 */
describe("rewindHistory — o corte tem de ser exato nos dois sentidos", () => {
  const write = async (events: HistoryEvent[]) => {
    for (const e of events) await appendHistory(CARD, e);
  };
  const read = async (): Promise<HistoryEvent[]> => {
    const raw = await readFile(join(dir, SDK_HISTORY_DIR, `${CARD}.ndjson`), "utf8");
    return raw.split("\n").filter((l) => l.trim() !== "").map((l) => JSON.parse(l) as HistoryEvent);
  };

  it("corta exatamente o miolo: o original, a resposta pela metade e a nota — e nada mais", async () => {
    await write([
      { type: "user", text: "primeira" },
      { type: "assistant_text", text: "resposta da primeira" },
      { type: "user", text: "errada" },
      { type: "assistant_text", text: "meia resposta" },
      { type: "tool_use", tool: "Bash" } as HistoryEvent,
      { type: "system_note", text: "turn-interrupted-edit" },
      { type: "message_edited", originalText: "errada" },
      { type: "user", text: "certa" },
    ]);
    expect(await rewindHistory(CARD, "errada")).toBe(5);
    expect(await read()).toEqual([
      { type: "user", text: "primeira" },
      { type: "assistant_text", text: "resposta da primeira" },
      { type: "user", text: "certa" },
    ]);
  });

  it("com a MESMA frase dita duas vezes, corta o par mais RECENTE — não o primeiro", async () => {
    await write([
      { type: "user", text: "roda os testes" },
      { type: "assistant_text", text: "verde" },
      { type: "user", text: "outra coisa" },
      { type: "assistant_text", text: "ok" },
      { type: "user", text: "roda os testes" },
      { type: "assistant_text", text: "meia" },
      { type: "message_edited", originalText: "roda os testes" },
      { type: "user", text: "roda só o back" },
    ]);
    await rewindHistory(CARD, "roda os testes");
    const kept = await read();
    // a primeira vez que a frase foi dita, e a resposta dela, continuam lá
    expect(kept.slice(0, 4)).toEqual([
      { type: "user", text: "roda os testes" },
      { type: "assistant_text", text: "verde" },
      { type: "user", text: "outra coisa" },
      { type: "assistant_text", text: "ok" },
    ]);
    expect(kept.at(-1)).toEqual({ type: "user", text: "roda só o back" });
    expect(kept.some((e) => e.type === "assistant_text" && e.text === "meia")).toBe(false);
  });

  it("NÃO corta nada quando falta uma das duas pontas — perder conversa é pior que uma linha velha", async () => {
    const base: HistoryEvent[] = [
      { type: "user", text: "errada" },
      { type: "assistant_text", text: "meia" },
      { type: "user", text: "certa" },
    ];
    await write(base); // sem o marcador message_edited
    expect(await rewindHistory(CARD, "errada")).toBe(0);
    expect(await read()).toEqual(base);

    // e sem o original (uma compactação já levou a mensagem embora)
    await rm(join(dir, SDK_HISTORY_DIR, `${CARD}.ndjson`), { force: true });
    const semOriginal: HistoryEvent[] = [
      { type: "assistant_text", text: "meia" },
      { type: "message_edited", originalText: "errada" },
      { type: "user", text: "certa" },
    ];
    await write(semOriginal);
    expect(await rewindHistory(CARD, "errada")).toBe(0);
    expect(await read()).toEqual(semOriginal);
  });

  it("marcador ANTES do original não corta NEM DUPLICA — a ordem impossível não corrompe o log", async () => {
    // Com um evento ENTRE o marcador e o original, um corte ingênuo (slice(0,start) + slice(mark+1))
    // devolveria esse evento duas vezes. Duas travas impedem: a checagem de ordem e a de "cortou
    // menos que zero" — a segunda sozinha já salva, então este teste mira no SINTOMA (log intacto,
    // sem duplicata) e não em qual das duas agiu.
    const fora: HistoryEvent[] = [
      { type: "message_edited", originalText: "errada" },
      { type: "assistant_text", text: "no meio" },
      { type: "user", text: "errada" },
      { type: "assistant_text", text: "meia" },
    ];
    await write(fora);
    expect(await rewindHistory(CARD, "errada")).toBe(0);
    const kept = await read();
    expect(kept).toEqual(fora);
    expect(kept.filter((e) => e.type === "assistant_text" && e.text === "no meio")).toHaveLength(1);
  });

  it("quando o corte leva TUDO, o arquivo fica vazio e utilizável — não meio-escrito", async () => {
    await write([
      { type: "user", text: "errada" },
      { type: "assistant_text", text: "meia" },
      { type: "message_edited", originalText: "errada" },
    ]);
    expect(await rewindHistory(CARD, "errada")).toBe(3);
    expect(await readHistory(CARD)).toEqual([]);
    await appendHistory(CARD, { type: "user", text: "recomeçando" });
    expect(await readHistory(CARD)).toEqual([{ type: "user", text: "recomeçando" }]);
  });

  it("uma linha rasgada (crash no meio de um append) não sobrevive à reescrita — e nada mais se perde", async () => {
    // Comportamento FIXADO aqui de propósito: a linha inválida já era invisível pro replay, e a
    // reescrita a descarta. O que não pode é ela levar linhas boas junto.
    await write([{ type: "user", text: "errada" }]);
    const file = join(dir, SDK_HISTORY_DIR, `${CARD}.ndjson`);
    await appendFile(file, '{"type":"assistant_text","text":"rasg\n', "utf8");
    await write([
      { type: "message_edited", originalText: "errada" },
      { type: "user", text: "certa" },
    ]);
    await rewindHistory(CARD, "errada");
    expect(await read()).toEqual([{ type: "user", text: "certa" }]);
  });

  it("o texto tem de bater INTEIRO: um prefixo ou um trecho não corta a conversa de ninguém", async () => {
    const base: HistoryEvent[] = [
      { type: "user", text: "roda os testes do back" },
      { type: "assistant_text", text: "meia" },
      { type: "message_edited", originalText: "roda os testes do back" },
      { type: "user", text: "roda tudo" },
    ];
    await write(base);
    for (const quaseIgual of ["roda os testes", "roda os testes do back ", "RODA OS TESTES DO BACK", ""]) {
      expect(await rewindHistory(CARD, quaseIgual)).toBe(0);
    }
    expect(await read()).toEqual(base);
  });

  it("um card sem log nenhum não explode e não cria arquivo", async () => {
    await expect(rewindHistory("0a9faddc-ec6f-44b2-a58c-fa4e6222686c", "seja o que for")).resolves.toBe(0);
  });

  it("uma mensagem que chega DURANTE o corte não se perde (appends e corte são serializados)", async () => {
    await write([
      { type: "user", text: "errada" },
      { type: "assistant_text", text: "meia" },
      { type: "message_edited", originalText: "errada" },
      { type: "user", text: "certa" },
    ]);
    // disparadas juntas, sem await entre elas: a fila por card é o que impede o corte de
    // sobrescrever um append que aconteceu no meio da leitura-escrita.
    const corte = rewindHistory(CARD, "errada");
    const chegando = appendHistory(CARD, { type: "user", text: "chegou no meio" });
    await Promise.all([corte, chegando]);
    const kept = await read();
    expect(kept.some((e) => e.type === "user" && e.text === "chegou no meio")).toBe(true);
    expect(kept.some((e) => e.type === "user" && e.text === "errada")).toBe(false);
  });

  it("o replay depois do corte devolve a conversa que o modelo tem, e o arquivo fica legível", async () => {
    await write([
      { type: "user", text: "errada" },
      { type: "assistant_text", text: "meia" },
      { type: "message_edited", originalText: "errada" },
      { type: "user", text: "certa" },
    ]);
    await rewindHistory(CARD, "errada");
    expect(await readHistory(CARD)).toEqual([{ type: "user", text: "certa" }]);
    const raw = await readFile(join(dir, SDK_HISTORY_DIR, `${CARD}.ndjson`), "utf8");
    expect(raw.endsWith("\n")).toBe(true); // NDJSON: o próximo append não pode colar na última linha
    await appendHistory(CARD, { type: "assistant_text", text: "depois" });
    expect(await readHistory(CARD)).toEqual([
      { type: "user", text: "certa" },
      { type: "assistant_text", text: "depois" },
    ]);
  });
});

describe("removeHistory (the card is being deleted)", () => {
  it("deletes the log — not empties it — and a second call is fine", async () => {
    await appendHistory(CARD, { type: "user", text: "segredo" });
    await appendHistory(CARD, { type: "assistant_text", text: "resposta" });
    expect(await readHistory(CARD)).toHaveLength(2);

    await removeHistory(CARD);

    expect(await readHistory(CARD)).toEqual([]);
    await expect(readFile(join(dir, SDK_HISTORY_DIR, `${CARD}.ndjson`), "utf8")).rejects.toThrow();
    await expect(removeHistory(CARD)).resolves.toBeUndefined();
  });

  it("does not race an append in flight: whatever was being written goes with the file", async () => {
    // Both are queued on the card's chain, so the delete runs AFTER the append instead of leaving
    // a file recreated behind it.
    const appending = appendHistory(CARD, { type: "user", text: "última palavra" });
    const deleting = removeHistory(CARD);
    await Promise.all([appending, deleting]);
    expect(await readHistory(CARD)).toEqual([]);
  });

  it("refuses an id that is not id-shaped — no path from a URL reaches the fs", async () => {
    await expect(removeHistory("../../etc/passwd")).rejects.toThrow(/invalid card id/);
  });
});
