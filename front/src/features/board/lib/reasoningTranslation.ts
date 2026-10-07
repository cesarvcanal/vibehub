import * as React from "react";

/**
 * O RACIOCÍNIO TRADUZIDO NO NAVEGADOR — só na exibição, sem token nenhum.
 *
 * Antes, o driver pedia ao modelo que pensasse em português (7bf6ace). Duas coisas erradas nisso:
 *   - o que a tela mostra é o RESUMO do raciocínio (`display: "summarized"`), e ele ora seguia a
 *     instrução, ora voltava em inglês;
 *   - uma instrução sobre o raciocínio no system prompt é o gatilho conhecido do bloqueio
 *     `[reasoning_extraction]` do Opus (card #3684).
 *
 * Agora o modelo não fica sabendo de nada: o Chrome (138+) e o Edge (148+) trazem `Translator` e
 * `LanguageDetector`, modelos LOCAIS e pequenos (de tradução, não o Gemini Nano) — nada sai da
 * máquina e nada é cobrado. Sem a API (Firefox, Safari, navegador antigo), ou enquanto o pacote de
 * idioma não baixou, a tela mostra o original: a tradução é um extra, nunca um ponto de falha.
 */

type Availability = "unavailable" | "downloadable" | "downloading" | "available";
type Pair = { sourceLanguage: string; targetLanguage: string };

export interface TranslatorLike { translate(text: string): Promise<string> }
export interface TranslatorFactory {
  availability(pair: Pair): Promise<Availability>;
  create(pair: Pair): Promise<TranslatorLike>;
}
export interface DetectorLike { detect(text: string): Promise<{ detectedLanguage?: string; confidence?: number }[]> }
export interface DetectorFactory {
  availability(): Promise<Availability>;
  create(): Promise<DetectorLike>;
}

export interface TranslationEnv {
  translator?: TranslatorFactory;
  detector?: DetectorFactory;
  /**
   * O navegador só BAIXA o modelo dentro de um gesto do usuário (clique, tecla). Fora dele, `create()`
   * de um modelo ainda não baixado é recusado — então nem tentamos.
   */
  userActive?: () => boolean;
}

export interface ReasoningTranslator {
  /** O texto em português, ou `null` = mostre o original (já é português, sem API, falhou...). */
  translate(text: string): Promise<string | null>;
  /** Chamado num gesto do usuário: baixa o modelo, se preciso, e avisa `onReady` quando ficar pronto. */
  prime(): void;
  onReady(listener: () => void): () => void;
}

/** O alvo é sempre português: só a interface em pt-BR traduz (inglês é o idioma em que o modelo pensa). */
const TARGET = "pt";
/** O idioma que o modelo usa por padrão — o palpite quando não há detector ou ele não tem certeza. */
const DEFAULT_SOURCE = "en";
/** Abaixo disso a detecção é chute (texto curto demais, misturado): vale o padrão. */
const MIN_CONFIDENCE = 0.5;
/** Blocos já traduzidos guardados: reabrir a conversa não refaz o trabalho. */
const CACHE_LIMIT = 300;

/**
 * Traduz parágrafo por parágrafo: a quebra entre eles (e o espaço nas pontas) sobrevive, e cada
 * pedaço fica curto — o tradutor local trabalha melhor (e mais rápido) assim.
 */
async function translateParagraphs(translator: TranslatorLike, text: string): Promise<string> {
  const parts = text.split(/(\n\s*\n)/);
  let out = "";
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    // os índices ímpares são os separadores capturados pelo split
    if (i % 2 === 1 || part.trim() === "") {
      out += part;
      continue;
    }
    const [, lead, core, trail] = /^(\s*)([\s\S]*?)(\s*)$/.exec(part)!;
    out += lead + (await translator.translate(core!)) + trail;
  }
  return out;
}

export function createReasoningTranslator(env: TranslationEnv): ReasoningTranslator {
  const cache = new Map<string, string>();
  const translators = new Map<string, Promise<TranslatorLike | null>>();
  let detector: Promise<DetectorLike | null> | null = null;
  let priming = false;
  /** O par padrão já tem tradutor PRONTO — uma checagem ainda pendente não conta (ela pode dar em nada). */
  let primed = false;
  const listeners = new Set<() => void>();
  const userActive = env.userActive ?? (() => false);

  function pairFor(source: string): Pair {
    return { sourceLanguage: source, targetLanguage: TARGET };
  }

  /** Guarda só o SUCESSO: uma falha (ou "ainda não baixou") tenta de novo na próxima vez. */
  function remember<T>(map: Map<string, Promise<T | null>>, key: string, make: () => Promise<T | null>): Promise<T | null> {
    const hit = map.get(key);
    if (hit) return hit;
    const pending: Promise<T | null> = make()
      .catch(() => null)
      .then((value) => {
        // só apaga a SI MESMA: o prime() pode ter posto um tradutor pronto no lugar enquanto isto esperava
        if (value === null && map.get(key) === pending) map.delete(key);
        return value;
      });
    map.set(key, pending);
    return pending;
  }

  function getTranslator(source: string): Promise<TranslatorLike | null> {
    const factory = env.translator;
    if (!factory) return Promise.resolve(null);
    return remember(translators, source, async () => {
      const availability = await factory.availability(pairFor(source));
      if (availability === "unavailable") return null;
      if (availability !== "available" && !userActive()) return null;
      return factory.create(pairFor(source));
    });
  }

  function getDetector(): Promise<DetectorLike | null> {
    const factory = env.detector;
    if (!factory) return Promise.resolve(null);
    if (detector) return detector;
    const pending = (async () => {
      const availability = await factory.availability();
      if (availability === "unavailable") return null;
      if (availability !== "available" && !userActive()) return null;
      return factory.create();
    })()
      .catch(() => null)
      .then((value) => {
        if (value === null) detector = null;
        return value;
      });
    detector = pending;
    return pending;
  }

  async function sourceLanguageOf(text: string): Promise<string> {
    const d = await getDetector();
    if (!d) return DEFAULT_SOURCE;
    try {
      const [top] = await d.detect(text);
      if (!top?.detectedLanguage || (top.confidence ?? 0) < MIN_CONFIDENCE) return DEFAULT_SOURCE;
      return top.detectedLanguage.split("-")[0]!.toLowerCase();
    } catch {
      return DEFAULT_SOURCE;
    }
  }

  return {
    async translate(text) {
      if (!env.translator || text.trim() === "") return null;
      const cached = cache.get(text);
      if (cached !== undefined) return cached;
      const source = await sourceLanguageOf(text);
      if (source === TARGET) return null;
      const translator = await getTranslator(source);
      if (!translator) return null;
      let out: string;
      try {
        out = await translateParagraphs(translator, text);
      } catch {
        return null;
      }
      if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value!);
      cache.set(text, out);
      return out;
    },

    prime() {
      const factory = env.translator;
      if (!factory || priming || primed) return;
      priming = true;
      // `create()` chamado DENTRO do gesto — é o que o navegador exige para baixar o modelo.
      const pending = factory.create(pairFor(DEFAULT_SOURCE));
      if (env.detector && !detector) {
        detector = env.detector.create().catch(() => {
          detector = null;
          return null;
        });
      }
      pending
        .then((translator) => {
          primed = true;
          translators.set(DEFAULT_SOURCE, Promise.resolve(translator));
          for (const listener of [...listeners]) listener();
        })
        .catch(() => { /* sem modelo: segue mostrando o original */ })
        .finally(() => { priming = false; });
    },

    onReady(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}

/* ------------------------------------------------------------- o do navegador */

let shared: ReasoningTranslator | null = null;

/** O tradutor deste navegador (um só, para o cache valer entre os cards). */
export function reasoningTranslator(): ReasoningTranslator {
  if (!shared) {
    const g = globalThis as { Translator?: TranslatorFactory; LanguageDetector?: DetectorFactory };
    shared = createReasoningTranslator({
      translator: g.Translator,
      detector: g.LanguageDetector,
      userActive: () =>
        (typeof navigator !== "undefined" &&
          (navigator as { userActivation?: { isActive?: boolean } }).userActivation?.isActive) === true,
    });
  }
  return shared;
}

/** Test seam: esquece o tradutor (e o cache) para o próximo teste montar o seu. */
export function resetReasoningTranslatorForTesting(): void {
  shared = null;
}

/**
 * A tradução de `text`, ou `null` enquanto não há (ou não haverá) uma. `enabled` falso — o bloco
 * ainda chegando, a interface em inglês — não traduz nada: traduzir pedaço a pedaço faria o texto
 * pular na tela. Quando o modelo termina de baixar (`onReady`), tenta de novo sozinho.
 */
export function useReasoningTranslation(text: string, enabled: boolean): string | null {
  const translator = reasoningTranslator();
  const [result, setResult] = React.useState<{ text: string; out: string | null } | null>(null);
  const [readyTick, bump] = React.useReducer((n: number) => n + 1, 0);

  React.useEffect(() => translator.onReady(bump), [translator]);

  React.useEffect(() => {
    if (!enabled) return;
    let live = true;
    void translator.translate(text).then((out) => {
      if (live) setResult({ text, out });
    });
    return () => { live = false; };
  }, [translator, text, enabled, readyTick]);

  return enabled && result?.text === text ? result.out : null;
}
