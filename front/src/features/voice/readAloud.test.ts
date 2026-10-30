import { describe, expect, it, vi } from "vitest";
import { ReadAloudPlayer, readAloudError, speakableText, speechChunks, type AudioLike } from "./readAloud";

/**
 * LER EM VOZ ALTA: o markdown vira fala, a fala vira pedaços (o primeiro curto, para a voz começar
 * logo), e o player toca um por vez buscando o próximo enquanto toca. Parar corta tudo.
 */

describe("speakableText", () => {
  it("strips what the ear cannot use: markup, code, link targets, table rules", () => {
    const md = [
      "## Resumo",
      "",
      "Corrigi o **login** e o `deploy`, veja [o PR](https://github.com/x/y/pull/1).",
      "",
      "```ts",
      "const a = 1;",
      "```",
      "",
      "- primeiro item",
      "* segundo _item_",
      "",
      "| Arquivo | Status |",
      "|---|:---:|",
      "| a.ts | ok |",
      "",
      "---",
      "> citação",
    ].join("\n");
    expect(speakableText(md)).toBe(
      [
        "Resumo",
        "",
        "Corrigi o login e o deploy, veja o PR.",
        "",
        "(trecho de código omitido)",
        "",
        "primeiro item",
        "segundo item",
        "",
        "Arquivo, Status",
        "a.ts, ok",
        "",
        "citação",
      ].join("\n"),
    );
  });

  it("says 'link' for a bare URL and keeps words with underscores and math asterisks", () => {
    expect(speakableText("Acesse https://vibehub.multi/board agora")).toBe("Acesse link agora");
    expect(speakableText("a variável snake_case_name e 2 * 3 * 4")).toBe("a variável snake_case_name e 2 * 3 * 4");
  });

  it("an unclosed code fence (the answer ends inside it) still drops the code", () => {
    expect(speakableText("Veja:\n```\nrm -rf x")).toBe("Veja:\n\n(trecho de código omitido)");
  });

  it("a blank answer has nothing to say", () => {
    expect(speakableText("   ")).toBe("");
  });
});

describe("speechChunks", () => {
  const sentence = (i: number) => `Esta é a frase número ${i} da resposta.`;

  it("a short answer is one piece", () => {
    expect(speechChunks("Pronto, deploy feito.")).toEqual(["Pronto, deploy feito."]);
    expect(speechChunks("")).toEqual([]);
  });

  it("the first piece is short (the voice starts fast), the rest bigger, and nothing is lost", () => {
    const text = Array.from({ length: 6 }, (_, p) => Array.from({ length: 5 }, (_, s) => sentence(p * 5 + s)).join(" ")).join("\n\n");
    const chunks = speechChunks(text, 100, 400);
    expect(chunks[0]!.length).toBeLessThanOrEqual(100);
    for (const c of chunks.slice(1)) expect(c.length).toBeLessThanOrEqual(400);
    expect(chunks.length).toBeGreaterThan(2);
    const words = (s: string) => s.split(/\s+/).filter(Boolean);
    expect(chunks.flatMap(words)).toEqual(words(text));
  });

  it("cuts a paragraph with no break on sentences, and a monster word where it must", () => {
    const long = Array.from({ length: 20 }, (_, i) => sentence(i)).join(" ");
    const chunks = speechChunks(long, 120, 300);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(300);
    expect(chunks.every((c) => /\.$/.test(c))).toBe(true);
    const hash = "x".repeat(700);
    const cut = speechChunks(hash, 200, 300);
    expect(cut.join("")).toBe(hash);
    for (const c of cut) expect(c.length).toBeLessThanOrEqual(300);
  });

  it("list lines inside a paragraph are read as separate sentences", () => {
    expect(speechChunks("Fiz:\nprimeiro item\nsegundo item")).toEqual(["Fiz: primeiro item. segundo item"]);
  });
});

/* ------------------------------------------------------------------ player */

class FakeAudio implements AudioLike {
  src = "";
  played: string[] = [];
  paused = 0;
  failPlay = false;
  private handlers: Record<string, Set<() => void>> = { ended: new Set(), error: new Set() };
  play(): Promise<void> {
    if (this.failPlay && !this.src.startsWith("data:")) return Promise.reject(new Error("NotAllowedError"));
    this.played.push(this.src);
    return Promise.resolve();
  }
  pause(): void {
    this.paused += 1;
  }
  addEventListener(type: "ended" | "error", fn: () => void): void {
    this.handlers[type]!.add(fn);
  }
  removeEventListener(type: "ended" | "error", fn: () => void): void {
    this.handlers[type]!.delete(fn);
  }
  emit(type: "ended" | "error"): void {
    for (const fn of [...this.handlers[type]!]) fn();
  }
}

function rig() {
  const audio = new FakeAudio();
  const requests: Array<{ text: string; signal: AbortSignal; resolve: (b: Blob) => void; reject: (e: unknown) => void }> = [];
  const revoked: string[] = [];
  const onError = vi.fn();
  const player = new ReadAloudPlayer({
    fetchAudio: (_card, text, signal) =>
      new Promise<Blob>((resolve, reject) => {
        requests.push({ text, signal, resolve, reject });
        signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      }),
    makeAudio: () => audio,
    createUrl: (blob) => `blob:${(blob as unknown as { tag: string }).tag}`,
    revokeUrl: (url) => revoked.push(url),
    onError,
  });
  const blob = (tag: string) => ({ tag }) as unknown as Blob;
  return { audio, requests, revoked, onError, player, blob };
}

const flush = () => new Promise((r) => setTimeout(r, 0));
// Two pieces: a first paragraph over 280 characters forces a second.
const LONG = `${"Primeira parte da resposta. ".repeat(12)}\n\n${"Segunda parte da resposta. ".repeat(12)}`;

describe("ReadAloudPlayer", () => {
  it("loading → playing → idle, piece by piece, fetching the next while the current plays", async () => {
    const { audio, requests, player, blob, revoked } = rig();
    const states: Array<string | null> = [];
    player.subscribe(() => states.push(player.getState()?.phase ?? null));

    player.start("row-1", "card-1", LONG);
    // The click itself plays the silent unlock — mobile browsers need the gesture.
    expect(audio.played[0]).toMatch(/^data:audio\/wav/);
    expect(player.getState()).toEqual({ id: "row-1", cardId: "card-1", phase: "loading" });
    expect(requests).toHaveLength(1);

    requests[0]!.resolve(blob("a"));
    await flush();
    expect(audio.played.at(-1)).toBe("blob:a");
    expect(player.getState()?.phase).toBe("playing");
    expect(requests).toHaveLength(2); // the next piece is already on its way

    requests[1]!.resolve(blob("b"));
    await flush();
    expect(audio.played).toHaveLength(2); // still playing the first
    audio.emit("ended");
    await flush();
    expect(audio.played.at(-1)).toBe("blob:b");
    audio.emit("ended");
    await flush();
    expect(player.getState()).toBeNull();
    expect(states).toEqual(["loading", "playing", null]);
    expect(revoked).toEqual(expect.arrayContaining(["blob:a", "blob:b"]));
  });

  it("stop cuts the audio, aborts the fetches and is not reported as an error", async () => {
    const { audio, requests, player, blob, onError } = rig();
    player.start("row-1", "card-1", LONG);
    requests[0]!.resolve(blob("a"));
    await flush();
    player.stop();
    await flush();
    expect(player.getState()).toBeNull();
    expect(audio.paused).toBeGreaterThan(0);
    expect(audio.src).toBe("");
    expect(requests[1]!.signal.aborted).toBe(true);
    expect(onError).not.toHaveBeenCalled();
  });

  it("stop while still loading the first piece: nothing ever plays", async () => {
    const { audio, requests, player, blob } = rig();
    player.start("row-1", "card-1", "Curta.");
    player.stop();
    requests[0]!.resolve(blob("late"));
    await flush();
    expect(audio.played.filter((s) => s.startsWith("blob:"))).toEqual([]);
    expect(player.getState()).toBeNull();
  });

  it("starting another answer ends the first — one voice at a time", async () => {
    const { audio, requests, player, blob } = rig();
    player.start("row-1", "card-1", "Primeira.");
    requests[0]!.resolve(blob("a"));
    await flush();
    player.start("row-2", "card-1", "Segunda.");
    expect(requests[0]!.signal.aborted).toBe(true);
    expect(player.getState()).toEqual({ id: "row-2", cardId: "card-1", phase: "loading" });
    requests[1]!.resolve(blob("b"));
    await flush();
    audio.emit("ended");
    await flush();
    expect(player.getState()).toBeNull();
    expect(audio.played.filter((s) => s.startsWith("blob:"))).toEqual(["blob:a", "blob:b"]);
  });

  it("a failed piece stops the reading and says why", async () => {
    const { requests, player, onError } = rig();
    player.start("row-1", "card-1", "Uma frase.");
    const err = { response: { status: 429 } };
    requests[0]!.reject(err);
    await flush();
    expect(player.getState()).toBeNull();
    expect(onError).toHaveBeenCalledWith(err);
    expect(readAloudError(err)).toBe("readAloud.err.rate");
    expect(readAloudError({ response: { status: 503 } })).toBe("readAloud.err.unavailable");
    expect(readAloudError(new Error("x"))).toBe("readAloud.err.failed");
  });

  it("a browser that refuses to play stops too, instead of hanging on 'loading'", async () => {
    const { audio, requests, player, blob, onError } = rig();
    audio.failPlay = true;
    player.start("row-1", "card-1", "Uma frase.");
    requests[0]!.resolve(blob("a"));
    await flush();
    expect(player.getState()).toBeNull();
    expect(onError).toHaveBeenCalledOnce();
  });

  it("an answer with nothing speakable does not start", () => {
    const { requests, player } = rig();
    player.start("row-1", "card-1", "   ");
    expect(player.getState()).toBeNull();
    expect(requests).toHaveLength(0);
  });
});
