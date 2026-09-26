import * as React from "react";
import { cn } from "@/lib/utils";
import {
  findUltraWords,
  hasUltraWord,
  ultraColor,
  ultraCycleMs,
  ultraDelayMs,
  type UltraKeyword,
  type UltraMatch,
} from "@/features/board/lib/ultraWords";

/**
 * `ultrathink` / `ultracode`, painted the way Claude Code paints them.
 *
 * Each letter takes its own colour from the TUI's rainbow and a bright band sweeps through the
 * word, left to right, one letter every 50 ms — that white thing crossing the letters in the CLI.
 * The sweep is CSS, not a timer: every letter runs the SAME keyframes for the SAME duration and
 * differs only in `animation-delay`, so twenty highlighted words on screen cost zero React renders
 * and the browser is free to stop the whole thing when the tab is in the background. `index.css`
 * carries the keyframes; the global `prefers-reduced-motion` rule there stops the sweep and leaves
 * the rainbow, which is the part that carries the meaning.
 *
 * Used in the two places that must agree: the composer's field (what you are about to send) and
 * the message bubble (what you sent). Everywhere else the words are ordinary text.
 */

/**
 * One keyword, letter by letter. The word's own spelling is kept — `ULTRATHINK` stays shouted — and
 * each keyword wears ITS OWN palette: the two are different requests and used to look the same.
 */
function UltraWord({ word, keyword }: { word: string; keyword: UltraKeyword }) {
  const letters = [...word];
  const durationMs = ultraCycleMs(letters.length);
  return (
    <span data-testid="ultra-word" data-word={word.toLowerCase()} data-keyword={keyword}>
      {letters.map((letter, i) => (
        <span
          key={i}
          className="vh-ultra-char"
          style={
            {
              "--vh-ultra-base": ultraColor(i, false, keyword),
              "--vh-ultra-shimmer": ultraColor(i, true, keyword),
              animationDuration: `${durationMs}ms`,
              animationDelay: `${ultraDelayMs(i, letters.length)}ms`,
            } as React.CSSProperties
          }
        >
          {letter}
        </span>
      ))}
    </span>
  );
}

/**
 * `text`, with every reserved word painted and everything else left exactly as it was.
 *
 * Returns a bare fragment (no wrapper element) so it drops into a bubble, a `<p>` or the field
 * mirror below without changing how any of them lay out.
 */
export function UltraText({ text }: { text: string }) {
  const source = String(text ?? "");
  const matches: UltraMatch[] = React.useMemo(() => findUltraWords(source), [source]);
  if (matches.length === 0) return <>{source}</>;
  const parts: React.ReactNode[] = [];
  let last = 0;
  matches.forEach((match, i) => {
    if (match.start > last) {
      parts.push(<React.Fragment key={`t${i}`}>{source.slice(last, match.start)}</React.Fragment>);
    }
    parts.push(<UltraWord key={`w${i}`} word={match.word} keyword={match.keyword} />);
    last = match.end;
  });
  if (last < source.length) parts.push(<React.Fragment key="tail">{source.slice(last)}</React.Fragment>);
  return <>{parts}</>;
}

/**
 * The composer's field, painted — a mirror of the textarea laid exactly ON TOP of it, showing the
 * reserved words in colour and everything else transparent.
 *
 * A textarea cannot colour part of its value; that is the whole reason this exists. Of the two
 * ways to fake it, this is the one that costs nothing: the textarea keeps its own text, its own
 * caret and its own selection, and the mirror simply repaints the keyword's letters over the grey
 * ones already there. (The other way — transparent text with the mirror underneath — hides your
 * own words the moment you select them, which is worse than a word that is not rainbow.)
 *
 * The price is geometry: the mirror MUST wrap exactly like the field, or the colours drift off the
 * letters. Hence the copied font/padding/wrapping classes, and the observer that keeps the mirror
 * at the textarea's own `clientWidth` — which is the width MINUS a scrollbar, the case that
 * silently reflows a long draft.
 */
export function UltraFieldOverlay({
  target,
  text,
  className,
}: {
  /** The textarea being mirrored. */
  target: React.RefObject<HTMLTextAreaElement | null>;
  text: string;
  /** Padding overrides that must match the field's own (the phone's room for the send button). */
  className?: string;
}) {
  const mirror = React.useRef<HTMLDivElement | null>(null);
  const active = hasUltraWord(text);

  /**
   * Keep the mirror on the field: same box, same scroll offset. Runs on every change of the text
   * (the field also grows there), on the field's own scrolling, and on any resize of the field —
   * a window that got narrower rewraps the draft, and a mirror that did not rewrap with it would
   * paint the colours a line above the letters.
   */
  React.useLayoutEffect(() => {
    const field = target.current;
    const el = mirror.current;
    if (!field || !el || !active) return;
    const sync = (): void => {
      el.style.width = `${field.clientWidth}px`;
      el.style.height = `${field.clientHeight}px`;
      el.scrollTop = field.scrollTop;
    };
    sync();
    field.addEventListener("scroll", sync);
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(sync);
    observer?.observe(field);
    return () => {
      field.removeEventListener("scroll", sync);
      observer?.disconnect();
    };
  }, [target, text, active]);

  // Nothing reserved in the draft: no mirror at all, so the ordinary case pays nothing and the
  // field is exactly the field it has always been.
  if (!active) return null;

  return (
    <div
      ref={mirror}
      aria-hidden
      data-testid="composer-ultra-mirror"
      className={cn(
        "pointer-events-none absolute left-0 top-0 overflow-hidden whitespace-pre-wrap break-words border border-transparent px-3 py-2 text-base text-transparent md:text-sm",
        className,
      )}
    >
      <UltraText text={text} />
    </div>
  );
}
