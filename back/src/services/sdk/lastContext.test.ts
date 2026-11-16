import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { config } from "../../config/env.js";
import { SDK_CONTEXT_DIR, lastContextSettled, readLastContext, removeLastContext, saveLastContext } from "./lastContext.js";

/**
 * THE BUG (production, 2026-11-16): "o contexto não aparece… eu preciso mandar mensagem para aparecer". The
 * meter's last reading lived only in the back's memory, and every deploy restarts the back: the card opened
 * after a deploy had no number until the next turn ended. On disk, the reading outlives the deploy.
 */

const CARD = "56fc53c6-ff44-484c-b2c3-e5576b6760e7";
const READING = { sessionId: "s-1", info: { usedTokens: 84_000, maxTokens: 200_000, percent: 42, model: "claude-opus-5-5" } };

let dir = "";
let savedDataDir = "";
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "vibehub-context-"));
  savedDataDir = config.dataDir;
  config.dataDir = dir;
});
afterEach(async () => {
  config.dataDir = savedDataDir;
  await rm(dir, { recursive: true, force: true });
});

const fileOf = (cardId: string) => join(dir, SDK_CONTEXT_DIR, `${cardId}.json`);

describe("a última leitura do contexto sobrevive ao restart do back", () => {
  it("o que foi gravado volta na leitura", async () => {
    await saveLastContext(CARD, READING);
    expect(await readLastContext(CARD)).toEqual(READING);
  });

  it("sem arquivo, não há leitura", async () => {
    expect(await readLastContext(CARD)).toBeNull();
  });

  it("arquivo torto ou sem janela é ignorado, sem lançar", async () => {
    await mkdir(join(dir, SDK_CONTEXT_DIR), { recursive: true });
    await writeFile(fileOf(CARD), "{nope", "utf8");
    expect(await readLastContext(CARD)).toBeNull();
    await writeFile(fileOf(CARD), JSON.stringify({ sessionId: "s-1", info: { usedTokens: 10 } }), "utf8");
    expect(await readLastContext(CARD)).toBeNull();
    await writeFile(fileOf(CARD), JSON.stringify({ info: READING.info }), "utf8");
    expect(await readLastContext(CARD)).toBeNull();
  });

  it("o percentual sai da regra do back, não do que estava no arquivo", async () => {
    await mkdir(join(dir, SDK_CONTEXT_DIR), { recursive: true });
    await writeFile(fileOf(CARD), JSON.stringify({ sessionId: "s-1", info: { usedTokens: 50_000, maxTokens: 200_000, percent: 99 } }), "utf8");
    expect(await readLastContext(CARD)).toEqual({ sessionId: "s-1", info: { usedTokens: 50_000, maxTokens: 200_000, percent: 25 } });
  });

  it("gravações em rajada: vale a última, e a leitura espera a fila do card", async () => {
    void saveLastContext(CARD, { sessionId: "s-1", info: { usedTokens: 1_000, maxTokens: 200_000, percent: 0.5 } });
    void saveLastContext(CARD, { sessionId: "s-1", info: { usedTokens: 2_000, maxTokens: 200_000, percent: 1 } });
    void saveLastContext(CARD, READING);
    expect(await readLastContext(CARD)).toEqual(READING);
  });

  it("grava só a origem: o percentual é derivado e sai da regra do back na leitura", async () => {
    await saveLastContext(CARD, READING);
    expect(JSON.parse(await readFile(fileOf(CARD), "utf8"))).toEqual({
      sessionId: "s-1", info: { usedTokens: 84_000, maxTokens: 200_000, model: "claude-opus-5-5" },
    });
  });

  it("leitura igual à gravada não reescreve o arquivo (o turno longo mede a cada ~5 s)", async () => {
    await saveLastContext(CARD, READING);
    const before = await stat(fileOf(CARD));
    await saveLastContext(CARD, { ...READING, info: { ...READING.info } });
    expect((await stat(fileOf(CARD))).ino).toBe(before.ino);
    await saveLastContext(CARD, { ...READING, sessionId: "s-2" });
    expect((await stat(fileOf(CARD))).ino).not.toBe(before.ino);
  });

  it("depois de apagar, a mesma leitura volta a ser gravada", async () => {
    await saveLastContext(CARD, READING);
    await saveLastContext(CARD, null);
    await saveLastContext(CARD, READING);
    expect(await readLastContext(CARD)).toEqual(READING);
  });

  it("null apaga a leitura (o /clear)", async () => {
    await saveLastContext(CARD, READING);
    void saveLastContext(CARD, null);
    await lastContextSettled(CARD);
    expect(await readLastContext(CARD)).toBeNull();
  });

  it("a purga apaga o arquivo do card", async () => {
    await saveLastContext(CARD, READING);
    await removeLastContext(CARD);
    expect(await readdir(join(dir, SDK_CONTEXT_DIR))).toEqual([]);
  });

  it("id de card inválido não vira caminho", async () => {
    expect(await readLastContext("../board")).toBeNull();
    await saveLastContext("../board", READING);
    expect(await readdir(dir)).toEqual([]);
  });
});
