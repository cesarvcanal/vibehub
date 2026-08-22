import { describe, expect, it } from "vitest";
import { mdBlocks, mdInline } from "@/features/board/lib/markdown";

describe("mdBlocks", () => {
  it("splits prose, headings, bullets and fenced code", () => {
    const text = [
      "## Plano",
      "",
      "Vou fazer assim:",
      "- primeiro isso",
      "- depois aquilo",
      "",
      "```ts",
      "const a = 1;",
      "```",
    ].join("\n");
    expect(mdBlocks(text)).toEqual([
      { type: "heading", level: 2, text: "Plano" },
      { type: "paragraph", text: "Vou fazer assim:" },
      { type: "bullets", items: ["primeiro isso", "depois aquilo"] },
      { type: "code", lang: "ts", text: "const a = 1;" },
    ]);
  });

  it("interprets NOTHING inside a fence", () => {
    const text = ["```bash", "# not a heading", "- not a bullet", "```"].join("\n");
    expect(mdBlocks(text)).toEqual([{ type: "code", lang: "bash", text: "# not a heading\n- not a bullet" }]);
  });

  it("still renders an unclosed fence as code — the message may be arriving", () => {
    expect(mdBlocks("```\nhalf a diff")).toEqual([{ type: "code", lang: "", text: "half a diff" }]);
  });

  it("keeps consecutive prose lines in one block, so a wrapped sentence stays a sentence", () => {
    expect(mdBlocks("uma linha\noutra linha")).toEqual([{ type: "paragraph", text: "uma linha\noutra linha" }]);
  });

  it("has nothing to say about an empty message", () => {
    expect(mdBlocks("")).toEqual([]);
    expect(mdBlocks("\n\n")).toEqual([]);
  });
});

describe("mdInline", () => {
  it("finds code, bold and bare urls, and leaves the rest literal", () => {
    expect(mdInline("veja `api.ts` e **corrija** em https://x.dev/a, ok")).toEqual([
      { type: "text", value: "veja " },
      { type: "code", value: "api.ts" },
      { type: "text", value: " e " },
      { type: "strong", value: "corrija" },
      { type: "text", value: " em " },
      { type: "link", value: "https://x.dev/a" },
      { type: "text", value: ", ok" },
    ]);
  });

  it("does not eat an asterisk that is not markup", () => {
    expect(mdInline("2 * 3 * 4")).toEqual([{ type: "text", value: "2 * 3 * 4" }]);
  });

  it("leaves a lone backtick alone", () => {
    expect(mdInline("a ` b")).toEqual([{ type: "text", value: "a ` b" }]);
  });
});
