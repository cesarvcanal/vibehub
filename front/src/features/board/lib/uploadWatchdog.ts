/**
 * A deadline for the image upload, which used to have none.
 *
 * Produção, 2026-10-31: an image attached on the phone spun forever ("0 of 2 images uploaded…")
 * until the card was closed and opened again. The server logs show the original page's request
 * never arrived — only the re-send from the reopened page did. A request on a dead connection (iOS
 * putting the tab in the background, the VPN re-handshaking) neither answers nor fails, and with no
 * deadline the chip waited on it for good, holding the message hostage behind it.
 *
 * The deadline is on SILENCE, not on total time: a big photo over a slow network may take minutes
 * and is fine as long as bytes keep leaving. Two budgets:
 *  - `stallMs`: no byte has gone out for this long while sending — the connection is dead;
 *  - `processingMs`: the body is all out and the server has not answered for this long.
 * A stalled attempt is aborted and sent again (a fresh request opens a fresh connection), up to
 * `attempts`; after that it is an error, which the chip shows with Retry.
 *
 * Timers do not run in a background tab on iOS, so the check also runs the moment the tab becomes
 * visible again — that is exactly when a request killed in the background has to be noticed.
 */

export interface UploadAttemptContext {
  /** Aborted when the watchdog gives up on this attempt. */
  signal: AbortSignal;
  /** Bytes went out. `done` = the whole body is sent and the server is working on it. */
  onProgress: (done: boolean) => void;
}

export type UploadAttempt<T> = (ctx: UploadAttemptContext) => Promise<T>;

export interface UploadWatchdogOptions {
  stallMs: number;
  processingMs: number;
  /** Total tries, the first included. */
  attempts: number;
}

/** Defaults for the image upload: 30 s of silence while sending, 45 s for the runner to answer. */
export const UPLOAD_WATCHDOG: UploadWatchdogOptions = { stallMs: 30_000, processingMs: 45_000, attempts: 2 };

/** How often the silence is measured while the tab is in the foreground. */
const CHECK_EVERY_MS = 1_000;

export class UploadStalledError extends Error {
  constructor() {
    super("the upload stopped answering");
    this.name = "UploadStalledError";
  }
}

/**
 * Worth trying again: the watchdog gave up, or the request died without ANY answer (network error).
 * A real answer from the server — a 4xx saying the image is too big, say — is final. PURE.
 */
export function isRetryableUploadError(error: unknown): boolean {
  if (error instanceof UploadStalledError) return true;
  const e = error as { response?: unknown; code?: unknown } | null;
  if (!e || typeof e !== "object") return false;
  return e.response === undefined && e.code === "ERR_NETWORK";
}

function runOnce<T>(attempt: UploadAttempt<T>, opts: UploadWatchdogOptions): Promise<T> {
  const controller = new AbortController();
  let lastActivity = Date.now();
  let sent = false;

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
      fn();
    };

    const check = () => {
      const budget = sent ? opts.processingMs : opts.stallMs;
      if (Date.now() - lastActivity < budget) return;
      controller.abort();
      // The attempt may not listen to the signal (a FileReader that never calls back): the
      // watchdog settles on its own instead of waiting for it.
      finish(() => reject(new UploadStalledError()));
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") check();
    };
    const timer = setInterval(check, CHECK_EVERY_MS);
    document.addEventListener("visibilitychange", onVisibility);

    const onProgress = (done: boolean) => {
      lastActivity = Date.now();
      if (done) sent = true;
    };

    let pending: Promise<T>;
    try {
      pending = attempt({ signal: controller.signal, onProgress });
    } catch (error) {
      finish(() => reject(error));
      return;
    }
    pending.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    );
  });
}

/** Runs `attempt` under the watchdog, trying again on a stall or a dropped connection. */
export async function uploadWithWatchdog<T>(
  attempt: UploadAttempt<T>,
  opts: UploadWatchdogOptions = UPLOAD_WATCHDOG,
): Promise<T> {
  const tries = Math.max(1, opts.attempts);
  for (let i = 1; ; i += 1) {
    try {
      return await runOnce(attempt, opts);
    } catch (error) {
      if (i >= tries || !isRetryableUploadError(error)) throw error;
    }
  }
}
