import * as React from "react";

/**
 * THE REASONING TRANSLATED IN THE BROWSER — display only, no tokens at all.
 *
 * Before, the driver asked the model to think in Portuguese (7bf6ace). Two things were wrong with that:
 *   - what the screen shows is the reasoning SUMMARY (`display: "summarized"`), and it sometimes
 *     followed the instruction, sometimes came back in English;
 *   - an instruction about the reasoning in the system prompt is the known trigger of Opus's
 *     `[reasoning_extraction]` block (card #3684).
 *
 * Now the model knows nothing about it: Chrome (138+) and Edge (148+) ship `Translator` and
 * `LanguageDetector`, small LOCAL models (translation ones, not Gemini Nano) — nothing leaves the
 * machine and nothing is billed. Without the API (Firefox, Safari, old browser), while the language
 * pack has not downloaded, or when in doubt about the text's language, the screen shows the
 * original: the translation is an extra, never a point of failure — and it never ruins a text that
 * was already readable.
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
   * The browser only DOWNLOADS the model inside a user gesture (click, key). Outside it, `create()`
   * of a model not yet downloaded is refused — so we do not even try.
   */
  userActive?: () => boolean;
}

export interface ReasoningTranslator {
  /** Does the browser have the API? Without it, nobody even tries (nor schedules pointless work). */
  readonly supported: boolean;
  /** The text in Portuguese, or `null` = show the original (already Portuguese, no API, in doubt...). */
  translate(text: string): Promise<string | null>;
  /**
   * Called in a user gesture: downloads ONE model per gesture (the translator, then the detector) and
   * notifies `onReady` when each one is ready. Downloading consumes the gesture — a second `create()`
   * in the same click gets NotAllowedError (proven on Chrome 154) —, so it keeps trying on the next
   * gestures.
   */
  prime(): void;
  onReady(listener: () => void): () => void;
}

/** The target is always Portuguese: only the pt-BR interface translates (English is the language the model thinks in). */
const TARGET = "pt";
/** The language the model thinks in by default — the pair `prime()` downloads. */
const DEFAULT_SOURCE = "en";
/** Below this the detection is a guess (text too short, mixed): the local heuristic decides. */
const MIN_CONFIDENCE = 0.5;
/** Already-translated blocks kept: reopening the conversation does not redo the work. */
const CACHE_LIMIT = 300;

// "me", "do", "so" and "to" are left out: they are extremely common Portuguese, even without accents
// ("Me ajuda aqui", "o log do build", "so falta testar" = só, "to indo" = tô).
const EN_WORDS = new Set(
  ("the and of is that with this it for be need will what how should let from are not on i " +
    "i'll i'm we can if then which there have has was but does first now").split(" "),
);
// Only words that do NOT exist in English ("do", "as", "no", "se", "pro", "algo" exist and held back
// English lines for nothing) — including the informal, unaccented Portuguese of someone typing fast.
const PT_WORDS = new Set(
  ("o os de da dos das que não nao para pra pras pros com um uma é em na nos nas por mais vou " +
    "preciso isso está esse essa este esta mas como já ja também tambem ao pelo pela foi ser tem " +
    "mim aqui agora sem ou eu ele ela vamos depois quando onde porque ainda muito então entao só " +
    "tá ta né ne faz fazer vai ver olha funciona testa ajuda manda roda deu ficou tudo nada meu " +
    "minha seu sua dele dela aí ai").split(" "),
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
 * The LOCAL GUESS for the BLOCK when the detector does not exist (Chrome with `LanguageDetector`
 * "unavailable" is real) or is not sure: counts function words of each language (and accents, which
 * English does not have). In doubt, `null` — and then it is NOT translated: running Portuguese
 * through the en→pt translator ruins it ("...os testes do VOLTAR", adversarial review HIGH-1). For
 * "en" it is enough for ONE line to prove it is English: what goes to the translator is decided by
 * each line (`isEnglishLine`), so a mixed block translates only the English lines. PURE.
 */
export function guessLanguage(text: string): "en" | "pt" | null {
  const { en, pt } = score(text);
  if (en >= 2 && text.split("\n").some(isEnglishLine)) return "en";
  if (pt >= 2) return "pt";
  return null;
}

/**
 * The LINE goes to the translator only with POSITIVE proof of English (some English function word)
 * and NO sign of Portuguese. Without proof, it stays as it came: informal Portuguese with no known
 * word ("nao funciona aqui, testa ai pra mim") or Portuguese quoting English ("O teste falhou com:
 * Expected...") never go through en→pt. A short English line staying in English is the price. PURE.
 */
function isEnglishLine(line: string): boolean {
  const { en, pt } = score(line);
  return en >= 1 && pt === 0;
}

/** A line longer than this stays as it came: no regex runs over it (no freezing the screen). */
const MAX_LINE = 2000;

/**
 * A line that looks like CODE, a command or an error: the translator would ruin it ("await" →
 * "aguarde", proven on Chrome 154). Keywords only in lowercase and followed by syntax — "If the test
 * fails" is prose.
 */
const CODE_LINE = [
  /[;{}]\s*$/,
  /=>/,
  /^\s*(?:const|let|var|function|import|export|return|if|elif|else|for|while|class|def|async|await|try|catch|except|with)\b.*(?:[=(;{]|:\s*$)/,
  /^\s*at\s+\S.*:\d+(?::\d+)?\)?\s*$/, // stack trace JS
  /^\s*File\s+".*",\s+line\s+\d+/, // traceback Python
  /^\s*[\w.]*(?:Error|Exception)\b[^:]*:/, // "TypeError: ..."
  /^\s*[\w.$[\]]+\s*[-+*/]?=(?!=)/, // assignment
  /^\s*[\w.$]+\([^()]*\)(?:\s*;)?\s*$/, // a lone call (`\s*;?\s*` was quadratic)
  /^\s*(?:\$\s|(?:npm|pnpm|npx|yarn|git|node|python3?|pip|cd|ls|cat|grep|curl|docker|make|cargo|go)\s)/, // shell
];
const FENCE = /^\s*(?:```|~~~)/;
/**
 * Quote/heading/list/checkbox/numbering marker: stays intact ("- [ ]" became "- []"; ">" and "##"
 * went along to the translator). No backtracking.
 */
const LIST_MARKER = /^(?:(?:>\s*)+|#{1,6}\s+|[-*+]\s+(?:\[[ xX]\](?:\s+|$))?|\d+[.)]\s+)/;

/**
 * Translates LINE by line: the local translator joins the lines of the same chunk ("- a - b", proven
 * on Chrome 154), and the reasoning is drawn with `whitespace-pre-wrap` — lists and steps must stay
 * one per line. Stays as it came: ``` / ~~~ block, code line, giant line and line without proof of
 * English. Indentation, marker and trailing space survive (cut with trim, no lazy regex — it was
 * quadratic on a line with lots of whitespace).
 */
async function translateLines(translator: TranslatorLike, text: string): Promise<string> {
  const out: string[] = [];
  let inFence = false;
  for (const line of text.split("\n")) {
    // the fence BEFORE the size limit: a giant ``` line still opens/closes the code block
    if (FENCE.test(line)) {
      inFence = !inFence;
      out.push(line);
      continue;
    }
    if (line.length > MAX_LINE) {
      out.push(line);
      continue;
    }
    if (inFence || line.trim() === "" || CODE_LINE.some((re) => re.test(line)) || !isEnglishLine(line)) {
      out.push(line);
      continue;
    }
    const body = line.trimStart();
    const indent = line.slice(0, line.length - body.length);
    // STACKED markers ("> - [ ]", "## 1.") — consumes one at a time; each pass eats ≥1 char
    let marker = "";
    let rest = body;
    for (let m = LIST_MARKER.exec(rest)?.[0]; m; m = LIST_MARKER.exec(rest)?.[0]) {
      marker += m;
      rest = rest.slice(m.length);
    }
    const core = rest.trimEnd();
    out.push(core === "" ? line : indent + marker + (await translator.translate(core)) + rest.slice(core.length));
  }
  return out.join("\n");
}

export function createReasoningTranslator(env: TranslationEnv): ReasoningTranslator {
  const cache = new Map<string, string>();
  const translators = new Map<string, Promise<TranslatorLike | null>>();
  let detector: Promise<DetectorLike | null> | null = null;
  /** A download in progress (one per gesture). */
  let priming = false;
  /** Translator/detector READY — a still-pending check does not count (it may come to nothing). */
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

  /** Keeps only SUCCESS: a failure (or "not downloaded yet") tries again next time. */
  function remember<T>(map: Map<string, Promise<T | null>>, key: string, make: () => Promise<T | null>): Promise<T | null> {
    const hit = map.get(key);
    if (hit) return hit;
    const pending: Promise<T | null> = make()
      .catch(() => null)
      .then((value) => {
        // only deletes ITSELF: prime() may have put a ready translator in its place while this was waiting
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

  /** The text's language, or `null` = no way to know (and then it is not translated). */
  async function sourceLanguageOf(text: string): Promise<string | null> {
    const d = await getDetector();
    if (d) {
      try {
        const [top] = await d.detect(text);
        if (top?.detectedLanguage && (top.confidence ?? 0) >= MIN_CONFIDENCE) {
          return top.detectedLanguage.split("-")[0]!.toLowerCase();
        }
      } catch {
        /* falls back to the heuristic */
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
      // Only English → Portuguese: the line filter (`isEnglishLine`) is for English, and with another
      // language detected it would send English lines to an es→pt translator (4th review).
      if (source !== DEFAULT_SOURCE) return null;
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
      // `create()` called INSIDE the gesture — it is what the browser requires to download the model.
      // One per gesture: the first download consumes the gesture, and a second create() here would
      // be refused.
      if (!translatorReady) {
        priming = true;
        factory
          .create(pairFor(DEFAULT_SOURCE))
          .then((translator) => {
            translatorReady = true;
            translators.set(DEFAULT_SOURCE, Promise.resolve(translator));
            announce();
          })
          .catch(() => { /* no model now: the next gesture tries again */ })
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
        .catch(() => { /* same: the next gesture tries again */ })
        .finally(() => { priming = false; });
    },

    onReady(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}

/* ------------------------------------------------------------- the browser's */

let shared: ReasoningTranslator | null = null;

/** This browser's translator (a single one, so the cache holds across cards). */
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

/** Test seam: forgets the translator (and the cache) so the next test builds its own. */
export function resetReasoningTranslatorForTesting(): void {
  shared = null;
}

/**
 * The translation of `text`, or `null` while there is not (or will not be) one. `enabled` false —
 * the block still arriving, the interface in English — translates nothing: translating chunk by
 * chunk would make the text jump on screen. When a model finishes downloading (`onReady`), it tries
 * again on its own.
 */
export function useReasoningTranslation(text: string, enabled: boolean): string | null {
  const translator = reasoningTranslator();
  const [result, setResult] = React.useState<{ text: string; out: string | null } | null>(null);
  const [readyTick, bump] = React.useReducer((n: number) => n + 1, 0);

  React.useEffect(() => translator.onReady(bump), [translator]);

  React.useEffect(() => {
    // without the API, does not even schedule: nothing to translate, and no pointless setState after render
    if (!enabled || !translator.supported) return;
    let live = true;
    void translator.translate(text).then((out) => {
      if (live) setResult({ text, out });
    });
    return () => { live = false; };
  }, [translator, text, enabled, readyTick]);

  return enabled && result?.text === text ? result.out : null;
}
