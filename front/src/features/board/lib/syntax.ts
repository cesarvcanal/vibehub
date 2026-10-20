/**
 * Cor de sintaxe dos diffs, no padrão das IDEs (VS Code / Cursor): cada token na cor do tema
 * Dark+ (ou Light+ no tema claro) e o tipo da linha dito pelo FUNDO, não pelo texto.
 *
 * O Shiki e as gramáticas só carregam quando um diff aparece na tela (import dinâmico): quem não
 * abre diff não paga o peso. Enquanto carrega, a linha sai na cor normal do texto.
 */
import type { HighlighterCore, LanguageInput } from "shiki/core";
import type { DiffRow } from "@/features/board/lib/toolDiff";

/** Um pedaço da linha com a cor dos dois temas (ausente = cor normal do texto). */
export interface SynToken { text: string; dark?: string; light?: string }

type Loader = () => Promise<{ default: LanguageInput }>;

/** Gramáticas suportadas. Explícitas para o bundler gerar só esses chunks. */
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

/** A linguagem pelo nome do arquivo; null quando não há gramática para ele. PURE. */
export function langFromPath(path: string | null | undefined): string | null {
  const name = String(path ?? "").split(/[\\/]/).pop()?.toLowerCase() ?? "";
  if (!name) return null;
  if (BY_NAME[name]) return BY_NAME[name]!;
  const dot = name.lastIndexOf(".");
  const byExt = dot < 0 ? undefined : BY_EXT[name.slice(dot + 1)];
  if (byExt) return byExt;
  // `Dockerfile.prod`, `dockerfile.dev`: o sufixo não é extensão de linguagem.
  return name.startsWith("dockerfile.") ? "dockerfile" : null;
}

/** Acima disso não colore: tokenizar um arquivo gigante trava a aba e ninguém lê tudo. */
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
  // Falhou (rede, chunk de um deploy antigo): a próxima chamada tenta de novo em vez de herdar o erro.
  core.catch(() => {
    core = null;
  });
  return core;
}

/**
 * Tokens por linha de `code`, nas cores dos dois temas. null quando a linguagem não é suportada,
 * o texto é grande demais ou a gramática falhou — quem chama desenha sem cor.
 */
export async function highlightLines(code: string, lang: string | null): Promise<SynToken[][] | null> {
  if (!lang || !LANGS[lang] || code.length > MAX_CHARS) return null;
  try {
    let ready = loaded.get(lang);
    if (!ready) {
      // A gramática baixa junto com o núcleo, não depois dele.
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
 * Tokens para cada linha de um diff (null nas `hunk` ou sem cor). Cada trecho é colorido como os
 * dois pedaços de arquivo que forma — o antigo (contexto + removidas) e o novo (contexto +
 * adicionadas) — para um comentário ou string de várias linhas sair certo, como na IDE. Trechos são
 * independentes: um comentário aberto num não vaza para o próximo, que está longe no arquivo.
 */
export async function highlightDiff(rows: readonly DiffRow[], lang: string | null): Promise<(SynToken[] | null)[] | null> {
  const segments: DiffRow[][] = [[]];
  for (const row of rows) {
    if (row.kind === "hunk") segments.push([]);
    else segments[segments.length - 1]!.push(row);
  }
  const colored = await Promise.all(segments.map((seg) => highlightSegment(seg, lang)));
  if (colored.some((c) => c === null)) return null;
  // Remonta na ordem original: cada `hunk` abre o próximo segmento.
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

/** Tokens de um trecho sem separadores; o lado antigo só é tokenizado se houver removida. */
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

/** Um pedaço desenhável: o token (ou parte dele) e se cai no trecho que mudou dentro da linha. */
export interface SynPiece extends SynToken { marked: boolean }

/** Corta os tokens no intervalo `mark` [início, fim) para o destaque da palavra não apagar a cor. PURE. */
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
