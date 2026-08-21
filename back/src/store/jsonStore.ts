import { readFile, writeFile, mkdir, chmod, rename } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * A tiny persistence helper: one JSON file per concern, mode 600, atomic writes (tmp + rename), and
 * a single mutation queue so concurrent writers never clobber each other.
 *
 * Why a queue: every mutation runs the full load -> mutate -> persist cycle. Without serialization,
 * two overlapping mutations both persist a snapshot of the WHOLE document and the last one silently
 * undoes the first — exactly the race that status hooks (many, fast, concurrent) would hit.
 */
export class JsonStore<T extends object> {
  private queue: Promise<unknown> = Promise.resolve();
  private cache: T | null = null;

  constructor(
    private readonly file: string,
    private readonly seed: () => T,
    /** Migrates/normalizes a document read from disk (fills fields added by later versions). */
    private readonly normalize: (raw: unknown) => T = (raw) => raw as T,
  ) {}

  /** Reads the document (cached after first load). Missing file = seed, not an error. */
  async load(): Promise<T> {
    if (this.cache) return this.cache;
    try {
      const raw = await readFile(this.file, "utf8");
      this.cache = this.normalize(JSON.parse(raw));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      this.cache = this.seed();
    }
    return this.cache;
  }

  /**
   * Runs `fn` against the current document and persists the result. Serialized: the next mutation
   * only starts after this one has hit the disk.
   */
  mutate<R>(fn: (doc: T) => R): Promise<R> {
    const run = async (): Promise<R> => {
      const doc = await this.load();
      const result = fn(doc);
      await this.persist(doc);
      return result;
    };
    const next = this.queue.then(run, run);
    // Keep the chain alive even when a mutation rejects — one failure must not poison the queue.
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async persist(doc: T): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    await writeFile(tmp, JSON.stringify(doc, null, 2), "utf8");
    await chmod(tmp, 0o600);
    await rename(tmp, this.file);
    this.cache = doc;
  }

  /** Drops the in-memory cache — tests and hot-reload only. */
  resetForTesting(): void {
    this.cache = null;
    this.queue = Promise.resolve();
  }
}
