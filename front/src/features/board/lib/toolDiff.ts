/**
 * The diff the native chat draws when the AI changes code (the Cursor-style card). PURE.
 *
 * The tool call already carries everything: Edit sends the old and the new snippet, Write sends the
 * whole file. There is no disk read and no request to the back — the diff comes from the row's
 * `input`. Rows mirrored from the terminal only have `{description}`: no snippets, no diff (null).
 */

export type DiffLine = { kind: "add" | "del" | "ctx"; text: string };

/**
 * A drawable diff line: the file's lines and the hunk separator (`hunk`), which carries where the
 * hunk starts on each side when the diff says so (`@@ -a,b +c,d @@`).
 */
export type DiffRow = DiffLine | { kind: "hunk"; text: string; oldStart?: number; newStart?: number };

export type LineDiff = {
  /** Changed hunks, each with its context lines. Empty when nothing changed. */
  hunks: DiffLine[][];
  added: number;
  removed: number;
  /** Part of the diff is not on screen (see `hidden`). */
  truncated?: boolean;
  /** How many diff lines were left out of what is drawn. */
  hidden?: number;
};

export type ToolDiff = LineDiff & {
  file: string;
  /** Write: the whole file is new content. */
  created?: boolean;
  replaceAll?: boolean;
};

/** Ceiling of lines drawn in a diff card: the DOM of a 10-thousand-line diff freezes the conversation. */
export const DIFF_SHOWN_MAX = 200;
/** A Write is the whole file; the beginning is enough to know what was written. */
export const WRITE_SHOWN_MAX = 40;
/** Ceiling of the LCS table (old × new lines of the middle). Above it: everything removed + everything added. */
const LCS_CELLS_MAX = 400 * 400;

/** Lines of a text, with CRLF same as LF and without the phantom empty line of the trailing `\n`. */
function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** Line-by-line diff of the middle via LCS with dynamic programming (O(m·n), only below the ceiling). */
function lcsOps(before: readonly string[], after: readonly string[]): DiffLine[] {
  const m = before.length;
  const n = after.length;
  const width = n + 1;
  // table[i*width + j] = LCS of before[i..] and after[j..].
  const table = new Uint32Array((m + 1) * width);
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      table[i * width + j] = before[i] === after[j]
        ? table[(i + 1) * width + j + 1]! + 1
        : Math.max(table[(i + 1) * width + j]!, table[i * width + j + 1]!);
    }
  }
  const ops: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (before[i] === after[j]) {
      ops.push({ kind: "ctx", text: before[i]! });
      i++;
      j++;
    } else if (table[(i + 1) * width + j]! >= table[i * width + j + 1]!) {
      ops.push({ kind: "del", text: before[i++]! });
    } else {
      ops.push({ kind: "add", text: after[j++]! });
    }
  }
  while (i < m) ops.push({ kind: "del", text: before[i++]! });
  while (j < n) ops.push({ kind: "add", text: after[j++]! });
  return ops;
}

/** Groups the full sequence into hunks: each change with `context` equal lines around it. */
function toHunks(ops: readonly DiffLine[], context: number): DiffLine[][] {
  const keep = new Array<boolean>(ops.length).fill(false);
  ops.forEach((op, index) => {
    if (op.kind === "ctx") return;
    const from = Math.max(0, index - context);
    const to = Math.min(ops.length - 1, index + context);
    for (let k = from; k <= to; k++) keep[k] = true;
  });
  const hunks: DiffLine[][] = [];
  let current: DiffLine[] | null = null;
  ops.forEach((op, index) => {
    if (!keep[index]) {
      current = null;
      return;
    }
    if (!current) {
      current = [];
      hunks.push(current);
    }
    current.push(op);
  });
  return hunks;
}

/** Cuts what is drawn to `max` lines in total; the rest becomes a count in `hidden`. */
function capHunks(diff: LineDiff, max: number): LineDiff {
  const total = diff.hunks.reduce((sum, hunk) => sum + hunk.length, 0);
  if (total <= max) return diff;
  const hunks: DiffLine[][] = [];
  let budget = max;
  for (const hunk of diff.hunks) {
    if (budget <= 0) break;
    hunks.push(hunk.slice(0, budget));
    budget -= hunk.length;
  }
  return { ...diff, hunks, truncated: true, hidden: (diff.hidden ?? 0) + total - max };
}

/** Line diff between two texts, in hunks with `context` context lines. PURE. */
export function lineDiff(before: string, after: string, context: number = 2): LineDiff {
  const a = splitLines(before);
  const b = splitLines(after);
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) suffix++;

  const midBefore = a.slice(prefix, a.length - suffix);
  const midAfter = b.slice(prefix, b.length - suffix);
  const coarse = midBefore.length * midAfter.length > LCS_CELLS_MAX;
  const middle = coarse
    ? [
        ...midBefore.map((text): DiffLine => ({ kind: "del", text })),
        ...midAfter.map((text): DiffLine => ({ kind: "add", text })),
      ]
    : lcsOps(midBefore, midAfter);

  // Only the equal lines that can become context enter the sequence; the rest of the prefix/suffix never shows up.
  const head = a.slice(Math.max(0, prefix - context), prefix).map((text): DiffLine => ({ kind: "ctx", text }));
  const tail = a.slice(a.length - suffix, a.length - suffix + context).map((text): DiffLine => ({ kind: "ctx", text }));
  const ops = [...head, ...middle, ...tail];

  const added = middle.reduce((n, op) => n + (op.kind === "add" ? 1 : 0), 0);
  const removed = middle.reduce((n, op) => n + (op.kind === "del" ? 1 : 0), 0);
  const diff: LineDiff = { hunks: toHunks(ops, context), added, removed };
  return capHunks(coarse ? { ...diff, truncated: true } : diff, DIFF_SHOWN_MAX);
}

/** Range `[start, end)` of a line that actually changed relative to its pair on the other side. */
export type InlineMark = readonly [start: number, end: number];

/**
 * What changed INSIDE each line of a hunk: a block of `−` followed by a block of `+` of the same size
 * is paired line by line, and from each pair comes the middle between the common start and end. It
 * is what lets you see `2` → `3` in a long line without comparing the two by eye. Blocks of
 * different sizes, a fully replaced line or one without a pair: null (the line's color already says
 * it all). PURE.
 */
export function inlineMarks(hunk: readonly DiffLine[]): (InlineMark | null)[] {
  const marks: (InlineMark | null)[] = hunk.map(() => null);
  let i = 0;
  while (i < hunk.length) {
    if (hunk[i]!.kind !== "del") {
      i++;
      continue;
    }
    const delStart = i;
    while (i < hunk.length && hunk[i]!.kind === "del") i++;
    const addStart = i;
    while (i < hunk.length && hunk[i]!.kind === "add") i++;
    const count = addStart - delStart;
    if (i - addStart !== count) continue;
    for (let k = 0; k < count; k++) {
      const before = hunk[delStart + k]!.text;
      const after = hunk[addStart + k]!.text;
      const limit = Math.min(before.length, after.length);
      let prefix = 0;
      while (prefix < limit && before[prefix] === after[prefix]) prefix++;
      let suffix = 0;
      while (suffix < limit - prefix && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix++;
      if (prefix + suffix === 0) continue;
      if (before.length - suffix > prefix) marks[delStart + k] = [prefix, before.length - suffix];
      if (after.length - suffix > prefix) marks[addStart + k] = [prefix, after.length - suffix];
    }
  }
  return marks;
}

/** Whole text as added lines, drawing at most `max`. */
function allAdded(text: string, max: number): LineDiff {
  const lines = splitLines(text);
  const diff: LineDiff = {
    hunks: lines.length > 0 ? [lines.map((line): DiffLine => ({ kind: "add", text: line }))] : [],
    added: lines.length,
    removed: 0,
  };
  return capHunks(diff, max);
}

type EditInput = { old_string: string; new_string: string; replace_all?: unknown };

function isEdit(value: unknown): value is EditInput {
  if (!value || typeof value !== "object") return false;
  const o = value as Record<string, unknown>;
  return typeof o.old_string === "string" && typeof o.new_string === "string";
}

/** The text an edit call carries, already validated. Only the shape — no diff computed. */
type EditCall =
  | { kind: "edits"; file: string; edits: EditInput[] }
  | { kind: "content"; file: string; content: string; created: boolean };

function parseEditCall(name: string, input: unknown): EditCall | null {
  if (!input || typeof input !== "object") return null;
  const o = input as Record<string, unknown>;
  const file = typeof o.file_path === "string" ? o.file_path : null;
  switch (name) {
    case "Edit":
      return file && isEdit(o) ? { kind: "edits", file, edits: [o] } : null;
    case "MultiEdit": {
      const edits = file && Array.isArray(o.edits) ? o.edits.filter(isEdit) : [];
      return file && edits.length > 0 ? { kind: "edits", file, edits } : null;
    }
    case "Write":
      return file && typeof o.content === "string" ? { kind: "content", file, content: o.content, created: true } : null;
    case "NotebookEdit":
      // Deleting a cell does not carry what was deleted: there is no honest diff to draw.
      if (typeof o.notebook_path !== "string" || typeof o.new_source !== "string" || o.edit_mode === "delete") return null;
      return { kind: "content", file: o.notebook_path, content: o.new_source, created: false };
    default:
      return null;
  }
}

function editsDiff(edits: readonly EditInput[]): LineDiff {
  const diffs = edits.map((edit) => lineDiff(edit.old_string, edit.new_string));
  if (diffs.length === 1) return diffs[0]!;
  // Each edit already comes with its ceiling; the total gets the same ceiling so the card does not grow per edit.
  const hidden = diffs.reduce((n, d) => n + (d.hidden ?? 0), 0);
  return capHunks(
    {
      hunks: diffs.flatMap((d) => d.hunks),
      added: diffs.reduce((n, d) => n + d.added, 0),
      removed: diffs.reduce((n, d) => n + d.removed, 0),
      ...(diffs.some((d) => d.truncated) ? { truncated: true, hidden } : {}),
    },
    DIFF_SHOWN_MAX,
  );
}

/**
 * Does this call become a diff card? Same answer as `toolDiff(...) !== null`, without computing the
 * diff — cheap enough to run over the whole conversation on every incoming token. PURE.
 */
export function hasToolDiff(name: string, input: unknown): boolean {
  return parseEditCall(name, input) !== null;
}

/** The diff a tool call represents, or null when it does not change code. PURE. */
export function toolDiff(name: string, input: unknown): ToolDiff | null {
  const call = parseEditCall(name, input);
  if (!call) return null;
  if (call.kind === "content") {
    return { file: call.file, ...allAdded(call.content, WRITE_SHOWN_MAX), ...(call.created ? { created: true } : {}) };
  }
  const replaceAll = call.edits.some((edit) => edit.replace_all === true);
  return { file: call.file, ...editsDiff(call.edits), ...(replaceAll ? { replaceAll: true } : {}) };
}

/** The hunks of a `ToolDiff` as drawable lines, with `⋯` between one hunk and the next. PURE. */
export function hunksToRows(hunks: readonly DiffLine[][]): DiffRow[] {
  return hunks.flatMap((hunk, i): DiffRow[] => (i > 0 ? [{ kind: "hunk", text: "⋯" }, ...hunk] : [...hunk]));
}

/** What the gutter and the highlight need from each line: number (null = unknown) and changed range. */
export type DiffRowView = { num: number | null; mark: InlineMark | null };

/**
 * For each line: the number in the file (the old one on removed lines, the new one on the rest),
 * counted from the start of the hunk, and the range that changed inside it (`inlineMarks` per hunk). PURE.
 */
export function diffRowsView(rows: readonly DiffRow[]): DiffRowView[] {
  const marks: (InlineMark | null)[] = [];
  let hunk: DiffLine[] = [];
  const flush = () => {
    marks.push(...inlineMarks(hunk));
    hunk = [];
  };
  let oldLine: number | null = null;
  let newLine: number | null = null;
  const nums = rows.map((row): number | null => {
    if (row.kind === "hunk") {
      flush();
      marks.push(null);
      oldLine = row.oldStart ?? null;
      newLine = row.newStart ?? null;
      return null;
    }
    hunk.push(row);
    const num = row.kind === "del" ? oldLine : newLine;
    if (row.kind !== "add" && oldLine !== null) oldLine++;
    if (row.kind !== "del" && newLine !== null) newLine++;
    return num;
  });
  flush();
  return nums.map((num, i) => ({ num, mark: marks[i] ?? null }));
}
