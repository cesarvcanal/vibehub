/**
 * LAZY CHUNKS THAT SURVIVE A DEPLOY.
 *
 * A dynamic `import()` downloads a piece of the bundle on demand (the Navegador's noVNC, for example).
 * If it happens at the instant the vibehub is restarting for a deploy, the request fails —
 * and the browser CACHES that failure for that URL: the same `import()` keeps failing after the
 * server is back, until the page is reloaded (checked on Chromium 153: same URL fails again,
 * new URL loads). It was the "Failed to fetch dynamically imported module" with a "Tentar de novo" that
 * never worked (production, 2026-10-19).
 *
 * The recovery, in order:
 *  1. not a chunk failure → the error propagates intact (not a network problem, nothing to retry);
 *  2. waits for the server to answer `/api/health` (the restart takes seconds);
 *  3. loads the SAME chunk under a new URL (`?retry=<now>`), which the failure cache does not know;
 *  4. if not even then → `ChunkLoadFailure`: the deploy swapped the files (the chunk's hash changed) and only
 *     a page reload, which brings the new `index.html`, fixes it. The caller offers the button.
 */

/** Why the recovery gave up: the server did not come back, or the page is on an old version. */
export type ChunkFailureReason = "server_down" | "stale";

export class ChunkLoadFailure extends Error {
  constructor(readonly reason: ChunkFailureReason, cause?: unknown) {
    super(reason === "server_down" ? "the vibehub server did not come back" : "this page is running an old version");
    this.name = "ChunkLoadFailure";
    this.cause = cause;
  }
}

/** Each engine's module-load failure message (Chromium, Safari, Firefox). */
const CHUNK_ERROR_RE = /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module/i;

/** Is it a failure to load a chunk (network/server), and not an error of the module itself? PURE. */
export function isChunkLoadError(err: unknown): boolean {
  return err instanceof Error && CHUNK_ERROR_RE.test(err.message);
}

/** The chunk's URL, when the engine cites it in the message (Chromium and Firefox do). PURE. */
export function chunkUrlOf(err: unknown): string | null {
  if (!(err instanceof Error)) return null;
  return /(https?:\/\/\S+?\.m?js(?:\?\S*)?)(?=\s|$)/.exec(err.message)?.[1] ?? null;
}

export interface WaitForServerOpts {
  fetcher?: (url: string, init: RequestInit) => Promise<Pick<Response, "ok">>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  budgetMs?: number;
  intervalMs?: number;
}

/** How long to wait for the server to come back: a vibehub deploy takes from seconds to a little over a minute. */
export const SERVER_WAIT_MS = 90_000;
const SERVER_POLL_MS = 2_000;

/** Polls `/api/health` until it answers ok or the deadline runs out. */
export async function waitForServer(opts: WaitForServerOpts = {}): Promise<boolean> {
  const fetcher = opts.fetcher ?? ((url, init) => fetch(url, init));
  const sleep = opts.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = opts.now ?? Date.now;
  const budget = opts.budgetMs ?? SERVER_WAIT_MS;
  const interval = opts.intervalMs ?? SERVER_POLL_MS;
  const deadline = now() + budget;
  for (;;) {
    try {
      if ((await fetcher("/api/health", { cache: "no-store" })).ok) return true;
    } catch {
      /* still restarting */
    }
    if (now() + interval > deadline) return false;
    await sleep(interval);
  }
}

export interface ImportChunkDeps {
  /** Imports by raw URL — the path Vite does not rewrite. */
  importUrl?: (url: string) => Promise<unknown>;
  waitForServer?: () => Promise<boolean>;
  /** Notified when the first attempt failed and the recovery started (the screen says "reconectando"). */
  onRecovering?: () => void;
  now?: () => number;
}

/** `load` with the recovery described at the top of the file. */
export async function importChunk<T>(load: () => Promise<T>, deps: ImportChunkDeps = {}): Promise<T> {
  try {
    return await load();
  } catch (err) {
    if (!isChunkLoadError(err)) throw err;
    deps.onRecovering?.();
    const up = await (deps.waitForServer ?? (() => waitForServer()))();
    if (!up) throw new ChunkLoadFailure("server_down", err);
    const url = chunkUrlOf(err);
    if (!url) throw new ChunkLoadFailure("stale", err);
    const fresh = `${url}${url.includes("?") ? "&" : "?"}retry=${(deps.now ?? Date.now)()}`;
    const importUrl = deps.importUrl ?? ((u: string) => import(/* @vite-ignore */ u));
    try {
      return (await importUrl(fresh)) as T;
    } catch (retryErr) {
      throw new ChunkLoadFailure("stale", retryErr);
    }
  }
}
