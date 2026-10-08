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
    const out = await tr.translate("First paragraph.\n\nThen the second one.\n");
    expect(out).toBe("PT(First paragraph.)\n\nPT(Then the second one.)\n");
    expect(t.translate).toHaveBeenCalledTimes(2);
  });

  it("o mesmo texto é traduzido UMA vez: reabrir a conversa não refaz o trabalho", async () => {
    const t = fakeTranslator();
    const tr = createReasoningTranslator({ translator: t.factory, detector: fakeDetector(EN).factory });
    await tr.translate("I will do the same block.");
    await tr.translate("I will do the same block.");
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
    await expect(tr.translate("I will fix the text here.")).resolves.toBe(null);
    fail = false;
    await expect(tr.translate("I will fix the text here.")).resolves.toBe("ok:I will fix the text here.");
  });

  it("idioma indisponível no tradutor: null, sem quebrar", async () => {
    const t = fakeTranslator({ availability: "unavailable" });
    const tr = createReasoningTranslator({ translator: t.factory, detector: fakeDetector(EN).factory });
    await expect(tr.translate("I will fix the text here.")).resolves.toBe(null);
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
    await expect(tr.translate("I will read the file.\n- read the logs\n- fix the test")).resolves.toBe(
      "PT(I will read the file.)\n- PT(read the logs)\n- PT(fix the test)",
    );
  });

  // 3ª revisão (1, 2): português informal sem palavra da lista nem acento, e "me"/"do" contados
  // como inglês. A LINHA precisa de prova positiva de inglês — sem ela, fica como veio.
  it("linha sem prova de inglês fica como veio — português informal, 'Me ajuda aqui'", async () => {
    const t = fakeTranslator();
    const tr = createReasoningTranslator({ translator: t.factory });
    const input =
      "Let me check what the user wants.\nThe user wrote:\nnao funciona aqui, testa ai pra mim\n" +
      "Me ajuda aqui\nI should run the tests first.";
    await expect(tr.translate(input)).resolves.toBe(
      "PT(Let me check what the user wants.)\nPT(The user wrote:)\nnao funciona aqui, testa ai pra mim\n" +
        "Me ajuda aqui\nPT(I should run the tests first.)",
    );
  });

  it("fence ~~~ também é código: marcadores e conteúdo ficam como vieram", async () => {
    const t = fakeTranslator();
    const tr = createReasoningTranslator({ translator: t.factory });
    await expect(tr.translate("Let me write the code:\n~~~\nif the user is set:\n~~~\nthen I will check it")).resolves.toBe(
      "PT(Let me write the code:)\n~~~\nif the user is set:\n~~~\nPT(then I will check it)",
    );
  });

  it("linhas de código fora de fence ficam como vieram (atribuição, chamada, shell, erro, traceback)", async () => {
    const t = fakeTranslator();
    const tr = createReasoningTranslator({ translator: t.factory });
    const code = [
      "    if x:",
      "x = foo(bar)",
      "foo.bar(baz)",
      "npm run test",
      "git push origin main",
      "TypeError: Cannot read properties of undefined (reading 'map')",
      '  File "app.py", line 3, in main',
    ];
    await expect(tr.translate(["I will check what is failing here.", ...code].join("\n"))).resolves.toBe(
      ["PT(I will check what is failing here.)", ...code].join("\n"),
    );
  });

  // 4ª revisão (a): "so" (só) e "to" (tô) sem acento contavam como inglês.
  it("'so falta testar' e 'to indo testar' (português sem acento) ficam como vieram", async () => {
    const t = fakeTranslator();
    const tr = createReasoningTranslator({ translator: t.factory });
    await expect(tr.translate("I need to check the tests first.\nso falta testar\nto indo testar login")).resolves.toBe(
      "PT(I need to check the tests first.)\nso falta testar\nto indo testar login",
    );
    await expect(tr.translate("so falta testar\nto indo almoçar? nao")).resolves.toBe(null);
    expect(t.translate).toHaveBeenCalledTimes(1);
  });

  // 4ª revisão (d): com o detector dizendo "es", linhas inglesas iam para um tradutor es→pt.
  it("só traduz inglês → português: outro idioma detectado fica como veio", async () => {
    const t = fakeTranslator();
    const tr = createReasoningTranslator({
      translator: t.factory,
      detector: fakeDetector([{ detectedLanguage: "es", confidence: 0.9 }]).factory,
    });
    await expect(tr.translate("Necesito revisar los tests.\nThe build is failing on CI.")).resolves.toBe(null);
    expect(t.create).not.toHaveBeenCalled();
  });

  // 4ª revisão (c): ">" e "##" iam junto para o tradutor.
  it("citação '>' e título '##' ficam intactos — só o texto depois deles é traduzido", async () => {
    const t = fakeTranslator();
    const tr = createReasoningTranslator({ translator: t.factory });
    await expect(tr.translate("> I need to check the build.\n## Then check the logs")).resolves.toBe(
      "> PT(I need to check the build.)\n## PT(Then check the logs)",
    );
  });

  // 5ª revisão: marcadores empilhados e espaços depois de ">" ainda chegavam ao tradutor.
  it("marcadores empilhados ('> - [ ]', '## 1.') e espaços depois de '>' ficam intactos", async () => {
    const t = fakeTranslator();
    const tr = createReasoningTranslator({ translator: t.factory });
    await expect(
      tr.translate("> - [ ] the task is this\n## 1. the step is first\n  >  the indented quote is it   "),
    ).resolves.toBe("> - [ ] PT(the task is this)\n## 1. PT(the step is first)\n  >  PT(the indented quote is it)   ");
  });

  it("espaço não-separável (NBSP) ou ideográfico depois de '>' também é marcador", async () => {
    const t = fakeTranslator();
    const tr = createReasoningTranslator({ translator: t.factory });
    await expect(tr.translate("> the quote is this\n>　the other quote is it")).resolves.toBe(
      "> PT(the quote is this)\n>　PT(the other quote is it)",
    );
  });

  it("fence com linha gigante ainda abre/fecha o bloco de código", async () => {
    const t = fakeTranslator();
    const tr = createReasoningTranslator({ translator: t.factory });
    const fence = "```" + "x".repeat(2100);
    const input = `I will check the code now.\n${fence}\nI need to keep this line.\n\`\`\``;
    await expect(tr.translate(input)).resolves.toBe(
      `PT(I will check the code now.)\n${fence}\nI need to keep this line.\n\`\`\``,
    );
  });

  it("muitas linhas 'f()   ...' não travam (a regex de chamada é linear)", async () => {
    const t = fakeTranslator();
    const tr = createReasoningTranslator({ translator: t.factory });
    const line = "f()" + " ".repeat(1990) + "x";
    const input = ["I will check what the call does.", ...Array(200).fill(line)].join("\n");
    const start = performance.now();
    await tr.translate(input);
    expect(performance.now() - start).toBeLessThan(300);
  });

  it("checkbox vazio '- [ ]' fica intacto", async () => {
    const t = fakeTranslator();
    const tr = createReasoningTranslator({ translator: t.factory });
    await expect(tr.translate("I will do the following now:\n- [ ]")).resolves.toBe(
      "PT(I will do the following now:)\n- [ ]",
    );
  });

  it("linha gigante não trava a tela (sem regex quadrática) e fica como veio", async () => {
    const t = fakeTranslator();
    const tr = createReasoningTranslator({ translator: t.factory });
    const huge = "the test is" + " ".repeat(40000) + "x";
    const stack = "at x " + "(".repeat(20000);
    const start = performance.now();
    const out = await tr.translate(`I will check what the test is doing.\n${huge}\n${stack}`);
    expect(performance.now() - start).toBeLessThan(300);
    expect(out).toBe(`PT(I will check what the test is doing.)\n${huge}\n${stack}`);
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
