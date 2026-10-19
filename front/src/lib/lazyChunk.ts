/**
 * LAZY CHUNKS QUE SOBREVIVEM A UM DEPLOY.
 *
 * Um `import()` dinâmico baixa um pedaço do bundle sob demanda (o noVNC do Navegador, por exemplo).
 * Se ele acontece no instante em que o vibehub está reiniciando para um deploy, a requisição falha —
 * e o navegador GUARDA essa falha para aquela URL: o mesmo `import()` continua falhando depois que o
 * servidor volta, até a página ser recarregada (verificado no Chromium 153: mesma URL falha de novo,
 * URL nova carrega). Foi o "Failed to fetch dynamically imported module" com um "Tentar de novo" que
 * nunca funcionava (produção, 2026-10-19).
 *
 * A recuperação, em ordem:
 *  1. não é falha de chunk → o erro sobe intacto (não é problema de rede, não há o que tentar);
 *  2. espera o servidor responder `/api/health` (o reinício leva segundos);
 *  3. carrega o MESMO chunk por uma URL nova (`?retry=<agora>`), que o cache de falhas não conhece;
 *  4. se nem assim → `ChunkLoadFailure`: o deploy trocou os arquivos (o hash do chunk mudou) e só
 *     uma recarga da página, que traz o `index.html` novo, resolve. Quem chama oferece o botão.
 */

/** Por que a recuperação desistiu: o servidor não voltou, ou a página está numa versão velha. */
export type ChunkFailureReason = "server_down" | "stale";

export class ChunkLoadFailure extends Error {
  constructor(readonly reason: ChunkFailureReason, cause?: unknown) {
    super(reason === "server_down" ? "the vibehub server did not come back" : "this page is running an old version");
    this.name = "ChunkLoadFailure";
    this.cause = cause;
  }
}

/** A mensagem de falha de carga de módulo de cada motor (Chromium, Safari, Firefox). */
const CHUNK_ERROR_RE = /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module/i;

/** É a falha de carregar um chunk (rede/servidor), e não um erro do próprio módulo? PURA. */
export function isChunkLoadError(err: unknown): boolean {
  return err instanceof Error && CHUNK_ERROR_RE.test(err.message);
}

/** A URL do chunk, quando o motor a cita na mensagem (Chromium e Firefox citam). PURA. */
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

/** Quanto se espera o servidor voltar: um deploy do vibehub leva de segundos a um minuto e pouco. */
export const SERVER_WAIT_MS = 90_000;
const SERVER_POLL_MS = 2_000;

/** Sonda `/api/health` até responder ok ou o prazo acabar. */
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
      /* ainda reiniciando */
    }
    if (now() + interval > deadline) return false;
    await sleep(interval);
  }
}

export interface ImportChunkDeps {
  /** Importa por URL crua — o caminho que o Vite não reescreve. */
  importUrl?: (url: string) => Promise<unknown>;
  waitForServer?: () => Promise<boolean>;
  /** Avisado quando a primeira tentativa falhou e a recuperação começou (a tela diz "reconectando"). */
  onRecovering?: () => void;
  now?: () => number;
}

/** `load` com a recuperação descrita no topo do arquivo. */
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
