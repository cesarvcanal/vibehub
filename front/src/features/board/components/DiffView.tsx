import * as React from "react";
import { cn } from "@/lib/utils";
import { highlightDiff, highlightLines, langFromPath, splitByMark, type SynToken } from "@/features/board/lib/syntax";
import { diffRowsView, type DiffRow, type InlineMark } from "@/features/board/lib/toolDiff";

/**
 * Resultado assíncrono amarrado à entrada que o gerou: troca de entrada volta a null na hora, sem
 * mostrar a cor do diff anterior. A entrada é comparada por referência — quem chama memoiza.
 */
function useAsync<I, O>(input: I | null, run: (input: I) => Promise<O | null>): O | null {
  const [state, setState] = React.useState<{ input: I; out: O } | null>(null);
  React.useEffect(() => {
    if (input === null) return;
    let alive = true;
    void run(input).then((out) => {
      if (alive && out) setState({ input, out });
    });
    return () => {
      alive = false;
    };
  }, [input, run]);
  return state && state.input === input ? state.out : null;
}

const runDiff = ([rows, lang]: readonly [readonly DiffRow[], string]) => highlightDiff(rows, lang);
const runCode = ([text, lang]: readonly [string, string]) => highlightLines(text, lang);

/**
 * As mesmas linhas de antes enquanto o conteúdo não muda: quem chama monta `rows` a cada render
 * (num loop, num `if`), e sem isso cada render do pai re-tokenizaria o diff inteiro.
 */
function sameRow(a: DiffRow, b: DiffRow): boolean {
  if (a.kind !== b.kind || a.text !== b.text) return false;
  return a.kind !== "hunk" || b.kind !== "hunk" || (a.oldStart === b.oldStart && a.newStart === b.newStart);
}

function useStableRows(rows: readonly DiffRow[]): readonly DiffRow[] {
  const ref = React.useRef(rows);
  const prev = ref.current;
  if (prev !== rows && (prev.length !== rows.length || rows.some((r, i) => !sameRow(r, prev[i]!)))) {
    ref.current = rows;
  }
  return ref.current;
}

/** Tokens coloridos de cada linha do diff; null enquanto o Shiki carrega ou sem gramática. */
function useDiffTokens(rows: readonly DiffRow[], path: string | null | undefined) {
  const lang = langFromPath(path);
  const input = React.useMemo(() => (lang ? ([rows, lang] as const) : null), [rows, lang]);
  return useAsync(input, runDiff);
}

/** Tokens coloridos de cada linha de um bloco de código (Read/Write); null sem gramática. */
export function useCodeTokens(text: string, path: string | null | undefined): SynToken[][] | null {
  const lang = langFromPath(path);
  const input = React.useMemo(() => (lang ? ([text, lang] as const) : null), [text, lang]);
  return useAsync(input, runCode);
}

/**
 * O texto de uma linha: com cor de sintaxe quando há tokens, senão na cor normal. `mark` é o trecho
 * que mudou dentro da linha — ganha o fundo mais forte por cima da cor do token.
 */
export function SyntaxText({ text, tokens, mark, markClassName }: {
  text: string;
  tokens: SynToken[] | null | undefined;
  mark?: InlineMark | null;
  markClassName?: string;
}) {
  const pieces = splitByMark(tokens ?? [{ text }], mark ?? null);
  return (
    <>
      {pieces.map((p, i) => {
        const style = p.dark || p.light ? ({ "--syn-dark": p.dark, "--syn-light": p.light } as React.CSSProperties) : undefined;
        if (!p.marked && !style) return <React.Fragment key={i}>{p.text}</React.Fragment>;
        return (
          <span key={i} data-testid={p.marked ? "sdk-diff-mark" : undefined} style={style} className={cn(style && "syn", p.marked && markClassName)}>
            {p.text}
          </span>
        );
      })}
    </>
  );
}

/** Fundo da linha, calha do sinal e destaque do trecho alterado, por tipo de linha. */
const TONE = {
  add: { sign: "+", line: "bg-[var(--diff-add-bg)] text-foreground", gutter: "bg-[var(--diff-add-gutter)] text-[var(--diff-add-sign)]", mark: "bg-[var(--diff-add-word)]" },
  del: { sign: "−", line: "bg-[var(--diff-del-bg)] text-foreground", gutter: "bg-[var(--diff-del-gutter)] text-[var(--diff-del-sign)]", mark: "bg-[var(--diff-del-word)]" },
  ctx: { sign: " ", line: "text-foreground/85", gutter: "text-muted-foreground/50", mark: "" },
} as const;

/**
 * Um diff no padrão das IDEs (VS Code / Cursor): o código mantém a cor da sintaxe (pela extensão de
 * `path`), quem diz o tipo da linha é o fundo verde ou vermelho — mais forte na calha do sinal —,
 * o trecho que mudou dentro da linha ganha o fundo mais forte e, quando o diff diz onde cada trecho
 * começa, a calha mostra o número da linha.
 */
export function DiffView({ rows, path, className, lineTestId, hunkTestId, children }: {
  rows: readonly DiffRow[];
  path?: string | null;
  className?: string;
  lineTestId: string;
  hunkTestId: string;
  children?: React.ReactNode;
}) {
  rows = useStableRows(rows);
  const tokens = useDiffTokens(rows, path);
  const view = React.useMemo(() => diffRowsView(rows), [rows]);
  const numbered = view.some((v) => v.num !== null);
  return (
    <div className={cn("overflow-auto border bg-background/70 font-mono text-xs leading-relaxed", className)}>
      {/* min-w-max: a linha longa rola DENTRO do bloco e o fundo colorido acompanha até o fim dela. */}
      <div className="min-w-max py-0.5">
        {rows.map((row, i) => {
          if (row.kind === "hunk") {
            return (
              <div key={i} aria-hidden={row.text === "⋯" || undefined} data-testid={hunkTestId} data-kind="hunk" className="select-none whitespace-pre border-y border-border/40 bg-muted/40 px-2 text-muted-foreground/70">
                {row.text}
              </div>
            );
          }
          const tone = TONE[row.kind];
          const { num, mark } = view[i]!;
          return (
            <div key={i} data-testid={lineTestId} data-kind={row.kind} className={cn("flex whitespace-pre pr-3", tone.line)}>
              <span aria-hidden className={cn("flex shrink-0 select-none", tone.gutter)}>
                {numbered ? <span className="w-10 pr-1 text-right tabular-nums opacity-70">{num ?? ""}</span> : null}
                <span className="w-5 text-center font-semibold">{tone.sign}</span>
              </span>
              <span className="pl-1.5"><SyntaxText text={row.text} tokens={tokens?.[i]} mark={mark} markClassName={tone.mark} /></span>
            </div>
          );
        })}
        {children}
      </div>
    </div>
  );
}
