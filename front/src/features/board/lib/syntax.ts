/**
 * Syntax color for diffs, IDE-style (VS Code / Cursor): each token in the color of the Dark+ theme
 * (or Light+ in the light theme) and the line's type told by the BACKGROUND, not by the text.
 *
 * Shiki and the grammars only load when a diff appears on screen (dynamic import): whoever does not
 * open a diff does not pay the weight. While it loads, the line comes out in the normal text color.
 */
import type { HighlighterCore, LanguageInput } from "shiki/core";
import type { DiffRow } from "@/features/board/lib/toolDiff";

/** A piece of the line with the color of both themes (absent = normal text color). */
export interface SynToken { text: string; dark?: string; light?: string }

type Loader = () => Promise<{ default: LanguageInput }>;

/** Supported grammars. Explicit so the bundler generates only these chunks. */
const LANGS: Record<string, Loader> = {
  typescript: () => import("shiki/langs/typescript.mjs"),
  tsx: () => import("shiki/langs/tsx.mjs"),
  javascript: () => import("shiki/langs/javascript.mjs"),
  jsx: () => import("shiki/langs/jsx.mjs"),
  json: () => import("shiki/langs/json.mjs"),
  jsonc: () => import("shiki/langs/jsonc.mjs"),
  css: () => import("shiki/langs/css.mjs"),
  scss: () => import("shiki/langs/scss.mjs"),
  html: () => import("shiki/langs/html.mjs"),
  vue: () => import("shiki/langs/vue.mjs"),
  markdown: () => import("shiki/langs/markdown.mjs"),
  yaml: () => import("shiki/langs/yaml.mjs"),
  toml: () => import("shiki/langs/toml.mjs"),
  shellscript: () => import("shiki/langs/shellscript.mjs"),
  dockerfile: () => import("shiki/langs/dockerfile.mjs"),
  sql: () => import("shiki/langs/sql.mjs"),
  python: () => import("shiki/langs/python.mjs"),
  go: () => import("shiki/langs/go.mjs"),
  rust: () => import("shiki/langs/rust.mjs"),
  java: () => import("shiki/langs/java.mjs"),
  php: () => import("shiki/langs/php.mjs"),
  ruby: () => import("shiki/langs/ruby.mjs"),
  csharp: () => import("shiki/langs/csharp.mjs"),
  c: () => import("shiki/langs/c.mjs"),
  cpp: () => import("shiki/langs/cpp.mjs"),
  xml: () => import("shiki/langs/xml.mjs"),
  prisma: () => import("shiki/langs/prisma.mjs"),
};

const BY_EXT: Record<string, string> = {
  ts: "typescript", mts: "typescript", cts: "typescript", tsx: "tsx",
  js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "jsx",
  json: "json", jsonc: "jsonc", json5: "jsonc",
  css: "css", scss: "scss", html: "html", htm: "html", vue: "vue",
  md: "markdown", mdx: "markdown", yml: "yaml", yaml: "yaml", toml: "toml",
  sh: "shellscript", bash: "shellscript", zsh: "shellscript",
  sql: "sql", py: "python", go: "go", rs: "rust", java: "java", php: "php", rb: "ruby",
  cs: "csharp", c: "c", h: "c", cpp: "cpp", cc: "cpp", hpp: "cpp", xml: "xml", svg: "xml", prisma: "prisma",
};

const BY_NAME: Record<string, string> = { dockerfile: "dockerfile", ".bashrc": "shellscript", ".zshrc": "shellscript" };

/** The language from the file name; null when there is no grammar for it. PURE. */
export function langFromPath(path: string | null | undefined): string | null {
  const name = String(path ?? "").split(/[\\/]/).pop()?.toLowerCase() ?? "";
  if (!name) return null;
  if (BY_NAME[name]) return BY_NAME[name]!;
  const dot = name.lastIndexOf(".");
  const byExt = dot < 0 ? undefined : BY_EXT[name.slice(dot + 1)];
  if (byExt) return byExt;
  // `Dockerfile.prod`, `dockerfile.dev`: the suffix is not a language extension.
  return name.startsWith("dockerfile.") ? "dockerfile" : null;
}

/** Above this it does not color: tokenizing a giant file freezes the tab and nobody reads it all. */
const MAX_CHARS = 200_000;

let core: Promise<HighlighterCore> | null = null;
const loaded = new Map<string, Promise<void>>();

function highlighter(): Promise<HighlighterCore> {
  core ??= (async () => {
    const [{ createHighlighterCore }, { createJavaScriptRegexEngine }] = await Promise.all([
      import("shiki/core"),
      import("shiki/engine/javascript"),
    ]);
    return createHighlighterCore({
      themes: [import("shiki/themes/dark-plus.mjs"), import("shiki/themes/light-plus.mjs")],
      langs: [],
      engine: createJavaScriptRegexEngine({ forgiving: true }),
    });
  })();
  // Failed (network, chunk from an old deploy): the next call tries again instead of inheriting the error.
  core.catch(() => {
    core = null;
  });
  return core;
}

/**
 * Tokens per line of `code`, in the colors of both themes. null when the language is not supported,
 * the text is too big or the grammar failed — the caller draws without color.
 */
export async function highlightLines(code: string, lang: string | null): Promise<SynToken[][] | null> {
  if (!lang || !LANGS[lang] || code.length > MAX_CHARS) return null;
  try {
    let ready = loaded.get(lang);
    if (!ready) {
      // The grammar downloads together with the core, not after it.
      ready = Promise.all([highlighter(), LANGS[lang]!()]).then(([h, m]) => h.loadLanguage(m.default));
      ready.catch(() => loaded.delete(lang));
      loaded.set(lang, ready);
    }
    await ready;
    const h = await highlighter();
    const { tokens } = h.codeToTokens(code, { lang, themes: { dark: "dark-plus", light: "light-plus" }, defaultColor: false });
    return tokens.map((line) => line.map((tok) => {
      const style = (tok.htmlStyle ?? {}) as Record<string, string>;
      return { text: tok.content, dark: style["--shiki-dark"], light: style["--shiki-light"] };
    }));
  } catch {
    return null;
  }
}

/**
 * Tokens for each line of a diff (null on `hunk` rows or without color). Each hunk is colored as the
 * two file pieces it forms — the old one (context + removed) and the new one (context + added) — so
 * a multi-line comment or string comes out right, as in the IDE. Hunks are independent: a comment
 * opened in one does not leak into the next, which is far away in the file.
 */
export async function highlightDiff(rows: readonly DiffRow[], lang: string | null): Promise<(SynToken[] | null)[] | null> {
  const segments: DiffRow[][] = [[]];
  for (const row of rows) {
    if (row.kind === "hunk") segments.push([]);
    else segments[segments.length - 1]!.push(row);
  }
  const colored = await Promise.all(segments.map((seg) => highlightSegment(seg, lang)));
  if (colored.some((c) => c === null)) return null;
  // Reassembles in the original order: each `hunk` opens the next segment.
  const out: (SynToken[] | null)[] = [];
  let k = 0;
  let j = 0;
  for (const row of rows) {
    if (row.kind === "hunk") {
      out.push(null);
      k++;
      j = 0;
    } else {
      out.push(colored[k]![j++] ?? null);
    }
  }
  return out;
}

/** Tokens of a hunk without separators; the old side is only tokenized if there is a removed line. */
async function highlightSegment(rows: readonly DiffRow[], lang: string | null): Promise<(SynToken[] | null)[] | null> {
  if (rows.length === 0) return [];
  const before: string[] = [];
  const after: string[] = [];
  for (const row of rows) {
    if (row.kind === "del" || row.kind === "ctx") before.push(row.text);
    if (row.kind === "add" || row.kind === "ctx") after.push(row.text);
  }
  const hasDel = rows.some((r) => r.kind === "del");
  const [old, neu] = await Promise.all([hasDel ? highlightLines(before.join("\n"), lang) : [], highlightLines(after.join("\n"), lang)]);
  if (!old || !neu) return null;
  let o = 0;
  let n = 0;
  return rows.map((row) => {
    if (row.kind === "del") return old[o++] ?? null;
    if (row.kind === "ctx") o++;
    return neu[n++] ?? null;
  });
}

/** A drawable piece: the token (or part of it) and whether it falls in the range that changed inside the line. */
export interface SynPiece extends SynToken { marked: boolean }

/** Cuts the tokens at the `mark` range [start, end) so the word highlight does not wipe the color. PURE. */
export function splitByMark(tokens: readonly SynToken[], mark: readonly [number, number] | null): SynPiece[] {
  const out: SynPiece[] = [];
  let pos = 0;
  for (const tok of tokens) {
    const start = pos;
    const end = pos + tok.text.length;
    pos = end;
    if (!mark || end <= mark[0] || start >= mark[1]) {
      out.push({ ...tok, marked: false });
      continue;
    }
    const cuts = [start, Math.max(start, mark[0]), Math.min(end, mark[1]), end];
    for (let k = 0; k < 3; k++) {
      const a = cuts[k]!;
      const b = cuts[k + 1]!;
      if (b > a) out.push({ ...tok, text: tok.text.slice(a - start, b - start), marked: k === 1 });
    }
  }
  return out;
}
