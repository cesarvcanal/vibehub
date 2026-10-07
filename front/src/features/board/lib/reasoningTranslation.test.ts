import { describe, it, expect, vi } from "vitest";
import { createReasoningTranslator, type DetectorFactory, type TranslatorFactory } from "./reasoningTranslation";

/**
 * O RACIOCÍNIO TRADUZIDO NO NAVEGADOR. Pedir ao modelo que pensasse em português era o gatilho do
 * bloqueio `[reasoning_extraction]` do Opus e nem funcionava direito (o resumo do raciocínio ora
 * vinha em português, ora em inglês). A tradução agora é do Chrome/Edge — `Translator` e
 * `LanguageDetector`, modelos locais: zero token, nada sai da máquina. Sem a API, o original.
 */

type Availability = "unavailable" | "downloadable" | "downloading" | "available";

function fakeTranslator(opts: { availability?: Availability; translate?: (t: string) => Promise<string> } = {}) {
  const translate = vi.fn(opts.translate ?? (async (t: string) => `PT(${t})`));
  const factory = {
    availability: vi.fn(async () => opts.availability ?? "available"),
    create: vi.fn(async () => ({ translate })),
  };
  return { factory: factory as unknown as TranslatorFactory, translate, create: factory.create, availability: factory.availability };
}

function fakeDetector(results: { detectedLanguage: string; confidence: number }[]) {
  const detect = vi.fn(async () => results);
  const factory = {
    availability: vi.fn(async () => "available" as Availability),
    create: vi.fn(async () => ({ detect })),
  };
  return { factory: factory as unknown as DetectorFactory, detect };
}

const EN = [{ detectedLanguage: "en", confidence: 0.97 }];
const PT = [{ detectedLanguage: "pt", confidence: 0.95 }];

describe("createReasoningTranslator", () => {
  it("navegador sem a API (Firefox, Chrome antigo): null — a tela mostra o original", async () => {
    const tr = createReasoningTranslator({});
    await expect(tr.translate("I will read the failing test.")).resolves.toBe(null);
  });

  it("traduz um raciocínio em inglês para português", async () => {
    const t = fakeTranslator();
    const tr = createReasoningTranslator({ translator: t.factory, detector: fakeDetector(EN).factory });
    await expect(tr.translate("I will read the failing test.")).resolves.toBe("PT(I will read the failing test.)");
    expect(t.create).toHaveBeenCalledWith({ sourceLanguage: "en", targetLanguage: "pt" });
  });

  it("o que já veio em português não é traduzido — nem chega ao tradutor", async () => {
    const t = fakeTranslator();
    const tr = createReasoningTranslator({ translator: t.factory, detector: fakeDetector(PT).factory });
    await expect(tr.translate("Tenho material suficiente para entregar a análise.")).resolves.toBe(null);
    expect(t.translate).not.toHaveBeenCalled();
  });

  it("parágrafo por parágrafo: a quebra entre eles sobrevive à tradução", async () => {
    const t = fakeTranslator();
    const tr = createReasoningTranslator({ translator: t.factory, detector: fakeDetector(EN).factory });
    const out = await tr.translate("First paragraph.\n\nSecond one.\n");
    expect(out).toBe("PT(First paragraph.)\n\nPT(Second one.)\n");
    expect(t.translate).toHaveBeenCalledTimes(2);
  });

  it("o mesmo texto é traduzido UMA vez: reabrir a conversa não refaz o trabalho", async () => {
    const t = fakeTranslator();
    const tr = createReasoningTranslator({ translator: t.factory, detector: fakeDetector(EN).factory });
    await tr.translate("Same block.");
    await tr.translate("Same block.");
    expect(t.translate).toHaveBeenCalledTimes(1);
    expect(t.create).toHaveBeenCalledTimes(1);
  });

  it("modelo ainda não baixado e SEM gesto do usuário: não tenta baixar (o navegador recusaria)", async () => {
    const t = fakeTranslator({ availability: "downloadable" });
    const tr = createReasoningTranslator({ translator: t.factory, detector: fakeDetector(EN).factory, userActive: () => false });
    await expect(tr.translate("Hello there, friend.")).resolves.toBe(null);
    expect(t.create).not.toHaveBeenCalled();
  });

  it("prime() num gesto baixa o modelo e avisa quem esperava — aí a tradução sai", async () => {
    const t = fakeTranslator({ availability: "downloadable" });
    let active = false;
    const tr = createReasoningTranslator({ translator: t.factory, detector: fakeDetector(EN).factory, userActive: () => active });
    await expect(tr.translate("Hello there, friend.")).resolves.toBe(null);

    const ready = vi.fn();
    tr.onReady(ready);
    active = true;
    tr.prime();
    await vi.waitFor(() => expect(ready).toHaveBeenCalled());

    await expect(tr.translate("Hello there, friend.")).resolves.toBe("PT(Hello there, friend.)");
  });

  it("prime() no meio de uma checagem ainda pendente baixa mesmo assim (o gesto não se perde)", async () => {
    let release!: (a: Availability) => void;
    const t = fakeTranslator({ availability: "downloadable" });
    t.availability.mockImplementationOnce(() => new Promise<Availability>((r) => { release = r; }));
    const tr = createReasoningTranslator({ translator: t.factory, userActive: () => false });
    const first = tr.translate("Hello there, friend.");   // checagem pendente, sem gesto
    await vi.waitFor(() => expect(t.availability).toHaveBeenCalled());
    tr.prime();                                           // o clique chega AGORA
    expect(t.create).toHaveBeenCalledTimes(1);
    release("downloadable");
    await first;
    await expect(tr.translate("Hello there, friend.")).resolves.toBe("PT(Hello there, friend.)");
  });

  it("falha do tradutor: null, e a falha NÃO fica guardada — a próxima tentativa tenta de novo", async () => {
    let fail = true;
    const t = fakeTranslator({ translate: async (s) => { if (fail) throw new Error("boom"); return `ok:${s}`; } });
    const tr = createReasoningTranslator({ translator: t.factory, detector: fakeDetector(EN).factory });
    await expect(tr.translate("Some text here.")).resolves.toBe(null);
    fail = false;
    await expect(tr.translate("Some text here.")).resolves.toBe("ok:Some text here.");
  });

  it("idioma indisponível no tradutor: null, sem quebrar", async () => {
    const t = fakeTranslator({ availability: "unavailable" });
    const tr = createReasoningTranslator({ translator: t.factory, detector: fakeDetector(EN).factory });
    await expect(tr.translate("Some text here.")).resolves.toBe(null);
    expect(t.create).not.toHaveBeenCalled();
  });

  it("sem detector, assume inglês — é o idioma em que o modelo pensa por padrão", async () => {
    const t = fakeTranslator();
    const tr = createReasoningTranslator({ translator: t.factory });
    await expect(tr.translate("Plain text.")).resolves.toBe("PT(Plain text.)");
  });

  it("texto vazio ou só espaço: nada a traduzir", async () => {
    const t = fakeTranslator();
    const tr = createReasoningTranslator({ translator: t.factory, detector: fakeDetector(EN).factory });
    await expect(tr.translate("   \n")).resolves.toBe(null);
    expect(t.translate).not.toHaveBeenCalled();
  });
});
