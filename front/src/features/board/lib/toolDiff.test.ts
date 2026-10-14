import { describe, expect, it } from "vitest";
import { DIFF_SHOWN_MAX, WRITE_SHOWN_MAX, lineDiff, toolDiff, type DiffLine } from "@/features/board/lib/toolDiff";

const add = (text: string): DiffLine => ({ kind: "add", text });
const del = (text: string): DiffLine => ({ kind: "del", text });
const ctx = (text: string): DiffLine => ({ kind: "ctx", text });

describe("lineDiff", () => {
  it("shows a one-line change with two lines of context on each side", () => {
    const before = ["a", "b", "c", "d", "e", "f", "g"].join("\n");
    const after = ["a", "b", "c", "D", "e", "f", "g"].join("\n");
    const diff = lineDiff(before, after);
    expect(diff.added).toBe(1);
    expect(diff.removed).toBe(1);
    expect(diff.hunks).toEqual([[ctx("b"), ctx("c"), del("d"), add("D"), ctx("e"), ctx("f")]]);
  });

  it("returns nothing to show when both sides are identical", () => {
    const diff = lineDiff("x\ny\n", "x\ny\n");
    expect(diff).toMatchObject({ added: 0, removed: 0, hunks: [] });
  });

  it("splits far-apart changes into separate hunks and merges close ones", () => {
    const lines = Array.from({ length: 20 }, (_, i) => `l${i}`);
    const far = [...lines];
    far[2] = "X";
    far[17] = "Y";
    expect(lineDiff(lines.join("\n"), far.join("\n")).hunks).toHaveLength(2);
    const close = [...lines];
    close[5] = "X";
    close[9] = "Y";
    expect(lineDiff(lines.join("\n"), close.join("\n")).hunks).toHaveLength(1);
  });

  it("keeps the unchanged line between an insertion and a deletion (LCS, not line-by-line)", () => {
    const diff = lineDiff("a\nb\nc", "a\nnew\nb\nc");
    expect(diff.added).toBe(1);
    expect(diff.removed).toBe(0);
    expect(diff.hunks[0]).toEqual([ctx("a"), add("new"), ctx("b"), ctx("c")]);
  });

  it("treats CRLF and LF as the same line ending", () => {
    const diff = lineDiff("a\r\nb\r\nc\r\n", "a\nB\nc\n");
    expect(diff.added).toBe(1);
    expect(diff.removed).toBe(1);
    expect(diff.hunks[0]).toEqual([ctx("a"), del("b"), add("B"), ctx("c")]);
  });

  it("falls back to all-removed + all-added on a huge middle, fast and marked truncated", () => {
    const before = Array.from({ length: 5000 }, (_, i) => `old ${i}`).join("\n");
    const after = Array.from({ length: 5000 }, (_, i) => `new ${i}`).join("\n");
    const started = performance.now();
    const diff = lineDiff(before, after);
    expect(performance.now() - started).toBeLessThan(200);
    expect(diff.added).toBe(5000);
    expect(diff.removed).toBe(5000);
    expect(diff.truncated).toBe(true);
    const shown = diff.hunks.reduce((n, hunk) => n + hunk.length, 0);
    expect(shown).toBeLessThanOrEqual(DIFF_SHOWN_MAX);
    expect(diff.hidden).toBe(10000 - shown);
  });
});

describe("toolDiff", () => {
  it("diffs an Edit and names the file", () => {
    const diff = toolDiff("Edit", { file_path: "/repo/src/a.ts", old_string: "const x = 1;", new_string: "const x = 2;" });
    expect(diff).toMatchObject({ file: "/repo/src/a.ts", added: 1, removed: 1 });
    expect(diff?.hunks).toEqual([[del("const x = 1;"), add("const x = 2;")]]);
    expect(diff?.replaceAll).toBeFalsy();
  });

  it("an identical Edit is still a diff card, with 0/0", () => {
    const diff = toolDiff("Edit", { file_path: "a.ts", old_string: "same", new_string: "same" });
    expect(diff).toMatchObject({ added: 0, removed: 0, hunks: [] });
  });

  it("carries replace_all as a badge", () => {
    expect(toolDiff("Edit", { file_path: "a.ts", old_string: "a", new_string: "b", replace_all: true })?.replaceAll).toBe(true);
  });

  it("sums the hunks and counters of a MultiEdit", () => {
    const diff = toolDiff("MultiEdit", {
      file_path: "a.ts",
      edits: [
        { old_string: "a", new_string: "b" },
        { old_string: "c\nd", new_string: "e" },
      ],
    });
    expect(diff).toMatchObject({ added: 2, removed: 3 });
    expect(diff?.hunks).toHaveLength(2);
  });

  it("a Write is every line added, showing at most WRITE_SHOWN_MAX", () => {
    const content = `${Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n")}\n`;
    const diff = toolDiff("Write", { file_path: "new.ts", content });
    expect(diff).toMatchObject({ added: 100, removed: 0, created: true, truncated: true, hidden: 100 - WRITE_SHOWN_MAX });
    expect(diff?.hunks.flat()).toHaveLength(WRITE_SHOWN_MAX);
    expect(diff?.hunks.flat().every((line) => line.kind === "add")).toBe(true);
  });

  it("a small Write is shown whole", () => {
    const diff = toolDiff("Write", { file_path: "new.ts", content: "a\nb" });
    expect(diff).toMatchObject({ added: 2, created: true });
    expect(diff?.truncated).toBeFalsy();
    expect(diff?.hunks).toEqual([[add("a"), add("b")]]);
  });

  it("a NotebookEdit shows its new source as added", () => {
    const diff = toolDiff("NotebookEdit", { notebook_path: "nb.ipynb", new_source: "print(1)\nprint(2)" });
    expect(diff).toMatchObject({ file: "nb.ipynb", added: 2, removed: 0 });
  });

  it("returns null for rows mirrored from the terminal (only a description) and for other tools", () => {
    expect(toolDiff("Edit", { description: "Edit(src/a.ts)" })).toBeNull();
    expect(toolDiff("Write", { description: "Write(src/a.ts)" })).toBeNull();
    expect(toolDiff("MultiEdit", { file_path: "a.ts", edits: [] })).toBeNull();
    expect(toolDiff("Bash", { command: "ls" })).toBeNull();
    expect(toolDiff("Edit", undefined)).toBeNull();
    expect(toolDiff("NotebookEdit", { notebook_path: "nb.ipynb", new_source: "", edit_mode: "delete" })).toBeNull();
  });
});
