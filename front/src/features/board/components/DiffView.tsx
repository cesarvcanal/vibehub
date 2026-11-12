import * as React from "react";
import { cn } from "@/lib/utils";
import { highlightDiff, highlightLines, langFromPath, splitByMark, type SynToken } from "@/features/board/lib/syntax";
import { diffRowsView, type DiffRow, type InlineMark } from "@/features/board/lib/toolDiff";

/**
 * An async result tied to the input that produced it: a change of input goes back to null at once, without
 * showing the previous diff's colors. The input is compared by reference — the caller memoizes.
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
 * The same rows as before while the content does not change: the caller builds `rows` on every render
 * (in a loop, in an `if`), and without this every render of the parent would re-tokenize the whole diff.
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

/** Colored tokens of each diff line; null while Shiki loads or without a grammar. */
function useDiffTokens(rows: readonly DiffRow[], path: string | null | undefined) {
  const lang = langFromPath(path);
  const input = React.useMemo(() => (lang ? ([rows, lang] as const) : null), [rows, lang]);
  return useAsync(input, runDiff);
}

/** Colored tokens of each line of a code block (Read/Write); null without a grammar. */
export function useCodeTokens(text: string, path: string | null | undefined): SynToken[][] | null {
  const lang = langFromPath(path);
  const input = React.useMemo(() => (lang ? ([text, lang] as const) : null), [text, lang]);
  return useAsync(input, runCode);
}

/**
 * The text of a line: with syntax color when there are tokens, otherwise in the normal color. `mark` is the part
 * that changed within the line — it gets the stronger background on top of the token's color.
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

/** Line background, sign gutter and highlight of the changed part, per line type. */
const TONE = {
  add: { sign: "+", line: "bg-[var(--diff-add-bg)] text-foreground", gutter: "bg-[var(--diff-add-gutter)] text-[var(--diff-add-sign)]", mark: "bg-[var(--diff-add-word)]" },
  del: { sign: "−", line: "bg-[var(--diff-del-bg)] text-foreground", gutter: "bg-[var(--diff-del-gutter)] text-[var(--diff-del-sign)]", mark: "bg-[var(--diff-del-word)]" },
  ctx: { sign: " ", line: "text-foreground/85", gutter: "text-muted-foreground/50", mark: "" },
} as const;

/**
 * A diff in the IDE style (VS Code / Cursor): the code keeps its syntax color (from the extension of
 * `path`), what tells the line type is the green or red background — stronger in the sign gutter —,
 * the part that changed within the line gets the stronger background and, when the diff says where each hunk
 * starts, the gutter shows the line number.
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
      {/* min-w-max: the long line scrolls INSIDE the block and the colored background follows it to its end. */}
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
