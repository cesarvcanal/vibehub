import { describe, expect, it } from "vitest";
import {
  continuesLine,
  findUrls,
  joinRows,
  logicalLine,
  offsetsToRange,
  type BufferRow,
} from "@/features/board/lib/links";

const row = (text: string, wrapped = false): BufferRow => ({ text, wrapped });

describe("continuesLine", () => {
  it("always joins a soft wrap — xterm already told us", () => {
    expect(continuesLine(row("short"), row("tail", true))).toBe(true);
  });

  it("joins a HARD wrap: a row full to the last column, resumed by a non-space", () => {
    // The ink TUI broke at the margin with a real newline, so `wrapped` is false.
    expect(continuesLine(row("0123456789"), row("abc"), 10)).toBe(true);
  });

  it("does not join when the previous row stopped short of the margin", () => {
    expect(continuesLine(row("012345678"), row("abc"), 10)).toBe(false);
  });

  it("does not join when the previous row ends in whitespace — that is a finished line", () => {
    expect(continuesLine({ text: "012345678 ", wrapped: false }, row("abc"), 10)).toBe(false);
  });

  it("does not join an indented line printed under a full one", () => {
    expect(continuesLine(row("0123456789"), { text: "  indented", wrapped: false }, 10)).toBe(false);
    expect(continuesLine(row("0123456789"), row(""), 10)).toBe(false);
  });

  it("without a width, only soft wraps count — the stock, TUI-blind behaviour", () => {
    expect(continuesLine(row("0123456789"), row("abc"))).toBe(false);
  });
});

describe("logicalLine", () => {
  it("glues continuation rows onto the row that started the line", () => {
    const rows = [row("https://example.com/a/very/"), row("long/path", true)];
    expect(logicalLine(rows, 0)?.text).toBe("https://example.com/a/very/long/path");
  });

  it("finds the same line from anywhere inside it", () => {
    const rows = [row("start"), row("middle", true), row("end", true), row("next line")];
    expect(logicalLine(rows, 2)).toEqual({ text: "startmiddleend", startRow: 0, endRow: 2 });
  });

  it("stops at a row that is not a continuation", () => {
    const rows = [row("first"), row("second")];
    expect(logicalLine(rows, 0)).toEqual({ text: "first", startRow: 0, endRow: 0 });
  });

  it("is null outside the buffer", () => {
    expect(logicalLine([row("a")], 5)).toBeNull();
    expect(logicalLine([row("a")], -1)).toBeNull();
  });

  it("rebuilds a HARD-wrapped sign-in URL — the three-row case that used to give three dead links", () => {
    // 20 columns, exactly how Claude Code prints its OAuth URL: real newlines at the margin.
    const rows = [
      row("Open this link to a"),
      row("https://claude.ai/oa"),
      row("uth/authorize?code=a"),
      row("bc123"),
      row("Paste the code here"),
    ];
    const line = logicalLine(rows, 2, 20);
    expect(line?.startRow).toBe(1);
    expect(line?.endRow).toBe(3);
    expect(findUrls(line?.text ?? "").map((u) => u.url)).toEqual([
      "https://claude.ai/oauth/authorize?code=abc123",
    ]);
  });
});

describe("joinRows", () => {
  it("separates real lines with a newline and glues wrapped ones", () => {
    const rows = [row("one"), row("two", true), row("three")];
    expect(joinRows(rows)).toBe("onetwo\nthree");
  });

  it("is the join that stops a URL swallowing the next line", () => {
    // The naive join ("" everywhere) produces "https://example.com/docsrm -rf" — one bogus link.
    const rows = [row("https://example.com/docs"), row("rm -rf /tmp")];
    expect(findUrls(joinRows(rows)).map((u) => u.url)).toEqual(["https://example.com/docs"]);
  });
});

describe("findUrls", () => {
  it("finds http and https", () => {
    expect(findUrls("see http://a.test and https://b.test now").map((u) => u.url)).toEqual([
      "http://a.test",
      "https://b.test",
    ]);
  });

  it("reports offsets into the string it searched", () => {
    const [match] = findUrls("go to https://example.com ok");
    expect(match).toMatchObject({ start: 6, end: 6 + "https://example.com".length });
  });

  it("does not swallow the full stop at the end of a sentence", () => {
    expect(findUrls("read https://example.com/docs.").map((u) => u.url)).toEqual([
      "https://example.com/docs",
    ]);
  });

  it("keeps a closing bracket that the URL itself opened", () => {
    expect(findUrls("https://example.com/a_(b)").map((u) => u.url)).toEqual([
      "https://example.com/a_(b)",
    ]);
  });

  it("stops at whitespace and quotes", () => {
    expect(findUrls('"https://example.com/x" rest').map((u) => u.url)).toEqual([
      "https://example.com/x",
    ]);
  });

  it("ignores a bare scheme", () => {
    expect(findUrls("https:// nothing here")).toEqual([]);
  });

  it("finds nothing in plain output", () => {
    expect(findUrls("running tests… 42 passed")).toEqual([]);
  });
});

describe("offsetsToRange", () => {
  it("maps an offset on the first row to 1-based cells", () => {
    expect(offsetsToRange(0, 5, 80)).toEqual({ startX: 1, startY: 1, endX: 5, endY: 1 });
  });

  it("spans the rows a wrapped URL occupies", () => {
    // cols = 10, so offsets 8..14 straddle the wrap at 10.
    expect(offsetsToRange(8, 15, 10)).toEqual({ startX: 9, startY: 1, endX: 5, endY: 2 });
  });

  it("has an inclusive end cell", () => {
    expect(offsetsToRange(0, 10, 10)).toEqual({ startX: 1, startY: 1, endX: 10, endY: 1 });
  });

  it("refuses nonsense rather than producing a range that highlights the wrong cells", () => {
    expect(offsetsToRange(5, 5, 80)).toBeNull();
    expect(offsetsToRange(-1, 4, 80)).toBeNull();
    expect(offsetsToRange(0, 4, 0)).toBeNull();
  });
});
