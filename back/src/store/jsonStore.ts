import { readFile, mkdir, stat } from "node:fs/promises";
import type { Stats } from "node:fs";
import { dirname } from "node:path";
import { writeFileAtomic } from "./atomicWrite.js";

/**
 * A tiny persistence helper: one JSON file per concern, mode 600, atomic writes (tmp + rename), and
 * a single mutation queue so concurrent writers never clobber each other.
 *
 * Why a queue: every mutation runs the full load -> mutate -> persist cycle. Without serialization,
 * two overlapping mutations both persist a snapshot of the WHOLE document and the last one silently
 * undoes the first — exactly the race that status hooks (many, fast, concurrent) would hit.
 *
 * The queue only covers ONE process. A blue/green deploy runs two backs on the same /data for a few
 * seconds, so every mutation first checks that the file is still the one this process last read or
 * wrote (see `fileChanged`) and reloads it when the other process wrote in between.
 */
export class JsonStore<T extends object> {
  private queue: Promise<unknown> = Promise.resolve();
  private cache: T | null = null;
  /**
   * The cold read in flight, shared by every caller that finds no cache. Two independent reads
   * race: a slow one that read the old file could land AFTER a mutation persisted and put the old
   * document back in the cache — and the next mutation would then write it to disk.
   */
  private loading: Promise<T> | null = null;
  /**
   * The cache as the disk has it (serialized like `persist` writes it). A mutation that throws is
   * compared against it: unchanged = a refusal before any write, and the cache stays.
   */
  private saved: string | null = null;
  /** Identity of the file the cache came from (null = no file on disk yet). */
  private stamp: FileStamp | null = null;

  constructor(
    private readonly file: string,
    private readonly seed: () => T,
    /** Migrates/normalizes a document read from disk (fills fields added by later versions). */
    private readonly normalize: (raw: unknown) => T = (raw) => raw as T,
  ) {}

  /** Reads the document (cached after first load). Missing file = seed, not an error. */
  async load(): Promise<T> {
    if (this.cache) return this.cache;
    this.loading ??= this.readFromDisk().finally(() => {
      this.loading = null;
    });
    return await this.loading;
  }

  private async readFromDisk(): Promise<T> {
    try {
      // Stat BEFORE reading: a write landing between the two leaves a stamp older than the content,
      // which only costs one extra reload — the other order could pair new content with no reload.
      const stamp = toStamp(await stat(this.file));
      const raw = await readFile(this.file, "utf8");
      this.cache = this.normalize(JSON.parse(raw));
      this.stamp = stamp;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      this.cache = this.seed();
      this.stamp = null;
    }
    this.saved = serialize(this.cache);
    return this.cache;
  }

  /**
   * Runs `fn` against the current document and persists the result. Serialized: the next mutation
   * only starts after this one has hit the disk.
   *
   * All or nothing: `fn` mutates the cached document IN PLACE (callers rely on the live objects —
   * see the SNAPSHOT notes in board.ts/cardMove.ts), so when `fn` throws halfway or the write fails
   * (disk full) the cache holds a change the disk never got. Dropping the cache makes the next read
   * reload the file — the last state that did persist, since the write is tmp + atomic rename —
   * instead of serving the rejected change and letting the next successful mutation persist it.
   *
   * Only then: most throws are REFUSALS raised before `fn` touched anything ("already exists",
   * "install already set up"), and dropping the cache for those cost a disk read per refusal and
   * handed callers a new document while they held the old live objects. So a throw from `fn` drops
   * the cache only when the document no longer matches what the disk has; a failed write always does.
   */
  mutate<R>(fn: (doc: T) => R): Promise<R> {
    const run = async (): Promise<R> => {
      if (this.cache && (await this.fileChanged())) this.dropCache();
      const doc = await this.load();
      let result: R;
      try {
        result = fn(doc);
      } catch (err) {
        if (serialize(doc) !== this.saved) this.dropCache();
        throw err;
      }
      try {
        // Nothing changed and the file exists: rewriting it would only cost a full serialize+fsync
        // (status hooks and periodic prunes call this a lot with nothing to do).
        if (this.stamp === null || serialize(doc) !== this.saved) await this.persist(doc);
      } catch (err) {
        this.dropCache();
        throw err;
      }
      return result;
    };
    const next = this.queue.then(run, run);
    // Keep the chain alive even when a mutation rejects — one failure must not poison the queue.
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async persist(doc: T): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    const text = serialize(doc);
    this.stamp = toStamp(await writeFileAtomic(this.file, text));
    this.cache = doc;
    this.saved = text;
  }

  /** Did someone else (the other process of a deploy) replace the file since we last saw it? */
  private async fileChanged(): Promise<boolean> {
    let current: FileStamp | null;
    try {
      current = toStamp(await stat(this.file));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      current = null;
    }
    return !sameStamp(current, this.stamp);
  }

  private dropCache(): void {
    this.cache = null;
    this.saved = null;
    this.stamp = null;
  }

  /** Drops the in-memory cache — tests and hot-reload only. */
  resetForTesting(): void {
    this.dropCache();
    this.loading = null;
    this.queue = Promise.resolve();
  }
}

/**
 * What tells one version of the file from another. The inode is the strong part: every write is a
 * rename of a fresh tmp, so a new version is a new inode even within the same millisecond.
 */
interface FileStamp { ino: number; size: number; mtimeMs: number }

function toStamp(s: Stats): FileStamp {
  return { ino: s.ino, size: s.size, mtimeMs: s.mtimeMs };
}

function sameStamp(a: FileStamp | null, b: FileStamp | null): boolean {
  if (!a || !b) return a === b;
  return a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs;
}

/** The document as the file holds it. */
function serialize(doc: object): string {
  return JSON.stringify(doc, null, 2);
}
