import { describe, expect, it } from "vitest";
import {
  formatAudioTime,
  isUploadImage,
  linkifyTokens,
  splitAttachments,
  uploadKind,
  parseUploadPath,
  safeUrl,
  uploadDisplayName,
  uploadImageUrl,
} from "@/features/board/lib/markdown";

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

describe("uploaded images", () => {
  const CARD = "4ef6374b-6a1f-4fc1-b2c1-0ba4c377223f";
  const PATH = `/work/.uploads/${CARD}/1790375878344-image.png`;

  it("turns an upload path into an image token, not a link", () => {
    expect(linkifyTokens(`olha ${PATH} aqui`)).toEqual([
      { type: "text", value: "olha " },
      { type: "image", value: PATH, cardId: CARD, file: "1790375878344-image.png" },
      { type: "text", value: " aqui" },
    ]);
  });

  it("takes every image extension the upload route accepts", () => {
    for (const ext of ["png", "jpg", "jpeg", "gif", "webp", "bmp", "avif"]) {
      const path = `/work/.uploads/${CARD}/1790375878344-shot.${ext}`;
      expect(linkifyTokens(path)).toEqual([
        { type: "image", value: path, cardId: CARD, file: `1790375878344-shot.${ext}` },
      ]);
    }
  });

  it("um documento anexado vira um token de arquivo, não texto cru", () => {
    const pdf = `/work/.uploads/${CARD}/1793817742302-contrato-de-trabalho-priscilla-lilian.pdf`;
    const txt = `/work/.uploads/${CARD}/1790375878344-notes.txt`;
    expect(linkifyTokens(`analisa ${pdf} ${txt}`)).toEqual([
      { type: "text", value: "analisa " },
      { type: "file", value: pdf, cardId: CARD, file: "1793817742302-contrato-de-trabalho-priscilla-lilian.pdf" },
      { type: "text", value: " " },
      { type: "file", value: txt, cardId: CARD, file: "1790375878344-notes.txt" },
    ]);
    expect(isUploadImage("1790375878344-shot.png")).toBe(true);
    expect(isUploadImage("1790375878344-x.pdf")).toBe(false);
    expect(uploadDisplayName("1793817742302-contrato.pdf")).toBe("contrato.pdf");
  });

  it("leaves anything that is not an upload as plain text", () => {
    for (const notAnImage of [
      `/work/.uploads/${CARD}/1790375878344-noext`, // no extension: not a name the server writes
      `/work/.uploads/${CARD}/../../etc/passwd.png`, // not a name this server writes
      "/work/.uploads/nope/1790375878344-image.png", // not a card id
      `/etc/${CARD}/1790375878344-image.png`, // not the uploads directory
    ]) {
      expect(linkifyTokens(notAnImage)).toEqual([{ type: "text", value: notAnImage }]);
    }
  });

  it("parses and builds the route the browser fetches", () => {
    expect(parseUploadPath(PATH)).toEqual({ cardId: CARD, file: "1790375878344-image.png" });
    expect(parseUploadPath("/work/.uploads/nope/x.png")).toBeNull();
    expect(uploadImageUrl(CARD, "1790375878344-image.png")).toBe(
      `/api/cards/${CARD}/uploads/1790375878344-image.png`,
    );
  });
});

describe("tipo de anexo no chat", () => {
  it("áudio toca, documento de escritório abre preview, o resto continua chip/imagem", async () => {
    const { anexoEhAudio, anexoTemPreview } = await import("@/features/board/lib/markdown");
    for (const f of ["1-voz.ogg", "1-ptt.opus", "1-reuniao.mp3", "1-memo.m4a", "1-a.wav"]) expect(anexoEhAudio(f)).toBe(true);
    for (const f of ["1-v.xlsx", "1-v.xls", "1-c.docx", "1-c.doc", "1-s.pptx", "1-o.odt", "1-o.ods"]) expect(anexoTemPreview(f)).toBe(true);
    for (const f of ["1-c.pdf", "1-i.png", "1-n.csv", "1-x.zip"]) {
      expect(anexoEhAudio(f)).toBe(false);
      expect(anexoTemPreview(f)).toBe(false);
    }
  });
});

describe("splitAttachments", () => {
  const card = "4ef6374b-6a1f-4fc1-b2c1-0ba4c377223f";
  const up = (file: string) => `/work/.uploads/${card}/${file}`;

  it("pulls every upload out of the words, grouped (pictures, audios, documents), and drops the blank lines", () => {
    const text = `olha isso\n\n${up("1-a.ogg")}\n${up("2-b.png")} ${up("3-c.pdf")}\n${up("4-d.opus")}\n${up("5-e.xlsx")}\n`;
    const { words, attachments } = splitAttachments(linkifyTokens(text));
    expect(words).toEqual([{ type: "text", value: "olha isso" }]);
    expect(attachments.map((a) => a.file)).toEqual(["2-b.png", "1-a.ogg", "4-d.opus", "3-c.pdf", "5-e.xlsx"]);
  });

  it("keeps the words around an upload in the middle of the sentence", () => {
    const { words, attachments } = splitAttachments(linkifyTokens(`veja ${up("1-a.pdf")} e me diga`));
    expect(words.map((w) => w.value).join("")).toBe("veja  e me diga");
    expect(attachments).toHaveLength(1);
  });

  it("a message that is only attachments has no words", () => {
    expect(splitAttachments(linkifyTokens(`${up("1-a.ogg")}\n${up("2-b.ogg")}`)).words).toEqual([]);
  });

  it("text without uploads comes back untouched", () => {
    const tokens = linkifyTokens("só texto  \n");
    expect(splitAttachments(tokens)).toEqual({ words: tokens, attachments: [] });
  });
});

describe("uploadKind", () => {
  it("names what each attachment is, by extension", () => {
    expect(uploadKind("1-x.png")).toBe("image");
    expect(uploadKind("1-x.opus")).toBe("audio");
    expect(uploadKind("1-x.pdf")).toBe("pdf");
    expect(uploadKind("1-x.xlsx")).toBe("spreadsheet");
    expect(uploadKind("1-x.csv")).toBe("spreadsheet");
    expect(uploadKind("1-x.docx")).toBe("document");
    expect(uploadKind("1-x.pptx")).toBe("presentation");
    expect(uploadKind("1-x.txt")).toBe("text");
    expect(uploadKind("1-x.zip")).toBe("file");
  });
});

describe("formatAudioTime", () => {
  it("is m:ss, and h:mm:ss past the hour", () => {
    expect(formatAudioTime(0)).toBe("0:00");
    expect(formatAudioTime(9.7)).toBe("0:09");
    expect(formatAudioTime(63)).toBe("1:03");
    expect(formatAudioTime(3725)).toBe("1:02:05");
  });

  it("an unknown length is null, never 0:00 or Infinity", () => {
    expect(formatAudioTime(Number.NaN)).toBeNull();
    expect(formatAudioTime(Number.POSITIVE_INFINITY)).toBeNull();
    expect(formatAudioTime(-1)).toBeNull();
  });
});
