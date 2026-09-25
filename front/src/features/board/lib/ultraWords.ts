/**
 * The two words Claude Code reserves: `ultrathink` and `ultracode`.
 *
 * They are not decoration. The CLI reads both out of what you type and acts on them — `ultrathink`
 * asks for deeper reasoning on that turn, `ultracode` opts the turn into multi-agent orchestration
 * (the Workflow tool). The TUI answers by painting the word in a rainbow with a bright band
 * sweeping through the letters, which is the ONLY sign the keyword was seen at all.
 *
 * The panel's composer is a different field from the TUI's input line, so none of that reached the
 * person typing here: the word went in as grey text and the effect only existed inside the
 * terminal. This module is the port — the same palette, the same sweep, the same rules for what
 * counts as the keyword — so the panel says the same thing the CLI does, in the same colours.
 *
 * Everything here is PURE and framework-free; `UltraText` renders it and `sdk-driver.mjs` mirrors
 * the detection on the back end.
 */

/** The keywords, exactly as the CLI spells them. */
export type UltraKeyword = "ultrathink" | "ultracode";

/**
 * The TUI's rainbow, per letter (`rainbow_red` … `rainbow_violet`), taken from Claude Code's own
 * theme so the panel is not "a rainbow" but THE rainbow. Letter N of a keyword takes colour N % 7.
 */
export const ULTRA_RAINBOW = [
  "rgb(235,95,87)",
  "rgb(245,139,87)",
  "rgb(250,195,95)",
  "rgb(145,200,130)",
  "rgb(130,170,220)",
  "rgb(155,130,200)",
  "rgb(200,130,180)",
] as const;

/** The same seven hues, lightened — what a letter turns while the sweep is over it. */
export const ULTRA_SHIMMER = [
  "rgb(250,155,147)",
  "rgb(255,185,137)",
  "rgb(255,225,155)",
  "rgb(185,230,180)",
  "rgb(180,205,240)",
  "rgb(195,180,230)",
  "rgb(230,180,210)",
] as const;

/**
 * The sweep, in the TUI's own numbers: the bright band moves ONE character every 50 ms, is THREE
 * characters wide (the letter under it and its two neighbours), and rests for ten characters on
 * either side of the word before coming round again. A keyword is therefore `length + 20` steps
 * long, of which three are lit — close enough to a tenth that `UltraText` can use a fixed 10 %
 * bright window in CSS instead of generating keyframes per word.
 */
export const ULTRA_STEP_MS = 50;
export const ULTRA_PAD = 10;
export const ULTRA_BAND = 3;

/** One keyword found in the text, with where it sits. */
export interface UltraMatch {
  /** The word as written — the case the person used, which the highlight keeps. */
  word: string;
  keyword: UltraKeyword;
  start: number;
  /** Exclusive, like `String.prototype.slice`. */
  end: number;
}

/** Word characters, for the "is this glued to something?" tests below. Unicode-aware, as the CLI's. */
const WORDISH = /[\p{L}\p{N}_]/u;

/** Openers the CLI treats as "quoted": a keyword inside one of these is text, not a request. */
const CLOSERS: Record<string, string> = {
  "`": "`",
  '"': '"',
  "<": ">",
  "{": "}",
  "[": "]",
  "(": ")",
  "'": "'",
};

/**
 * The spans of `text` that sit inside a quote, a bracket or a tag — the CLI's own scan, so a
 * `` `ultracode` `` being DISCUSSED never reads as a `ultracode` being asked for. PURE.
 */
function quotedSpans(text: string): { start: number; end: number }[] {
  const spans: { start: number; end: number }[] = [];
  const wordish = (c: string | undefined): boolean => !!c && WORDISH.test(c);
  let opener: string | null = null;
  let from = 0;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i] as string;
    if (opener) {
      // `[[` restarts the span: the inner bracket is the one that will be closed.
      if (opener === "[" && c === "[") {
        from = i;
        continue;
      }
      if (c !== CLOSERS[opener]) continue;
      // An apostrophe inside a word ("don't") closes nothing — it was never an opener.
      if (opener === "'" && wordish(text[i + 1])) continue;
      spans.push({ start: from, end: i + 1 });
      opener = null;
    } else if (
      (c === "<" && i + 1 < text.length && /[a-zA-Z/]/.test(text[i + 1] as string)) ||
      (c === "'" && !wordish(text[i - 1])) ||
      (c !== "<" && c !== "'" && c in CLOSERS)
    ) {
      opener = c;
      from = i;
    }
  }
  return spans;
}

/**
 * Every occurrence of one keyword, under the CLI's rules:
 *  - a message that STARTS with `/` is a slash command, and nothing in it is a keyword;
 *  - a hit inside a quote/bracket/tag does not count (see `quotedSpans`);
 *  - a hit glued to a path or a flag does not count either — `-ultracode`, `ultracode/x`,
 *    `ultracode.ts` are a flag, a path and a filename, not the word.
 * Case-insensitive, because the person's caps are their caps: `ULTRATHINK` is the same request.
 * PURE, TOTAL.
 */
export function findKeyword(text: string, keyword: UltraKeyword): UltraMatch[] {
  const source = String(text ?? "");
  if (source.startsWith("/")) return [];
  const spans = quotedSpans(source);
  const wordish = (c: string | undefined): boolean => !!c && WORDISH.test(c);
  const out: UltraMatch[] = [];
  for (const m of source.matchAll(new RegExp(`\\b${keyword}\\b`, "gi"))) {
    if (m.index === undefined) continue;
    const start = m.index;
    const end = start + m[0].length;
    if (spans.some((s) => start >= s.start && start < s.end)) continue;
    const before = source[start - 1];
    const after = source[end];
    if (before === "/" || before === "\\" || before === "-") continue;
    if (after === "/" || after === "\\" || after === "-" || after === "?") continue;
    if (after === "." && wordish(source[end + 1])) continue;
    out.push({ word: m[0], keyword, start, end });
  }
  return out;
}

/** Both keywords, in the order they appear. PURE, TOTAL. */
export function findUltraWords(text: string): UltraMatch[] {
  return [...findKeyword(text, "ultrathink"), ...findKeyword(text, "ultracode")].sort(
    (a, b) => a.start - b.start,
  );
}

/** Which keywords this message carries — what the back end escalates on. PURE, TOTAL. */
export function ultraKeywords(text: string): { ultrathink: boolean; ultracode: boolean } {
  return {
    ultrathink: findKeyword(text, "ultrathink").length > 0,
    ultracode: findKeyword(text, "ultracode").length > 0,
  };
}

/** Is there anything to paint? Cheap enough to call on every keystroke. PURE, TOTAL. */
export function hasUltraWord(text: string): boolean {
  if (!/ultra(think|code)/i.test(String(text ?? ""))) return false; // the common answer, without the walk
  return findUltraWords(text).length > 0;
}

/** The colour a letter takes, by its position inside the keyword. PURE, TOTAL. */
export function ultraColor(index: number, shimmer = false): string {
  const palette = shimmer ? ULTRA_SHIMMER : ULTRA_RAINBOW;
  return palette[((index % palette.length) + palette.length) % palette.length] as string;
}

/** How long one full sweep of a keyword takes, in ms: `(length + 20) × 50`. PURE, TOTAL. */
export function ultraCycleMs(wordLength: number): number {
  return (wordLength + 2 * ULTRA_PAD) * ULTRA_STEP_MS;
}

/**
 * The CSS `animation-delay` for letter `index` of a keyword `wordLength` long.
 *
 * The band lights letter `i` at `t = i × 50 ms` into the cycle, and the keyframes put their bright
 * window at the START — so each letter needs the animation to have ALREADY been running when the
 * page paints, which is what a negative delay means. Always negative, always inside one cycle.
 * PURE, TOTAL.
 */
export function ultraDelayMs(index: number, wordLength: number): number {
  const cycle = wordLength + 2 * ULTRA_PAD;
  const lit = index + ULTRA_PAD - 1; // the step at which this letter enters the band
  return (lit - cycle) * ULTRA_STEP_MS;
}
