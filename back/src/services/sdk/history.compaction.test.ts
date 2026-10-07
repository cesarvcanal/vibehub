import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "../../config/env.js";

/**
 * A COMPACTAÇÃO NÃO PODE APAGAR O QUE CHEGOU DURANTE ELA.
 *
 * `readHistory` lê o log e, se ele passou do teto, reescreve-o só com a cauda. A leitura acontecia
 * FORA da fila de appends e a reescrita DENTRO: tudo o que entrasse na fila entre as duas (a resposta
 * do driver chegando enquanto alguém abre o card) era sobrescrito por uma cauda calculada antes — a
 * mensagem sumia do log, e um `rewindHistory` já aplicado era desfeito.
 *
 * A janela é de microssegundos com disco real, então o teste a abre de propósito: um gancho no
 * `readFile` dispara o append exatamente depois que a leitura da compactação terminou.
 */

const h = vi.hoisted(() => ({ afterRead: null as null | (() => void) }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readFile: async (...args: Parameters<typeof actual.readFile>) => {
      const out = await actual.readFile(...args);
      const hook = h.afterRead;
      h.afterRead = null;
      hook?.();
      return out;
    },
  };
});

const { appendHistory, readHistory, HISTORY_COMPACT_FACTOR } = await import("./history.js");

const CARD = "abc498d1-98dd-44b6-97ee-c06a181c3769";

let dir = "";
let savedDataDir = "";

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "vibehub-sdk-history-compact-"));
  savedDataDir = config.dataDir;
  config.dataDir = dir;
  h.afterRead = null;
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
