import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { HistoryEvent } from "./history.js";

/**
 * O RUNTIME DO ESPELHO — o processo de follow por card, não a filtragem pura (essa está em
 * mirror.test.ts). Aqui o `spawn` é um dublê: o que se testa é o que o espelho faz com os bytes que
 * o follow entrega, com a morte dele e com a memória de dedupe do card ao longo da vida do driver.
 */

const CARD = "77fc53c6-ff44-484c-b2c3-e5576b6760e7";
const T0 = Date.parse("2026-08-31T21:30:00Z");

interface FakeFollow extends EventEmitter {
  stdout: EventEmitter;
  stdin: EventEmitter & { end: () => void };
  kill: () => void;
  killed: boolean;
}

const h = vi.hoisted(() => ({
  spawned: [] as unknown[],
  published: [] as unknown[],
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: () => {
      const child = new EventEmitter() as FakeFollow;
      child.stdout = new EventEmitter();
      const stdin = new EventEmitter() as FakeFollow["stdin"];
      stdin.end = () => undefined;
      child.stdin = stdin;
      child.killed = false;
      child.kill = () => { child.killed = true; };
      h.spawned.push(child);
      return child;
    },
  };
});
vi.mock("../chat/chat.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../chat/chat.js")>();
  return { ...actual, chatSource: (cardId: string) => Promise.resolve({ cardId, command: { file: "docker", args: ["exec"] } }) };
});
vi.mock("../chat/provenance.js", () => ({
  primeProvenance: () => Promise.resolve(),
  matchOrigin: () => undefined,
}));
vi.mock("./history.js", () => ({
  publishExternalMessage: (_cardId: string, event: unknown) => { h.published.push(event); return Promise.resolve(); },
}));

const { acquireTranscriptMirror, forgetDriverKeys, noteDriverEventFor, resetMirrors, stopAllMirrors } = await import("./mirror.js");

function follow(i: number): FakeFollow {
  const child = h.spawned[i] as FakeFollow | undefined;
  if (!child) throw new Error(`no follow process #${i}`);
  return child;
}

function userLine(uuid: string, at: number, text: string): string {
  return JSON.stringify({ type: "user", uuid, timestamp: new Date(at).toISOString(), message: { content: text } }) + "\n";
}

function publishedTexts(): string[] {
  return (h.published as HistoryEvent[]).map((e) => (e as { text?: string }).text ?? "");
}

beforeEach(() => {
  h.spawned = [];
  h.published = [];
});
afterEach(() => {
  resetMirrors();
});

describe("acquireTranscriptMirror — o que o follow entrega", () => {
  it("um caractere multibyte partido entre dois chunks chega inteiro (nada de U+FFFD)", async () => {
    await acquireTranscriptMirror(CARD, { cutoffAt: T0 });
    const bytes = Buffer.from(userLine("u1", T0 + 1_000, "ação"));
    const cut = bytes.indexOf(Buffer.from("ç")) + 1;
    follow(0).stdout.emit("data", bytes.subarray(0, cut));
    follow(0).stdout.emit("data", bytes.subarray(cut));
    expect(publishedTexts()).toEqual(["ação"]);
  });

  it("uma linha de MB em muitos chunks custa linear: o \\n é procurado só no pedaço novo", async () => {
    await acquireTranscriptMirror(CARD, { cutoffAt: T0 });
    // Um tool_result de vários MB no transcript, entregue pelo follow em chunks de 1 KB.
    const big = "x".repeat(4 * 1024 * 1024);
    const bytes = Buffer.from(userLine("u-big", T0 + 1_000, big));
    const started = performance.now();
    for (let i = 0; i < bytes.length; i += 1024) follow(0).stdout.emit("data", bytes.subarray(i, i + 1024));
    const elapsed = performance.now() - started;
    expect(publishedTexts()).toEqual([big]);
    expect(elapsed).toBeLessThan(1500);
  });
});

describe("acquireTranscriptMirror — o follow que falha não derruba o back", () => {
  it("um 'error' assíncrono do spawn (EAGAIN, EMFILE) vira log, não exceção não tratada", async () => {
    await acquireTranscriptMirror(CARD, { cutoffAt: T0 });
    expect(() => follow(0).emit("error", new Error("spawn EAGAIN"))).not.toThrow();
  });

  it("o EPIPE do stdin.end() num follow já morto também não", async () => {
    const release = await acquireTranscriptMirror(CARD, { cutoffAt: T0 });
    release();
    expect(() => follow(0).stdin.emit("error", new Error("write EPIPE"))).not.toThrow();
  });
});

describe("acquireTranscriptMirror — o follow que morreu sozinho volta no próximo connect", () => {
  it("com outra aba segurando o espelho, um connect novo sobe o follow de novo", async () => {
    await acquireTranscriptMirror(CARD, { cutoffAt: T0 });
    follow(0).emit("close"); // runner reiniciado, reaper: o follow acabou, a aba antiga segue aberta
    await acquireTranscriptMirror(CARD, { cutoffAt: T0 });
    expect(h.spawned.length).toBe(2);
    follow(1).stdout.emit("data", Buffer.from(userLine("u-volta", T0 + 1_000, "voltou")));
    expect(publishedTexts()).toEqual(["voltou"]);
  });

  it("o que a aba nova JÁ desenhou no replay não volta pelo follow novo", async () => {
    await acquireTranscriptMirror(CARD, { cutoffAt: T0 });
    follow(0).emit("close");
    await acquireTranscriptMirror(CARD, { cutoffAt: T0, seenIds: ["u-replay"] });
    follow(1).stdout.emit("data", Buffer.from(userLine("u-replay", T0 + 1_000, "já na tela")));
    expect(publishedTexts()).toEqual([]);
  });

  it("dois connects simultâneos ainda sobem UM follow só (o primeiro ainda está subindo)", async () => {
    await Promise.all([
      acquireTranscriptMirror(CARD, { cutoffAt: T0 }),
      acquireTranscriptMirror(CARD, { cutoffAt: T0 }),
    ]);
    expect(h.spawned.length).toBe(1);
  });
});

describe("acquireTranscriptMirror — a memória de dedupe ao longo da vida do driver", () => {
  it("o driver morre e outro sobe com o espelho vivo: a fala do SUCESSOR não volta como 'terminal'", async () => {
    await acquireTranscriptMirror(CARD, { cutoffAt: T0 });
    // O driver velho acabou: a memória dele vai junto (manager.ts, no close do processo)...
    forgetDriverKeys(CARD);
    // ...e o sucessor manda a mensagem da pessoa. O espelho, que nasceu antes, tem de reconhecê-la.
    noteDriverEventFor(CARD, { type: "user", text: "oi do sucessor" });
    follow(0).stdout.emit("data", Buffer.from(userLine("u-suc", T0 + 1_000, "oi do sucessor")));
    expect(publishedTexts()).toEqual([]);
  });
});

/**
 * O SHUTDOWN DE UM DEPLOY BLUE/GREEN: o processo antigo larga o card para o novo retomar o turno. Um
 * espelho que seguisse vivo até o exit lia a fala de retomada que o processo NOVO injetou — fala que
 * a memória deste processo nunca viu — e a gravava como conversa do terminal (a bolha duplicada da
 * print de 2026-10-08). Antes de largar, os espelhos param.
 */
describe("stopAllMirrors — o espelho do processo que está saindo", () => {
  it("mata o follow, e o que chegar depois não é publicado", async () => {
    await acquireTranscriptMirror(CARD, { cutoffAt: T0 });
    stopAllMirrors();

    expect(follow(0).killed).toBe(true);
    follow(0).stdout.emit("data", Buffer.from(userLine("u-novo", T0 + 1_000, "Continue de onde parou")));
    expect(publishedTexts()).toEqual([]);
  });
});

describe("acquireTranscriptMirror — quem solta é o espelho que pegou", () => {
  it("o release de uma aba de um espelho já parado não derruba o espelho que nasceu depois", async () => {
    const releaseVelho = await acquireTranscriptMirror(CARD, { cutoffAt: T0 });
    stopAllMirrors();
    await acquireTranscriptMirror(CARD, { cutoffAt: T0 }); // uma aba que conectou depois do stop

    releaseVelho(); // a aba antiga fecha agora
    expect(follow(1).killed).toBe(false);
  });

  it("um 'error' do follow não cala as linhas que ele ainda entrega", async () => {
    await acquireTranscriptMirror(CARD, { cutoffAt: T0 });
    follow(0).emit("error", new Error("kill falhou"));
    follow(0).stdout.emit("data", Buffer.from(userLine("u-tarde", T0 + 1_000, "oi do terminal")));
    expect(publishedTexts()).toEqual(["oi do terminal"]);
  });
});
