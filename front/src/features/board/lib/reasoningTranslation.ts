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
 * máquina e nada é cobrado. Sem a API (Firefox, Safari, navegador antigo), enquanto o pacote de
 * idioma não baixou, ou na dúvida sobre o idioma do texto, a tela mostra o original: a tradução é um
 * extra, nunca um ponto de falha — e nunca estraga um texto que já estava legível.
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
  /** O navegador tem a API? Sem ela, ninguém nem tenta (nem agenda trabalho à toa). */
  readonly supported: boolean;
  /** O texto em português, ou `null` = mostre o original (já é português, sem API, na dúvida...). */
  translate(text: string): Promise<string | null>;
  /**
   * Chamado num gesto do usuário: baixa UM modelo por gesto (o tradutor, depois o detector) e avisa
   * `onReady` quando cada um fica pronto. Baixar consome o gesto — um segundo `create()` no mesmo
   * clique leva NotAllowedError (provado no Chrome 154) —, então insiste nos gestos seguintes.
   */
  prime(): void;
  onReady(listener: () => void): () => void;
}

/** O alvo é sempre português: só a interface em pt-BR traduz (inglês é o idioma em que o modelo pensa). */
const TARGET = "pt";
/** O idioma em que o modelo pensa por padrão — o par que o `prime()` baixa. */
const DEFAULT_SOURCE = "en";
/** Abaixo disso a detecção é chute (texto curto demais, misturado): decide a heurística local. */
const MIN_CONFIDENCE = 0.5;
/** Blocos já traduzidos guardados: reabrir a conversa não refaz o trabalho. */
const CACHE_LIMIT = 300;

const EN_WORDS = new Set(
  ("the and to of is that with this it for be need will what how should let me from are not on i " +
    "i'll i'm we can if then which there have has was but so do does first now").split(" "),
);
// Só palavras que NÃO existem em inglês: "do", "as", "no", "se" seguravam linhas inglesas à toa.
const PT_WORDS = new Set(
  ("o os de da dos das que não para com um uma é em na nos nas por mais vou preciso isso está " +
    "esse essa este esta mas como já também ao pelo pela foi ser tem").split(" "),
);
const PT_ACCENT = /[ãõçáéíóúâêô]/;

function score(text: string): { en: number; pt: number } {
  const words = text.toLowerCase().match(/[\p{L}']+/gu) ?? [];
  let en = 0;
  let pt = 0;
  for (const w of words) {
    if (EN_WORDS.has(w)) en++;
    if (PT_WORDS.has(w)) pt++;
    if (PT_ACCENT.test(w)) pt += 2;
  }
  return { en, pt };
}

/**
 * O PALPITE LOCAL para o BLOCO quando o detector não existe (Chrome com `LanguageDetector`
 * "unavailable" é real) ou não tem certeza: conta palavras-função de cada língua (e acento, que
 * inglês não tem). Na dúvida, `null` — e aí NÃO se traduz: passar português pelo tradutor en→pt o
 * estraga ("...os testes do VOLTAR", revisão adversarial HIGH-1). Pode ser brando com o inglês porque
 * cada LINHA ainda tem veto (`hasPortuguese`). PURA.
 */
export function guessLanguage(text: string): "en" | "pt" | null {
  const { en, pt } = score(text);
  if (en >= 2 && en > pt) return "en";
  if (pt >= 2 && pt >= en) return "pt";
  return null;
}

/** Qualquer sinal de português na linha — palavra-função ou acento. Ela fica como veio. PURA. */
function hasPortuguese(line: string): boolean {
  return score(line).pt > 0;
}

/**
 * Linha com cara de CÓDIGO ou de stack trace: o tradutor a estragaria ("await" → "aguarde", provado
 * no Chrome 154). Só palavras-chave em minúscula, seguidas de sintaxe — "If the test fails" é prosa.
 */
const CODE_LINE =
  /[;{}]\s*$|=>|^\s*(?:const|let|var|function|import|export|return|if|for|while|class|def|async|await|try|catch)\b.*[=(;{]|^\s*at\s+\S.*\(.*:\d+(?::\d+)?\)\s*$|^\s*\$\s/;
/** Indentação + marcador de lista/checkbox/numeração: fica intacto ("- [ ]" virava "- []"). */
const LINE_PREFIX = /^(\s*(?:[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+)?)([\s\S]*?)(\s*)$/;

/**
 * Traduz LINHA por linha: o tradutor local junta as linhas de um mesmo pedaço ("- a - b", provado no
 * Chrome 154), e o raciocínio é desenhado com `whitespace-pre-wrap` — listas e passos precisam
 * continuar um por linha. Fica como veio: bloco ```, linha de código, e linha com qualquer sinal de
 * português (português que CITA saída em inglês virava "o testo falhou com:" — re-revisão MEDIUM-A).
 */
async function translateLines(translator: TranslatorLike, text: string): Promise<string> {
  const out: string[] = [];
  let inFence = false;
  for (const line of text.split("\n")) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      out.push(line);
      continue;
    }
    if (inFence || line.trim() === "" || CODE_LINE.test(line) || hasPortuguese(line)) {
      out.push(line);
      continue;
    }
    const [, lead, core, trail] = LINE_PREFIX.exec(line)!;
    out.push(core === "" ? line : lead! + (await translator.translate(core!)) + trail!);
  }
  return out.join("\n");
}

export function createReasoningTranslator(env: TranslationEnv): ReasoningTranslator {
  const cache = new Map<string, string>();
  const translators = new Map<string, Promise<TranslatorLike | null>>();
  let detector: Promise<DetectorLike | null> | null = null;
  /** Um download em andamento (um por gesto). */
  let priming = false;
  /** Tradutor/detector PRONTOS — uma checagem ainda pendente não conta (ela pode dar em nada). */
  let translatorReady = false;
  let detectorReady = false;
  const listeners = new Set<() => void>();
  const userActive = env.userActive ?? (() => false);

  function pairFor(source: string): Pair {
    return { sourceLanguage: source, targetLanguage: TARGET };
  }

  function announce(): void {
    for (const listener of [...listeners]) listener();
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
    const pending: Promise<DetectorLike | null> = (async () => {
      const availability = await factory.availability();
      if (availability === "unavailable") return null;
      if (availability !== "available" && !userActive()) return null;
      return factory.create();
    })()
      .catch(() => null)
      .then((value) => {
        if (value === null && detector === pending) detector = null;
        return value;
      });
    detector = pending;
    return pending;
  }

  /** O idioma do texto, ou `null` = não dá pra saber (e então não se traduz). */
  async function sourceLanguageOf(text: string): Promise<string | null> {
    const d = await getDetector();
    if (d) {
      try {
        const [top] = await d.detect(text);
        if (top?.detectedLanguage && (top.confidence ?? 0) >= MIN_CONFIDENCE) {
          return top.detectedLanguage.split("-")[0]!.toLowerCase();
        }
      } catch {
        /* cai na heurística */
      }
    }
    return guessLanguage(text);
  }

  return {
    supported: Boolean(env.translator),

    async translate(text) {
      if (!env.translator || text.trim() === "") return null;
      const cached = cache.get(text);
      if (cached !== undefined) return cached;
      const source = await sourceLanguageOf(text);
      if (source === null || source === TARGET) return null;
      const translator = await getTranslator(source);
      if (!translator) return null;
      let out: string;
      try {
        out = await translateLines(translator, text);
      } catch {
        return null;
      }
      if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value!);
      cache.set(text, out);
      return out;
    },

    prime() {
      const factory = env.translator;
      if (!factory || priming) return;
      // `create()` chamado DENTRO do gesto — é o que o navegador exige para baixar o modelo. Um por
      // gesto: o primeiro download consome o gesto, e um segundo create() aqui seria recusado.
      if (!translatorReady) {
        priming = true;
        factory
          .create(pairFor(DEFAULT_SOURCE))
          .then((translator) => {
            translatorReady = true;
            translators.set(DEFAULT_SOURCE, Promise.resolve(translator));
            announce();
          })
          .catch(() => { /* sem modelo agora: o próximo gesto tenta de novo */ })
          .finally(() => { priming = false; });
        return;
      }
      const detectorFactory = env.detector;
      if (!detectorFactory || detectorReady) return;
      priming = true;
      detectorFactory
        .create()
        .then((created) => {
          detectorReady = true;
          detector = Promise.resolve(created);
          announce();
        })
        .catch(() => { /* idem: o próximo gesto tenta de novo */ })
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
 * pular na tela. Quando um modelo termina de baixar (`onReady`), tenta de novo sozinho.
 */
export function useReasoningTranslation(text: string, enabled: boolean): string | null {
  const translator = reasoningTranslator();
  const [result, setResult] = React.useState<{ text: string; out: string | null } | null>(null);
  const [readyTick, bump] = React.useReducer((n: number) => n + 1, 0);

  React.useEffect(() => translator.onReady(bump), [translator]);

  React.useEffect(() => {
    // sem a API, nem agenda: nada a traduzir, e nenhum setState à toa depois do render
    if (!enabled || !translator.supported) return;
    let live = true;
    void translator.translate(text).then((out) => {
      if (live) setResult({ text, out });
    });
    return () => { live = false; };
  }, [translator, text, enabled, readyTick]);

  return enabled && result?.text === text ? result.out : null;
}
