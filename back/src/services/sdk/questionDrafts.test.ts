import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "../../config/env.js";
import {
  SDK_QUESTION_DRAFTS_DIR,
  loadQuestionDrafts,
  parseQuestionDrafts,
  questionDraftsSettled,
  removeQuestionDrafts,
  saveQuestionDrafts,
  serializeQuestionDrafts,
  type CardQuestionDrafts,
} from "./questionDrafts.js";

const CARD = "eeee498d-98dd-44b6-97ee-c06a181c3769";
let dir = "";
let saved = "";

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "vibehub-question-drafts-"));
  saved = config.dataDir;
  config.dataDir = dir;
});
afterEach(async () => {
  await questionDraftsSettled(CARD);
  config.dataDir = saved;
  await rm(dir, { recursive: true, force: true });
});

const drafts = (entries: Array<[string, string, string[][], string[], number?]>): CardQuestionDrafts => {
  const out: CardQuestionDrafts = new Map();
  for (const [id, name, picked, other, at] of entries) {
    if (!out.has(id)) out.set(id, new Map());
    out.get(id)!.set(name, { picked, other, ...(at !== undefined ? { at } : {}) });
  }
  return out;
};

describe("questionDrafts — o disco dos rascunhos de cartão", () => {
  it("grava e lê de volta o de cada pessoa", async () => {
    const value = drafts([["q1", "cesar", [["A"]], ["x"], 5], ["q1", "albert", [["B"]], [""]]]);
    await saveQuestionDrafts(CARD, value);
    expect(await loadQuestionDrafts(CARD)).toEqual(value);
  });

  it("várias gravações seguidas: fica a ÚLTIMA (coalescidas, em ordem)", async () => {
    void saveQuestionDrafts(CARD, drafts([["q1", "cesar", [["1"]], [""]]]));
    void saveQuestionDrafts(CARD, drafts([["q1", "cesar", [["2"]], [""]]]));
    void saveQuestionDrafts(CARD, drafts([["q1", "cesar", [["3"]], [""]]]));
    expect((await loadQuestionDrafts(CARD)).get("q1")?.get("cesar")?.picked).toEqual([["3"]]);
  });

  it("nada a guardar apaga o arquivo", async () => {
    await saveQuestionDrafts(CARD, drafts([["q1", "cesar", [["A"]], [""]]]));
    await saveQuestionDrafts(CARD, new Map());
    await expect(readFile(join(dir, SDK_QUESTION_DRAFTS_DIR, `${CARD}.json`), "utf8")).rejects.toThrow();
  });

  it("card apagado: os rascunhos vão junto", async () => {
    await saveQuestionDrafts(CARD, drafts([["q1", "cesar", [["A"]], [""]]]));
    await removeQuestionDrafts(CARD);
    expect((await loadQuestionDrafts(CARD)).size).toBe(0);
  });

  it("arquivo corrompido ou adulterado: lê o que se aproveita, nunca lança", async () => {
    await mkdir(join(dir, SDK_QUESTION_DRAFTS_DIR), { recursive: true });
    await writeFile(join(dir, SDK_QUESTION_DRAFTS_DIR, `${CARD}.json`), "{nope", "utf8");
    expect((await loadQuestionDrafts(CARD)).size).toBe(0);
    expect(parseQuestionDrafts(JSON.stringify({
      q1: { cesar: { picked: "x", other: [] }, albert: { picked: [["ok"]], other: [""], at: "ontem" } },
      q2: [],
    }))).toEqual(drafts([["q1", "albert", [["ok"]], [""]]]));
  });

  it("serializeQuestionDrafts — pura: pergunta sem ninguém não entra", () => {
    const value = drafts([["q1", "cesar", [["A"]], [""]]]);
    value.set("q2", new Map());
    expect(JSON.parse(serializeQuestionDrafts(value)!)).toEqual({ q1: { cesar: { picked: [["A"]], other: [""] } } });
    expect(serializeQuestionDrafts(new Map())).toBeNull();
  });
});
