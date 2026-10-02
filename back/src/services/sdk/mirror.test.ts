import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  MIRROR_DEDUPE_MAX,
  createMirrorState,
  mirrorNewEvents,
  noteDriverEvent,
  noteDriverEventFor,
  driverKeysFor,
  forgetDriverKeys,
} from "./mirror.js";
import { recordOrigin, resetProvenanceCache } from "../chat/provenance.js";
import { config } from "../../config/env.js";

/**
 * THE BUG THIS FILE PINS: with the native chat OPEN, the person switched to the Terminal tab and
 * kept the conversation there — and the native chat never showed a word of it (the "não puxou
 * nada" incident). The mirror follows the card's transcript while a native chat is connected and
 * lifts the NEW lines into the chat; these tests pin what passes and what is deduped.
 */

const CARD = "56fc53c6-ff44-484c-b2c3-e5576b6760e7";

function line(obj: Record<string, unknown>): string {
  return JSON.stringify(obj);
}

const T0 = Date.parse("2026-08-31T21:30:00Z");

function userLine(uuid: string, iso: string, text: string): string {
  return line({ type: "user", uuid, timestamp: iso, message: { content: text } });
}

function assistantLine(uuid: string, iso: string, text: string): string {
  return line({ type: "assistant", uuid, timestamp: iso, message: { content: [{ type: "text", text }] } });
}

let dir = "";
let savedDataDir = "";
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "vibehub-mirror-"));
  savedDataDir = config.dataDir;
  config.dataDir = dir;
  resetProvenanceCache();
});
afterEach(async () => {
  config.dataDir = savedDataDir;
  resetProvenanceCache();
  await rm(dir, { recursive: true, force: true });
});

describe("mirrorNewEvents", () => {
  it("lifts NEW transcript lines as terminal-stamped history events, with their tid and time", () => {
    const state = createMirrorState(T0);
    const out = mirrorNewEvents(state, [
      userLine("u1", "2026-08-31T21:31:00Z", "ok boa como a gnt segue?"),
      assistantLine("a1", "2026-08-31T21:31:30Z", "Seguimos assim…"),
    ].join("\n"), CARD);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ type: "user", text: "ok boa como a gnt segue?", source: "terminal", tid: "u1" });
    expect(out[1]).toMatchObject({ type: "assistant_text", text: "Seguimos assim…", source: "terminal", tid: "a1#t" });
    expect(out[0]!.at).toBe(Date.parse("2026-08-31T21:31:00Z"));
  });

  it("drops the follow loop's initial tail — everything at or before the cutoff was replayed", () => {
    const state = createMirrorState(T0);
    const out = mirrorNewEvents(state, [
      userLine("old", "2026-08-31T21:29:00Z", "mensagem antiga"),
      userLine("new", "2026-08-31T21:31:00Z", "mensagem nova"),
    ].join("\n"), CARD);
    expect(out.map((e) => ("text" in e ? e.text : e.type))).toEqual(["mensagem nova"]);
  });

  it("each transcript id passes exactly once (tail -F re-prints when the newest file changes)", () => {
    const state = createMirrorState(T0);
    const chunk = userLine("u1", "2026-08-31T21:31:00Z", "oi");
    expect(mirrorNewEvents(state, chunk, CARD)).toHaveLength(1);
    expect(mirrorNewEvents(state, chunk, CARD)).toHaveLength(0);
  });

  it("pre-seeded ids (the connect replay's tids) never come around again", () => {
    const state = createMirrorState(T0, ["u1"]);
    expect(mirrorNewEvents(state, userLine("u1", "2026-08-31T21:31:00Z", "oi"), CARD)).toHaveLength(0);
  });

  it("comando de barra mandado pelo chat NÃO volta do transcript como mensagem nova", () => {
    // O INCIDENTE (produção, 02/10/2026): a pessoa mandou "/systematic-debugging …" pelo chat
    // nativo e viu a MESMA mensagem duas vezes. O Claude Code reescreve o comando para a forma
    // qualificada do plugin antes de gravar no transcript, e o dedupe comparava texto literal.
    const state = createMirrorState(T0);
    noteDriverEvent(state, { type: "user", text: "/systematic-debugging apaga cards de 180 dias" });
    const out = mirrorNewEvents(
      state,
      userLine("u9", "2026-08-31T21:31:00Z", "/superpowers:systematic-debugging apaga cards de 180 dias"),
      CARD,
    );
    expect(out).toHaveLength(0);
  });

  it("what the DRIVER already said on stdout is not mirrored back from the transcript", () => {
    const state = createMirrorState(T0);
    noteDriverEvent(state, { type: "user", text: "roda os testes" });
    noteDriverEvent(state, { type: "tool_use", id: "toolu_9", name: "Bash", input: { command: "npm test" } });
    noteDriverEvent(state, { type: "assistant_text", text: "Tudo verde." });
    const out = mirrorNewEvents(state, [
      userLine("u5", "2026-08-31T21:31:00Z", "roda os testes"),
      line({
        type: "assistant", uuid: "a5", timestamp: "2026-08-31T21:31:05Z",
        message: { content: [{ type: "tool_use", id: "toolu_9", name: "Bash", input: { command: "npm test" } }] },
      }),
      assistantLine("a6", "2026-08-31T21:31:10Z", "Tudo verde."),
      assistantLine("a7", "2026-08-31T21:31:20Z", "E uma frase só da TUI."),
    ].join("\n"), CARD);
    expect(out.map((e) => ("text" in e ? e.text : e.type))).toEqual(["E uma frase só da TUI."]);
  });

  it("attaches provenance to a mirrored user message when the log knows the sender", () => {
    const at = Date.parse("2026-08-31T21:31:00Z");
    recordOrigin(CARD, "mensagem do alex", { kind: "user", name: "alex" }, at);
    const state = createMirrorState(T0);
    const out = mirrorNewEvents(state, userLine("u1", "2026-08-31T21:31:00Z", "mensagem do alex"), CARD);
    expect(out[0]).toMatchObject({ type: "user", from: { kind: "user", name: "alex" } });
  });

  it("system notes are not part of the conversation being mirrored", () => {
    const state = createMirrorState(T0);
    const out = mirrorNewEvents(
      state,
      userLine("s1", "2026-08-31T21:31:00Z", "[SYSTEM NOTIFICATION - NOT USER INPUT] <task-notification><summary>done</summary></task-notification>"),
      CARD,
    );
    expect(out).toHaveLength(0);
  });
});

describe("noteDriverEvent", () => {
  it("keeps the dedupe memory bounded — the oldest keys fall off", () => {
    const state = createMirrorState(T0);
    for (let i = 0; i < MIRROR_DEDUPE_MAX + 10; i += 1) {
      noteDriverEvent(state, { type: "assistant_text", text: `frase ${i}` });
    }
    expect(state.driverKeys.size).toBe(MIRROR_DEDUPE_MAX);
    expect(state.driverKeys.has("assistant_text:frase 0")).toBe(false);
    expect(state.driverKeys.has(`assistant_text:frase ${MIRROR_DEDUPE_MAX + 9}`)).toBe(true);
  });

  it("ignores events that have no dedupe key (ready, session, results)", () => {
    const state = createMirrorState(T0);
    noteDriverEvent(state, { type: "ready" } as never);
    expect(state.driverKeys.size).toBe(0);
  });
});

/**
 * O BUG DO CÉSAR (produção, 2026-09-28): depois de um deploy, a mensagem de sistema "Continue de
 * onde parou" aparecia DUAS VEZES — uma como `Sistema (vibehub)` e outra como bolha, precedida de
 * "Atividade no terminal — a conversa seguiu na aba Terminal".
 *
 * A segunda cópia é o ESPELHO do transcript. Toda mensagem entregue ao driver é reportada em
 * `noteDriverEventFor` justamente para o espelho reconhecê-la quando ela voltar pelo arquivo — só
 * que esse registro era um NO-OP quando não havia espelho vivo, e o espelho só nasce no primeiro
 * connect de um chat. O sweep de boot (`resumeInterruptedTurns`, disparado logo após o `listen`)
 * injeta o turno de retomada quando nenhum browser conectou ainda: a chave era jogada fora, o
 * espelho nascia com a memória vazia, e a linha que o CLI escreveu no transcript passava como se
 * fosse conversa nova.
 *
 * A vida dessas chaves é a do DRIVER, não a do espelho: o que foi entregue ao driver segue tendo
 * sido entregue, com ou sem alguém olhando. Elas moram por CARD e o espelho as adota ao nascer.
 */
describe("a memória de dedupe sobrevive ao espelho (a mensagem de sistema duplicada do deploy)", () => {
  const RESUME = "Continue de onde parou: o processo anterior foi interrompido por um reinício do servidor do painel (deploy). Retome a tarefa em andamento e conclua o que estava fazendo.";

  beforeEach(() => forgetDriverKeys(CARD));
  afterEach(() => forgetDriverKeys(CARD));

  it("reportada SEM espelho vivo, a chave não se perde: o espelho que nascer depois já a conhece", () => {
    // o sweep de boot entrega o turno ao driver — nenhum chat conectado, nenhum espelho existe
    noteDriverEventFor(CARD, { type: "user", text: RESUME });

    // só AGORA alguém abre o card: o espelho nasce e adota o que o driver já foi mandado fazer
    const state = createMirrorState(T0, [], driverKeysFor(CARD));
    const out = mirrorNewEvents(
      state,
      userLine("u-resume", new Date(T0 + 5_000).toISOString(), RESUME),
      CARD,
    );

    expect(out).toEqual([]); // nada a espelhar: essa fala já está na conversa
  });

  it("sem a adoção o duplicado apareceria — é exatamente essa a diferença", () => {
    noteDriverEventFor(CARD, { type: "user", text: RESUME });

    const cego = createMirrorState(T0); // um espelho que nasce de memória vazia
    const out = mirrorNewEvents(cego, userLine("u-resume", new Date(T0 + 5_000).toISOString(), RESUME), CARD);

    expect(out).toHaveLength(1); // a segunda cópia da print
    expect(out[0]!.source).toBe("terminal");
  });

  it("o que o driver é mandado fazer COM espelho vivo continua sendo deduplicado", () => {
    const state = createMirrorState(T0, [], driverKeysFor(CARD));
    noteDriverEventFor(CARD, { type: "user", text: "roda os testes" });

    const out = mirrorNewEvents(state, userLine("u1", new Date(T0 + 1_000).toISOString(), "roda os testes"), CARD);

    expect(out).toEqual([]);
  });

  it("um card esquecido começa do zero — a memória não vaza entre cards nem para sempre", () => {
    noteDriverEventFor(CARD, { type: "user", text: RESUME });
    expect(driverKeysFor(CARD).size).toBe(1);
    forgetDriverKeys(CARD);
    expect(driverKeysFor(CARD).size).toBe(0);
  });
});
