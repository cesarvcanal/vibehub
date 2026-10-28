import * as React from "react";
import { api } from "@/lib/api";

/**
 * READ ALOUD — the speaker button under a finished answer, like ChatGPT's.
 *
 * The answer is markdown written to be READ: code, tables and link targets are noise to the ear. So
 * it is first turned into plain speakable text ({@link speakableText}), then cut into pieces
 * ({@link speechChunks}) — a SHORT first one, so the voice starts in a second or two, then bigger
 * ones. Each piece is one `POST /api/cards/:id/voice/speech` (OpenAI TTS behind the server's key)
 * and comes back as MP3; the next piece is fetched while the current one plays.
 *
 * One answer plays at a time in the whole app: {@link readAloud} is a single player, and starting
 * another answer (or pressing stop) ends the one playing — fetches aborted, audio cut.
 */

/** Markdown → what a voice should say. PURE. */
export function speakableText(markdown: string): string {
  let text = markdown.replace(/\r\n?/g, "\n");
  // Code blocks are read by nobody: say there was one, once.
  text = text.replace(/```[\s\S]*?(```|$)/g, "\n\n(trecho de código omitido)\n\n");
  text = text.replace(/`([^`\n]+)`/g, "$1");
  text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1");
  text = text.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
  text = text.replace(/https?:\/\/\S+/g, "link");
  text = text
    .split("\n")
    .filter((line) => !/^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(line)) // table rule
    .filter((line) => !/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) // horizontal rule
    .map((line) =>
      line
        .replace(/^\s{0,3}#{1,6}\s+/, "")
        .replace(/^\s*>\s?/, "")
        .replace(/^\s*[-*+]\s+(\[[ xX]\]\s+)?/, "")
        .replace(/^\s*\|(.*)\|\s*$/, (_m, cells: string) => cells.split("|").map((c) => c.trim()).filter(Boolean).join(", ")),
    )
    .join("\n");
  text = text
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/(^|[^\w*])\*(?!\s)([^*\n]+?)\*(?!\w)/g, "$1$2")
    .replace(/(^|[^\w_])_(?!\s)([^_\n]+?)_(?!\w)/g, "$1$2")
    .replace(/~~(.+?)~~/g, "$1");
  return text.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** The first piece: short, so the voice starts fast. */
export const FIRST_CHUNK_CHARS = 280;
/** Every other piece. Well under OpenAI's 4096-character ceiling per request. */
export const CHUNK_CHARS = 1_500;

/** Breaks one over-long unit (no paragraph break inside) into sentence-, then word-sized parts. PURE. */
function splitLong(unit: string, max: number): string[] {
  if (unit.length <= max) return [unit];
  const parts: string[] = [];
  let current = "";
  const pieces = unit.split(/(?<=[.!?…;:])\s+/).flatMap((sentence) => {
    if (sentence.length <= max) return [sentence];
    const words: string[] = [];
    let w = "";
    for (const word of sentence.split(/\s+/)) {
      // A single "word" longer than the limit (a hash, a path) is cut where it must be.
      for (let i = 0; i < word.length; i += max) {
        const bit = word.slice(i, i + max);
        if (w && w.length + 1 + bit.length > max) {
          words.push(w);
          w = bit;
        } else w = w ? `${w} ${bit}` : bit;
      }
    }
    if (w) words.push(w);
    return words;
  });
  for (const piece of pieces) {
    if (current && current.length + 1 + piece.length > max) {
      parts.push(current);
      current = piece;
    } else current = current ? `${current} ${piece}` : piece;
  }
  if (current) parts.push(current);
  return parts;
}

/** A paragraph's lines (list items, a table) as one run, each line closed as a sentence. PURE. */
function joinLines(paragraph: string): string {
  return paragraph.replace(/([^.!?…:;,])[ \t]*\n\s*/g, "$1. ").replace(/\s*\n\s*/g, " ");
}

/**
 * Speakable text → pieces of at most `first` (the first) / `rest` characters, cut on paragraph,
 * then sentence, then word boundaries. Nothing is lost or reordered. PURE.
 */
export function speechChunks(text: string, first: number = FIRST_CHUNK_CHARS, rest: number = CHUNK_CHARS): string[] {
  // Units no bigger than the smallest limit, each knowing whether a paragraph starts with it.
  const units = text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .flatMap((paragraph) => splitLong(joinLines(paragraph), Math.min(first, rest)).map((unit, i) => ({ unit, para: i === 0 })));
  const chunks: string[] = [];
  let current = "";
  for (const { unit, para } of units) {
    const sep = para ? "\n\n" : " ";
    const limit = chunks.length === 0 ? first : rest;
    if (current && current.length + sep.length + unit.length <= limit) current = `${current}${sep}${unit}`;
    else {
      if (current) chunks.push(current);
      current = unit;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

/* ------------------------------------------------------------------ player */

export type ReadAloudPhase = "loading" | "playing";
export interface ReadAloudState {
  /** The answer being read (a chat row id). */
  id: string;
  cardId: string;
  phase: ReadAloudPhase;
}

/** The slice of HTMLAudioElement the player uses — a fake in tests. */
export interface AudioLike {
  src: string;
  play(): Promise<void>;
  pause(): void;
  addEventListener(type: "ended" | "error", fn: () => void): void;
  removeEventListener(type: "ended" | "error", fn: () => void): void;
}

export interface ReadAloudDeps {
  fetchAudio: (cardId: string, text: string, signal: AbortSignal) => Promise<Blob>;
  makeAudio: () => AudioLike;
  createUrl: (blob: Blob) => string;
  revokeUrl: (url: string) => void;
  /** A piece could not be fetched or played: the reading stops and this says why. */
  onError?: (err: unknown) => void;
}

/**
 * A tiny silent WAV played on the CLICK itself: mobile browsers only let an element play after a
 * gesture, and the first real piece arrives after a network round-trip — by then the gesture is
 * gone. Playing this first "unlocks" the element for the pieces that follow.
 */
const SILENCE = "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=";

export class ReadAloudPlayer {
  private state: ReadAloudState | null = null;
  private listeners = new Set<() => void>();
  private token = 0;
  private abort: AbortController | null = null;
  private audio: AudioLike | null = null;
  private urls: string[] = [];
  /** Wakes the piece waiting on `ended` when the reading is stopped. */
  private wake: (() => void) | null = null;

  constructor(private readonly deps: ReadAloudDeps) {}

  getState = (): ReadAloudState | null => this.state;

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  private set(next: ReadAloudState | null): void {
    this.state = next;
    for (const fn of this.listeners) fn();
  }

  /** Starts reading `text` as answer `id` — whatever was playing stops first. Call it on the click. */
  start(id: string, cardId: string, text: string): void {
    this.stop();
    const chunks = speechChunks(speakableText(text));
    if (chunks.length === 0) return;
    const token = ++this.token;
    const abort = new AbortController();
    this.abort = abort;
    if (!this.audio) this.audio = this.deps.makeAudio();
    const audio = this.audio;
    audio.src = SILENCE;
    void audio.play().catch(() => undefined);
    this.set({ id, cardId, phase: "loading" });
    void this.run(token, cardId, chunks, abort.signal, audio);
  }

  /** Ends the reading, wherever it is: fetches aborted, audio cut, state back to idle. */
  stop(): void {
    this.token += 1;
    this.abort?.abort();
    this.abort = null;
    if (this.audio) {
      this.audio.pause();
      this.audio.src = "";
    }
    this.wake?.();
    this.wake = null;
    for (const url of this.urls) this.deps.revokeUrl(url);
    this.urls = [];
    if (this.state) this.set(null);
  }

  private async run(token: number, cardId: string, chunks: string[], signal: AbortSignal, audio: AudioLike): Promise<void> {
    const fetched: Array<Promise<Blob> | undefined> = [];
    const get = (i: number): Promise<Blob> => {
      let p = fetched[i];
      if (!p) {
        p = this.deps.fetchAudio(cardId, chunks[i]!, signal);
        p.catch(() => undefined); // a prefetch nobody awaits yet must not surface as unhandled
        fetched[i] = p;
      }
      return p;
    };
    try {
      for (let i = 0; i < chunks.length; i += 1) {
        const blob = await get(i);
        if (token !== this.token) return;
        if (i + 1 < chunks.length) void get(i + 1);
        const url = this.deps.createUrl(blob);
        this.urls.push(url);
        await this.playOne(audio, url, token);
        if (token !== this.token) return;
        this.deps.revokeUrl(url);
        this.urls = this.urls.filter((u) => u !== url);
      }
      if (token === this.token) this.stop();
    } catch (err) {
      if (token !== this.token) return; // stopped on purpose: the abort is not a failure
      this.stop();
      this.deps.onError?.(err);
    }
  }

  private playOne(audio: AudioLike, url: string, token: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const done = () => {
        audio.removeEventListener("ended", onEnded);
        audio.removeEventListener("error", onError);
        this.wake = null;
      };
      const onEnded = () => {
        done();
        resolve();
      };
      const onError = () => {
        done();
        reject(new Error("audio playback failed"));
      };
      this.wake = onEnded;
      audio.addEventListener("ended", onEnded);
      audio.addEventListener("error", onError);
      audio.src = url;
      audio.play().then(
        () => {
          if (token === this.token && this.state?.phase === "loading") this.set({ ...this.state, phase: "playing" });
        },
        (err: unknown) => {
          done();
          reject(err);
        },
      );
    });
  }
}

/** The server's answer to a failed piece, as an i18n key. PURE. */
export function readAloudError(err: unknown): string {
  const status = (err as { response?: { status?: number } } | null)?.response?.status;
  if (status === 429) return "readAloud.err.rate";
  if (status === 503) return "readAloud.err.unavailable";
  return "readAloud.err.failed";
}

let errorHandler: ((err: unknown) => void) | undefined;
/** Where the app's single player reports a failure (the chat shows a toast). */
export function setReadAloudErrorHandler(fn: ((err: unknown) => void) | undefined): void {
  errorHandler = fn;
}

/** The app's single player. */
export const readAloud = new ReadAloudPlayer({
  fetchAudio: (cardId, text, signal) =>
    api
      .post<Blob>(`/cards/${encodeURIComponent(cardId)}/voice/speech`, { text }, { responseType: "blob", signal })
      .then((r) => r.data),
  makeAudio: () => new Audio(),
  createUrl: (blob) => URL.createObjectURL(blob),
  revokeUrl: (url) => URL.revokeObjectURL(url),
  onError: (err) => errorHandler?.(err),
});

/** What the single player is doing for answer `id`: null when it is not reading this one. */
export function useReadAloud(id: string, player: ReadAloudPlayer = readAloud): ReadAloudPhase | null {
  const state = React.useSyncExternalStore(player.subscribe, player.getState);
  return state?.id === id ? state.phase : null;
}
