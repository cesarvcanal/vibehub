import { describe, it, expect } from "vitest";
import { formatTranscribeKeywords, parseTranscribeKeywords } from "./transcribeKeywords";

describe("termos da transcrição", () => {
  it.each([
    ["separados por vírgula", "vibehub, erp-aux,Qive", ["vibehub", "erp-aux", "Qive"]],
    ["um por linha", "Mussa\nKaio\r\nbank-api", ["Mussa", "Kaio", "bank-api"]],
    ["vírgula e linha juntas, com sobras em branco", " vibehub ,\n\n, Qive ,", ["vibehub", "Qive"]],
    ["campo vazio", "   ", []],
  ])("lê termos %s", (_case, text, keywords) => {
    expect(parseTranscribeKeywords(text)).toEqual(keywords);
  });

  it("mostra a lista salva separada por vírgula, e a volta dá a mesma lista", () => {
    const keywords = ["vibehub", "Central de Projetos", "Qive"];
    expect(formatTranscribeKeywords(keywords)).toBe("vibehub, Central de Projetos, Qive");
    expect(parseTranscribeKeywords(formatTranscribeKeywords(keywords))).toEqual(keywords);
  });
});
