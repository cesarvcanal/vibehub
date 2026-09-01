import { describe, expect, it } from "vitest";
import { mdBlocks, mdInline, linkifyTokens } from "@/features/board/lib/markdown";

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

describe("linkifyTokens", () => {
  it("turns http(s) urls into link tokens and leaves everything else literal", () => {
    expect(linkifyTokens("olha http://10.8.0.25:3010/preview/3100/ e https://x.dev tá?")).toEqual([
      { type: "text", value: "olha " },
      { type: "link", value: "http://10.8.0.25:3010/preview/3100/" },
      { type: "text", value: " e " },
      { type: "link", value: "https://x.dev" },
      { type: "text", value: " tá?" },
    ]);
  });

  it("links the panel's own relative preview paths — the shape vibehub_preview answers with", () => {
    expect(linkifyTokens("abre /preview/3100/ no painel")).toEqual([
      { type: "text", value: "abre " },
      { type: "link", value: "/preview/3100/" },
      { type: "text", value: " no painel" },
    ]);
    expect(linkifyTokens("veja /preview/5173/admin/users.")).toEqual([
      { type: "text", value: "veja " },
      { type: "link", value: "/preview/5173/admin/users" },
      { type: "text", value: "." },
    ]);
  });

  it("keeps sentence punctuation out of the link", () => {
    expect(linkifyTokens("vai em https://x.dev/a, beleza")).toEqual([
      { type: "text", value: "vai em " },
      { type: "link", value: "https://x.dev/a" },
      { type: "text", value: ", beleza" },
    ]);
  });

  it("NEVER links javascript:, data: or any non-http scheme — they stay text", () => {
    for (const hostile of ["javascript:alert(1)", "data:text/html,<b>x</b>", "vbscript:x", "file:///etc/passwd"]) {
      expect(linkifyTokens(`clica ${hostile} aqui`)).toEqual([{ type: "text", value: `clica ${hostile} aqui` }]);
    }
  });

  it("does NOT interpret markdown — a user's asterisks and backticks are literal", () => {
    expect(linkifyTokens("**não é bold** nem `código`")).toEqual([
      { type: "text", value: "**não é bold** nem `código`" },
    ]);
  });

  it("is TOTAL: empty and undefined yield []", () => {
    expect(linkifyTokens("")).toEqual([]);
    expect(linkifyTokens(undefined as unknown as string)).toEqual([]);
  });

  it("does not link /preview without a port or with a bogus one", () => {
    expect(linkifyTokens("a rota /preview/ do app")).toEqual([{ type: "text", value: "a rota /preview/ do app" }]);
  });
});

describe("mdInline — preview paths", () => {
  it("links a relative /preview path inside an agent answer", () => {
    expect(mdInline("no ar em /preview/3100/ — abre aí")).toEqual([
      { type: "text", value: "no ar em " },
      { type: "link", value: "/preview/3100/" },
      { type: "text", value: " — abre aí" },
    ]);
  });
});
