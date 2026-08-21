/**
 * Turning URLs printed by an agent into clickable links.
 *
 * The stock web-links addon matches per rendered ROW, which is wrong in both directions once an
 * agent starts printing long URLs into a narrow pane:
 *
 *  - a URL that WRAPS is cut in half, and you get two dead links instead of one live one;
 *  - rows that merely follow each other are glued together, so a URL at the end of one line
 *    absorbs whatever the next line starts with.
 *
 * Both fall out of one rule: rebuild the LOGICAL line before matching. A continuation row is glued
 * on with nothing between it and its predecessor, and every other row ends with a REAL newline that
 * the matcher cannot cross.
 *
 * ## Two kinds of continuation
 *
 * There are two, and only handling the first is why Claude's sign-in URL used to arrive as three
 * dead links:
 *
 *  - **Soft wrap** — xterm ran out of columns and set `isWrapped` on the next row. Free to detect.
 *  - **Hard wrap** — an ink TUI (which is what Claude Code is) measures the width itself and emits
 *    a REAL newline at the margin. `isWrapped` is false and there is no flag to read, so the only
 *    evidence is the shape: the previous row runs to the very last column with no space at its end,
 *    and the next row starts with a non-space. That is what `continuesLine` looks for, and it needs
 *    the terminal's width to do it.
 *
 * Everything below is pure so the rule can be tested without a terminal.
 */

export interface BufferRow {
  /** The row's text, right-trimmed the way xterm's `translateToString(true)` gives it. */
  text: string;
  /** True when this row is the continuation of the row above (the line wrapped). */
  wrapped: boolean;
}

/**
 * Does `current` continue `previous`? PURE.
 *
 * `cols` is the terminal width. Leave it out and only soft wraps count — which is the stock
 * behaviour, and wrong for a TUI. Pass it and a full, space-free row followed by a row that does
 * not start with a space is treated as the hard wrap it is.
 *
 * The "starts with a non-space" half matters: a wrapped URL never resumes with whitespace, whereas
 * an indented log line printed straight after a line that happened to fill the width does — and
 * gluing those two together is exactly the bogus link this avoids.
 */
export function continuesLine(previous: BufferRow, current: BufferRow, cols?: number): boolean {
  if (current.wrapped) return true;
  if (!cols || cols <= 0) return false;
  return (
    previous.text.length >= cols &&
    !/\s$/.test(previous.text) &&
    current.text.length > 0 &&
    !/^\s/.test(current.text)
  );
}

export interface LogicalLine {
  /** Rows joined: continuations glued on, other boundaries kept as "\n". */
  text: string;
  /** Buffer row the logical line starts on. */
  startRow: number;
  /** Buffer row the logical line ends on (inclusive). */
  endRow: number;
}

/**
 * The complete logical line containing buffer row `row`: walk up while rows are continuations,
 * then down while the next row is one. `cols` enables hard-wrap detection — see `continuesLine`.
 */
export function logicalLine(rows: BufferRow[], row: number, cols?: number): LogicalLine | null {
  if (row < 0 || row >= rows.length) return null;
  let start = row;
  while (start > 0 && continuesLine(rows[start - 1] as BufferRow, rows[start] as BufferRow, cols)) {
    start -= 1;
  }
  let end = start;
  while (
    end + 1 < rows.length &&
    continuesLine(rows[end] as BufferRow, rows[end + 1] as BufferRow, cols)
  ) {
    end += 1;
  }
  let text = "";
  for (let y = start; y <= end; y += 1) {
    text += rows[y]?.text ?? "";
  }
  return { text, startRow: start, endRow: end };
}

/**
 * Joins a whole buffer into text a matcher can run over: continuation rows glued on, every other
 * boundary a real newline. This is the join the stock addon gets wrong.
 */
export function joinRows(rows: BufferRow[], cols?: number): string {
  let out = "";
  rows.forEach((row, i) => {
    const previous = rows[i - 1];
    if (i > 0 && !(previous && continuesLine(previous, row, cols))) out += "\n";
    out += row.text;
  });
  return out;
}

/**
 * URL matcher. Deliberately conservative: an http(s) scheme, then anything that is not whitespace
 * or a quote, and then trailing punctuation is handed back because prose puts a full stop after a
 * link far more often than a URL genuinely ends in one.
 */
const URL_RE = /https?:\/\/[^\s"'<>`]+/g;
const TRAILING = /[.,;:!?)\]}'"]+$/;

export interface UrlMatch {
  url: string;
  /** Offset of the first character in the text that was searched. */
  start: number;
  /** Offset one past the last character. */
  end: number;
}

/** Every URL in a string, with trailing punctuation trimmed off and balanced brackets kept. */
export function findUrls(text: string): UrlMatch[] {
  const out: UrlMatch[] = [];
  URL_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = URL_RE.exec(text)) !== null) {
    let url = match[0];
    const trailing = TRAILING.exec(url);
    if (trailing) {
      // A closing bracket that has an opener inside the URL belongs to it (wiki-style links).
      const trimmed = url.slice(0, url.length - trailing[0].length);
      const keepsParen = url.endsWith(")") && countOf(trimmed, "(") > countOf(trimmed, ")");
      url = keepsParen ? `${trimmed})` : trimmed;
    }
    if (url.length <= "https://".length) continue;
    out.push({ url, start: match.index, end: match.index + url.length });
  }
  return out;
}

function countOf(text: string, char: string): number {
  let n = 0;
  for (const c of text) if (c === char) n += 1;
  return n;
}

export interface CellRange {
  /** 1-based column of the first cell, as xterm's link API wants it. */
  startX: number;
  /** 1-based row of the first cell, relative to the row the logical line starts on. */
  startY: number;
  /** 1-based column of the last cell (inclusive). */
  endX: number;
  endY: number;
}

/**
 * Maps a `[start, end)` offset inside a logical line back to terminal cells.
 *
 * `cols` is the terminal width, so offset `n` sits at row `floor(n / cols)` of the logical line and
 * column `n % cols` — which only holds because the logical line was built by gluing continuation
 * rows with nothing between them. Rows joined by a newline are never spanned, since a URL match can
 * never cross one.
 */
export function offsetsToRange(start: number, end: number, cols: number): CellRange | null {
  if (!(cols > 0) || end <= start || start < 0) return null;
  const last = end - 1;
  return {
    startX: (start % cols) + 1,
    startY: Math.floor(start / cols) + 1,
    endX: (last % cols) + 1,
    endY: Math.floor(last / cols) + 1,
  };
}
