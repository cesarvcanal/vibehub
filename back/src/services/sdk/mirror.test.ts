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
  onOutsideTurn,
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
    // THE INCIDENT (production, 02/10/2026): the person sent "/systematic-debugging …" through the native
    // chat and saw the SAME message twice. Claude Code rewrites the command to the plugin's qualified
    // form before writing to the transcript, and the dedupe compared literal text.
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
 * CÉSAR'S BUG (production, 2026-09-28): after a deploy, the system message "Continue de
 * onde parou" showed up TWICE — once as `Sistema (vibehub)` and once as a bubble, preceded by
 * "Atividade no terminal — a conversa seguiu na aba Terminal".
 *
 * The second copy is the transcript's MIRROR. Every message delivered to the driver is reported in
 * `noteDriverEventFor` precisely so the mirror recognises it when it comes back through the file — except
 * that this registration was a NO-OP when there was no live mirror, and the mirror is only born on a chat's first
 * connect. The boot sweep (`resumeInterruptedTurns`, fired right after `listen`)
 * injects the resume turn when no browser has connected yet: the key was thrown away, the
 * mirror was born with an empty memory, and the line the CLI wrote in the transcript passed as if it
 * were new conversation.
 *
 * The lifetime of these keys is the DRIVER's, not the mirror's: what was delivered to the driver has still
 * been delivered, with or without someone watching. They live per CARD and the mirror adopts them when it is born.
 */
describe("a memória de dedupe sobrevive ao espelho (a mensagem de sistema duplicada do deploy)", () => {
  const RESUME = "Continue de onde parou: o processo anterior foi interrompido por um reinício do servidor do painel (deploy). Retome a tarefa em andamento e conclua o que estava fazendo.";

  beforeEach(() => forgetDriverKeys(CARD));
  afterEach(() => forgetDriverKeys(CARD));

  it("reportada SEM espelho vivo, a chave não se perde: o espelho que nascer depois já a conhece", () => {
    // the boot sweep delivers the turn to the driver — no chat connected, no mirror exists
    noteDriverEventFor(CARD, { type: "user", text: RESUME });

    // only NOW does someone open the card: the mirror is born and adopts what the driver was already told to do
    const state = createMirrorState(T0, [], driverKeysFor(CARD));
    const out = mirrorNewEvents(
      state,
      userLine("u-resume", new Date(T0 + 5_000).toISOString(), RESUME),
      CARD,
    );

    expect(out).toEqual([]); // nothing to mirror: that speech is already in the conversation
  });

  it("sem a adoção o duplicado apareceria — é exatamente essa a diferença", () => {
    noteDriverEventFor(CARD, { type: "user", text: RESUME });

    const cego = createMirrorState(T0); // a mirror born from an empty memory
    const out = mirrorNewEvents(cego, userLine("u-resume", new Date(T0 + 5_000).toISOString(), RESUME), CARD);

    expect(out).toHaveLength(1); // the screenshot's second copy
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

/**
 * THE NOTICE THAT PREVENTS THE DEAD BRANCH (production, 2026-10-05).
 *
 * The mirror is the only one that sees conversation coming in through ANOTHER CLI process (the Terminal tab, in the
 * SAME session). The chat's driver keeps the conversation in memory while the stream is open: without
 * this notice its next message continues from a stale point and leaves the terminal's turn orphaned —
 * and an orphaned turn is not on the transcript's live branch, so editing that message did not rewind.
 */
describe("o espelho avisa quando a conversa anda FORA do chat", () => {
  const CARD_OUT = "card-fora";
  const falaNoTerminal = (tid: string, texto: string): string => userLine(tid, "2026-08-31T21:31:00Z", texto);

  it("uma mensagem de usuário vinda do transcript acorda os inscritos daquele card", () => {
    let avisos = 0;
    const off = onOutsideTurn(CARD_OUT, () => { avisos += 1; });
    const state = createMirrorState(T0);
    mirrorNewEvents(state, falaNoTerminal("t1", "oi pelo terminal"), CARD_OUT);
    off();
    expect(avisos).toBe(1);
  });

  it("cancelar a inscrição realmente cala: um driver morto não pode ser escrito", () => {
    let avisos = 0;
    const off = onOutsideTurn(CARD_OUT, () => { avisos += 1; });
    off();
    const state = createMirrorState(T0);
    mirrorNewEvents(state, falaNoTerminal("t2", "depois do adeus"), CARD_OUT);
    expect(avisos).toBe(0);
  });

  it("o aviso é POR CARD: o terminal de um card não religa o chat de outro", () => {
    let outro = 0;
    const off = onOutsideTurn("card-vizinho", () => { outro += 1; });
    const state = createMirrorState(T0);
    mirrorNewEvents(state, falaNoTerminal("t3", "no meu card"), CARD_OUT);
    off();
    expect(outro).toBe(0);
  });

  it("o que o PRÓPRIO chat mandou não conta como conversa de fora — senão religaria a cada turno", () => {
    let avisos = 0;
    const off = onOutsideTurn(CARD_OUT, () => { avisos += 1; });
    const state = createMirrorState(T0);
    noteDriverEvent(state, { type: "user", text: "fui eu pelo chat" });
    mirrorNewEvents(state, falaNoTerminal("t4", "fui eu pelo chat"), CARD_OUT);
    off();
    expect(avisos).toBe(0);
  });

  it("o resumo da auto-compactação NÃO é conversa de fora — senão o CLI vivo cai e a próxima mensagem sobe outro do zero", () => {
    // Real shape: after the `compact_boundary` the CLI writes the summary as a `type:"user"` line marked
    // `isCompactSummary`. Nobody typed that; treated as terminal speech, it became a giant bubble
    // and fired the reanchor, which knocks down the driver's stream.
    let avisos = 0;
    const off = onOutsideTurn(CARD_OUT, () => { avisos += 1; });
    const state = createMirrorState(T0);
    const resumo = line({
      type: "user",
      uuid: "sum1",
      timestamp: "2026-08-31T21:31:00Z",
      isSidechain: false,
      isCompactSummary: true,
      isVisibleInTranscriptOnly: true,
      message: { role: "user", content: "This session is being continued from a previous conversation..." },
    });
    const out = mirrorNewEvents(state, resumo, CARD_OUT);
    off();
    expect(out).toEqual([]);
    expect(avisos).toBe(0);
  });

  it("um ouvinte que explode não derruba o espelho — a conversa na tela vale mais que o aviso", () => {
    const off1 = onOutsideTurn(CARD_OUT, () => { throw new Error("ouvinte quebrado"); });
    let depois = 0;
    const off2 = onOutsideTurn(CARD_OUT, () => { depois += 1; });
    const state = createMirrorState(T0);
    const out = mirrorNewEvents(state, falaNoTerminal("t5", "sobrevive"), CARD_OUT);
    off1(); off2();
    expect(depois).toBe(1);
    expect(out).toHaveLength(1);
  });
});
