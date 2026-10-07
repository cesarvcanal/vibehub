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
    await expect(tr.translate("I need to check what the user wants.")).resolves.toBe(null);
    expect(t.create).not.toHaveBeenCalled();
  });

  it("prime() num gesto baixa o modelo e avisa quem esperava — aí a tradução sai", async () => {
    const t = fakeTranslator({ availability: "downloadable" });
    let active = false;
    const tr = createReasoningTranslator({ translator: t.factory, detector: fakeDetector(EN).factory, userActive: () => active });
    await expect(tr.translate("I need to check what the user wants.")).resolves.toBe(null);

    const ready = vi.fn();
    tr.onReady(ready);
    active = true;
    tr.prime();
    await vi.waitFor(() => expect(ready).toHaveBeenCalled());

    await expect(tr.translate("I need to check what the user wants.")).resolves.toBe("PT(I need to check what the user wants.)");
  });

  it("prime() no meio de uma checagem ainda pendente baixa mesmo assim (o gesto não se perde)", async () => {
    let release!: (a: Availability) => void;
    const t = fakeTranslator({ availability: "downloadable" });
    t.availability.mockImplementationOnce(() => new Promise<Availability>((r) => { release = r; }));
    const tr = createReasoningTranslator({ translator: t.factory, userActive: () => false });
    const first = tr.translate("I need to check what the user wants.");   // checagem pendente, sem gesto
    await vi.waitFor(() => expect(t.availability).toHaveBeenCalled());
    tr.prime();                                           // o clique chega AGORA
    expect(t.create).toHaveBeenCalledTimes(1);
    release("downloadable");
    await first;
    await expect(tr.translate("I need to check what the user wants.")).resolves.toBe("PT(I need to check what the user wants.)");
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

  it("sem detector, um texto CLARAMENTE em inglês é traduzido (a heurística local decide)", async () => {
    const t = fakeTranslator();
    const tr = createReasoningTranslator({ translator: t.factory });
    const en = "I need to check how the roles work and what the user wants from this.";
    await expect(tr.translate(en)).resolves.toBe(`PT(${en})`);
  });

  // Revisão adversarial (HIGH-1), provado no Chrome 154: com o detector indisponível, um raciocínio
  // em PORTUGUÊS ia para o tradutor en→pt e voltava estragado ("...TESTES DO VOLTAR"), e ficava guardado.
  it("sem detector, um raciocínio que JÁ veio em português não passa pelo tradutor", async () => {
    const t = fakeTranslator();
    const tr = createReasoningTranslator({ translator: t.factory });
    await expect(tr.translate("Vou ler o arquivo sdk-driver.mjs e depois rodar os testes do back.")).resolves.toBe(null);
    expect(t.translate).not.toHaveBeenCalled();
  });

  it("detector sem certeza: na dúvida NÃO traduz — o original nunca é estragado", async () => {
    const t = fakeTranslator();
    const tr = createReasoningTranslator({ translator: t.factory, detector: fakeDetector([{ detectedLanguage: "en", confidence: 0.2 }]).factory });
    await expect(tr.translate("Tenho material suficiente para a análise que o usuário pediu.")).resolves.toBe(null);
    await expect(tr.translate("ok")).resolves.toBe(null);
    expect(t.translate).not.toHaveBeenCalled();
  });

  // HIGH-2, provado no Chrome real: o PRIMEIRO create() que baixa um modelo consome o gesto — o
  // segundo, no mesmo clique, leva NotAllowedError. Então é um download por gesto: tradutor primeiro,
  // detector no gesto seguinte — e o prime() não pode desistir depois do primeiro.
  it("prime(): um download por gesto — o tradutor primeiro, o detector no gesto seguinte", async () => {
    const t = fakeTranslator({ availability: "downloadable" });
    const d = fakeDetector(EN);
    const detectorCreate = (d.factory as unknown as { create: ReturnType<typeof vi.fn> }).create;
    const tr = createReasoningTranslator({ translator: t.factory, detector: d.factory, userActive: () => true });
    tr.prime();
    expect(t.create).toHaveBeenCalledTimes(1);
    expect(detectorCreate).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(t.create.mock.results[0]!.type).toBe("return"));
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
    tr.prime();
    expect(detectorCreate).toHaveBeenCalledTimes(1);
    tr.prime();
    await new Promise((r) => setTimeout(r, 0));
    tr.prime();
    expect(t.create).toHaveBeenCalledTimes(1);
    expect(detectorCreate).toHaveBeenCalledTimes(1);
  });

  // MEDIUM-3, provado no Chrome real: o tradutor junta as linhas de um parágrafo ("- a - b").
  it("linha por linha: listas e passos continuam um por linha", async () => {
    const t = fakeTranslator();
    const tr = createReasoningTranslator({ translator: t.factory, detector: fakeDetector(EN).factory });
    await expect(tr.translate("I will read the file.\n- first item\n- second item")).resolves.toBe(
      "PT(I will read the file.)\n- PT(first item)\n- PT(second item)",
    );
  });

  // Re-revisão adversarial (MEDIUM-A), provado no Chrome 154: português que CITA saída em inglês
  // ("O teste falhou com: Expected...") era classificado como inglês no bloco e virava
  // "o testo falhou com:". O idioma é decidido por bloco, mas a tradução é por linha — então a linha
  // também tem voto: qualquer sinal de português, ela fica como veio.
  it("linha com sinal de português fica como veio, mesmo num bloco majoritariamente em inglês", async () => {
    const t = fakeTranslator();
    const tr = createReasoningTranslator({ translator: t.factory });
    const out = await tr.translate(
      "I will check why the test is failing and then fix it.\n" +
        "O teste falhou com: Expected the value to be true but it was false.\n" +
        "Vou rodar os testes do back e depois ajustar o botao de enviar.",
    );
    expect(out).toBe(
      "PT(I will check why the test is failing and then fix it.)\n" +
        "O teste falhou com: Expected the value to be true but it was false.\n" +
        "Vou rodar os testes do back e depois ajustar o botao de enviar.",
    );
  });

  it("palavras que existem nas duas línguas (do, as, no, se) não seguram uma linha em inglês", async () => {
    const t = fakeTranslator();
    const tr = createReasoningTranslator({ translator: t.factory });
    await expect(tr.translate("I do not know as much as I should, so no guessing.")).resolves.toBe(
      "PT(I do not know as much as I should, so no guessing.)",
    );
  });

  // LOW-B, provado no Chrome 154: "await" virava "aguarde" e "- [ ]" virava "- []".
  it("código não é traduzido: bloco ``` e linha com cara de código ficam como vieram", async () => {
    const t = fakeTranslator();
    const tr = createReasoningTranslator({ translator: t.factory });
    const out = await tr.translate(
      "I need to check what the loader does here.\n" +
        "```ts\nreturn the value to the caller\n```\n" +
        "const x = await this.load(id); if (!x) return;\n" +
        "    at Object.<anonymous> (src/app.ts:12:5)",
    );
    expect(out).toBe(
      "PT(I need to check what the loader does here.)\n" +
        "```ts\nreturn the value to the caller\n```\n" +
        "const x = await this.load(id); if (!x) return;\n" +
        "    at Object.<anonymous> (src/app.ts:12:5)",
    );
  });

  it("o marcador de lista/checkbox fica intacto — só o texto depois dele é traduzido", async () => {
    const t = fakeTranslator();
    const tr = createReasoningTranslator({ translator: t.factory });
    await expect(tr.translate("I will do the following now:\n- [ ] run the tests\n2. check the logs")).resolves.toBe(
      "PT(I will do the following now:)\n- [ ] PT(run the tests)\n2. PT(check the logs)",
    );
  });

  it("supported diz se o navegador tem a API — sem ela ninguém nem tenta", () => {
    expect(createReasoningTranslator({}).supported).toBe(false);
    expect(createReasoningTranslator({ translator: fakeTranslator().factory }).supported).toBe(true);
  });

  it("texto vazio ou só espaço: nada a traduzir", async () => {
    const t = fakeTranslator();
    const tr = createReasoningTranslator({ translator: t.factory, detector: fakeDetector(EN).factory });
    await expect(tr.translate("   \n")).resolves.toBe(null);
    expect(t.translate).not.toHaveBeenCalled();
  });
});
