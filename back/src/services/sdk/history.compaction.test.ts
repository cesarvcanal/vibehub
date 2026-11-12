import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "../../config/env.js";

/**
 * COMPACTION MUST NOT ERASE WHAT ARRIVED DURING IT.
 *
 * `readHistory` reads the log and, if it went past the cap, rewrites it with only the tail. The read
 * happened OUTSIDE the append queue and the rewrite INSIDE it: everything that entered the queue
 * between the two (the driver's response arriving while someone opens the card) was overwritten by
 * a tail computed earlier — the message vanished from the log, and an already applied
 * `rewindHistory` was undone.
 *
 * The window is microseconds with a real disk, so the test opens it on purpose: a hook in
 * `readFile` fires the append right after the compaction's read has finished.
 */

const h = vi.hoisted(() => ({ afterRead: null as null | (() => void), tornWrites: false, failReads: false }));

/**
 * A write that dies MIDWAY (OOM, the deploy's SIGKILL): half the bytes reach the file that was
 * being written and the call never returns. It holds for both ways of writing a whole file — the
 * module function and the `writeFile` of an open FileHandle.
 */
async function tornWrite(write: (data: string) => Promise<void>, data: unknown): Promise<never> {
  const text = String(data);
  await write(text.slice(0, Math.floor(text.length / 2)));
  throw new Error("killed mid-write");
}

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    writeFile: async (...args: Parameters<typeof actual.writeFile>) => {
      if (!h.tornWrites) return await actual.writeFile(...args);
      return await tornWrite((half) => actual.writeFile(args[0], half, "utf8"), args[1]);
    },
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      if (h.tornWrites) {
        const write = handle.writeFile.bind(handle);
        handle.writeFile = (data: unknown) => tornWrite((half) => write(half, "utf8"), data);
      }
      return handle;
    },
    readFile: async (...args: Parameters<typeof actual.readFile>) => {
      if (h.failReads) throw Object.assign(new Error("too many open files"), { code: "EMFILE" });
      const out = await actual.readFile(...args);
      const hook = h.afterRead;
      h.afterRead = null;
      hook?.();
      return out;
    },
  };
});

const { appendHistory, readHistory, rewindHistory, unwrapEditedMessage, clearHistoryBeforeLastClear, HISTORY_COMPACT_FACTOR } = await import("./history.js");

const CARD = "abc498d1-98dd-44b6-97ee-c06a181c3769";

let dir = "";
let savedDataDir = "";

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "vibehub-sdk-history-compact-"));
  savedDataDir = config.dataDir;
  config.dataDir = dir;
  h.afterRead = null;
  h.tornWrites = false;
  h.failReads = false;
});
afterEach(async () => {
  config.dataDir = savedDataDir;
  await rm(dir, { recursive: true, force: true });
});

describe("readHistory — compactação serializada com os appends", () => {
  it("um append que entra na fila durante a compactação sobrevive à reescrita", async () => {
    const limit = 2;
    for (let i = 0; i < limit * HISTORY_COMPACT_FACTOR + 1; i += 1) {
      await appendHistory(CARD, { type: "assistant_text", text: `velha ${i}` });
    }
    let late: Promise<void> = Promise.resolve();
    h.afterRead = () => { late = appendHistory(CARD, { type: "user", text: "chegou no meio" }); };
    await readHistory(CARD, limit);
    await late;

    const after = await readHistory(CARD, 100);
    expect(after.map((e) => (e as { text?: string }).text)).toContain("chegou no meio");
  });
});

describe("reescrita do log interrompida no meio", () => {
  it("a compactação que morre no meio deixa o log inteiro como estava", async () => {
    const limit = 2;
    const total = limit * HISTORY_COMPACT_FACTOR + 1;
    for (let i = 0; i < total; i += 1) {
      await appendHistory(CARD, { type: "assistant_text", text: `mensagem ${i}` });
    }
    h.tornWrites = true;
    await readHistory(CARD, limit).catch(() => undefined);
    h.tornWrites = false;

    const after = await readHistory(CARD, 100);
    expect(after).toHaveLength(total);
  });

  it("o rewind de uma edição que morre no meio deixa o log inteiro como estava", async () => {
    await appendHistory(CARD, { type: "user", text: "errada" });
    await appendHistory(CARD, { type: "assistant_text", text: "meia resposta" });
    await appendHistory(CARD, { type: "message_edited", originalText: "errada" });
    await appendHistory(CARD, { type: "user", text: "certa" });
    h.tornWrites = true;
    await rewindHistory(CARD, "errada").catch(() => undefined);
    h.tornWrites = false;

    expect(await readHistory(CARD, 100)).toHaveLength(4);
  });

  it("o /clear que morre no meio deixa o log inteiro como estava", async () => {
    await appendHistory(CARD, { type: "user", text: "antes" });
    await appendHistory(CARD, { type: "assistant_text", text: "resposta de antes" });
    await appendHistory(CARD, { type: "user", text: "/clear" });
    h.tornWrites = true;
    await clearHistoryBeforeLastClear(CARD).catch(() => undefined);
    h.tornWrites = false;

    expect(await readHistory(CARD, 100)).toHaveLength(3);
  });
});

/**
 * A REWRITE THAT FAILED MUST NOT CLAIM TO BE DONE. `rewindHistory` counted the cut before
 * writing and `unwrapEditedMessage` marked the swap before writing; the queue swallowed the error (with
 * the compaction's message). The manager logged "dropped N", the screen had already cut the lines, and the
 * next F5 brought back the conversation the rewind had taken out.
 */
describe("reescrita do log que falha chega ao chamador", () => {
  const conversaEditada = async () => {
    await appendHistory(CARD, { type: "user", text: "errada" });
    await appendHistory(CARD, { type: "assistant_text", text: "resposta" });
    await appendHistory(CARD, { type: "message_edited", originalText: "errada" });
    await appendHistory(CARD, { type: "user", text: "certa", sent: "[invólucro]" } as never);
  };

  it("o rewind rejeita, o log fica inteiro, e a fila segue gravando depois da falha", async () => {
    await conversaEditada();
    h.tornWrites = true;
    await expect(rewindHistory(CARD, "errada", "certa")).rejects.toThrow("killed mid-write");
    h.tornWrites = false;
    expect(await readHistory(CARD, 100)).toHaveLength(4);

    await appendHistory(CARD, { type: "assistant_text", text: "depois da falha" });
    expect((await readHistory(CARD, 100)).at(-1)).toEqual({ type: "assistant_text", text: "depois da falha" });
    // And the queue's next rewrite works: the cut that failed can be redone.
    await expect(rewindHistory(CARD, "errada", "certa")).resolves.toBe(3);
  });

  it("o unwrap rejeita e o invólucro continua no arquivo", async () => {
    await conversaEditada();
    h.tornWrites = true;
    await expect(unwrapEditedMessage(CARD, "errada", "certa")).rejects.toThrow("killed mid-write");
    h.tornWrites = false;
    expect((await readHistory(CARD, 100)).at(-1)).toMatchObject({ sent: "[invólucro]" });
    await expect(unwrapEditedMessage(CARD, "errada", "certa")).resolves.toBe(true);
  });

  it("o corte do /clear rejeita e nada sai do log", async () => {
    await appendHistory(CARD, { type: "user", text: "antes" });
    await appendHistory(CARD, { type: "user", text: "/clear" });
    h.tornWrites = true;
    await expect(clearHistoryBeforeLastClear(CARD)).rejects.toThrow("killed mid-write");
    h.tornWrites = false;
    expect(await readHistory(CARD, 100)).toHaveLength(2);
  });

  it("um log que existe mas não pôde ser LIDO não vira \"nada a cortar\"", async () => {
    await conversaEditada();
    h.failReads = true;
    await expect(rewindHistory(CARD, "errada", "certa")).rejects.toThrow("too many open files");
    await expect(unwrapEditedMessage(CARD, "errada", "certa")).rejects.toThrow("too many open files");
    await expect(clearHistoryBeforeLastClear(CARD)).rejects.toThrow("too many open files");
    h.failReads = false;
    await expect(rewindHistory(CARD, "errada", "certa")).resolves.toBe(3);
  });

  it("a compactação que falha continua sem derrubar a leitura: o replay sai igual", async () => {
    const limit = 2;
    for (let i = 0; i < limit * HISTORY_COMPACT_FACTOR + 1; i += 1) {
      await appendHistory(CARD, { type: "assistant_text", text: `m${i}` });
    }
    h.tornWrites = true;
    const replay = await readHistory(CARD, limit);
    h.tornWrites = false;
    expect(replay.map((e) => (e as { text: string }).text)).toEqual(["m7", "m8"]);
  });
});
