import { describe, expect, it } from "vitest";
import { linkifyTokens, safeUrl } from "@/features/board/lib/markdown";

describe("linkifyTokens", () => {
  it("turns http(s) urls into link tokens and leaves everything else literal", () => {
    expect(linkifyTokens("olha http://192.0.2.10:3010/preview/3100/ e https://x.dev tá?")).toEqual([
      { type: "text", value: "olha " },
      { type: "link", value: "http://192.0.2.10:3010/preview/3100/" },
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

describe("safeUrl", () => {
  it("passes http(s), mailto and the panel's own preview paths", () => {
    expect(safeUrl("https://x.dev/a")).toBe("https://x.dev/a");
    expect(safeUrl("http://192.0.2.10:3010/")).toBe("http://192.0.2.10:3010/");
    expect(safeUrl("mailto:tech@multiversoatacado.com")).toBe("mailto:tech@multiversoatacado.com");
    expect(safeUrl("/preview/3100/admin")).toBe("/preview/3100/admin");
  });

  it("empties EVERY other scheme — the allowlist is the sanitiser", () => {
    for (const hostile of [
      "javascript:alert(1)",
      "JaVaScRiPt:alert(1)",
      " javascript:alert(1)",
      "data:text/html,<b>x</b>",
      "vbscript:x",
      "file:///etc/passwd",
      "//evil.dev",
      "../../etc/passwd",
      "/preview/notaport/x",
    ]) {
      expect(safeUrl(hostile)).toBe("");
    }
  });

  it("is TOTAL: empty and undefined yield an empty href", () => {
    expect(safeUrl("")).toBe("");
    expect(safeUrl(undefined as unknown as string)).toBe("");
  });
});
