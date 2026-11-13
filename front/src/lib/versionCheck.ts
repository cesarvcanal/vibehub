import * as React from "react";
import { toast } from "sonner";
import { t } from "@/i18n";

/**
 * NEW VIBEHUB VERSION, while the tab is open.
 *
 * A deploy swaps the back and the front, but a tab opened before keeps running the old JavaScript until
 * an F5 — and whoever is looking sees the bug "still there" after it was fixed (production, 2026-10-19).
 * Same design as the tech.multi panel's `useVersionCheck`: polls `index.html` (no-store) and compares the
 * Vite entry bundle (`/assets/index-<hash>.js`, changes on every build). Changed → a notice with
 * "Recarregar agora", and the automatic reload at the first SAFE moment:
 *
 *  - the tab in the background (right away, or when it goes there);
 *  - or `VERSION_IDLE_MS` without interaction with the tab visible — whoever is using it is not interrupted.
 *
 * Reloading stops nobody's work: the chat turn lives on the server (closing the socket only
 * disconnects it), and draft, queue and outbox live in localStorage. What an F5 LOSES is what is
 * happening IN the browser — an attachment uploading, an audio being recorded. Those hold the automatic
 * reload (`holdReload`) until they finish; the notice's button remains the person's choice.
 */

/** With no interaction for this long, with the tab visible, the automatic reload happens. */
export const VERSION_IDLE_MS = 90_000;

/**
 * How often `index.html` is polled. It was 60s and the notice arrived far too late; the
 * probe is a GET of a small HTML, 20s weighs nothing.
 */
export const VERSION_POLL_MS = 20_000;

const BUNDLE_RE = /\/assets\/index-[A-Za-z0-9_-]+\.js/;

/** The entry bundle cited in an `index.html`, or null (dev server, error page). PURE. */
export function bundleFromHtml(html: string): string | null {
  const m = html.match(BUNDLE_RE);
  return m ? m[0] : null;
}

/**
 * The bundle THIS tab is running, read from the very `<script>` that loaded it. It is the reference,
 * not the first poll: a tab that already opened stale (cache, restored tab, deploy between the load and
 * the poll) would take the new version for "its own" and never warn. Null on the dev server.
 */
function runningBundle(): string | null {
  for (const el of document.querySelectorAll<HTMLScriptElement>("script[src]")) {
    const found = bundleFromHtml(el.getAttribute("src") ?? "");
    if (found) return found;
  }
  return null;
}

async function currentBundle(): Promise<string | null> {
  try {
    const res = await fetch(`${import.meta.env.BASE_URL}?v=${Date.now()}`, { cache: "no-store" });
    if (!res.ok) return null;
    return bundleFromHtml(await res.text());
  } catch {
    return null;
  }
}

/* -------------------------------------------------------- holds */

const holds = new Set<string>();
const holdListeners = new Set<() => void>();

/** Something in progress in the browser that an F5 would lose (unique `key`: "upload:<card>"). */
export function holdReload(key: string): void {
  holds.add(key);
}

/** Finished: the pending reload, if any, may happen again. */
export function releaseReload(key: string): void {
  if (!holds.delete(key)) return;
  for (const notify of [...holdListeners]) notify();
}

export function reloadHeld(): boolean {
  return holds.size > 0;
}

export function resetReloadHoldsForTesting(): void {
  holds.clear();
  holdListeners.clear();
}

/** Turns a hold on/off according to `active`, and releases it on unmount. */
export function useReloadHold(key: string, active: boolean): void {
  React.useEffect(() => {
    if (!active) return;
    holdReload(key);
    return () => releaseReload(key);
  }, [key, active]);
}

/* -------------------------------------------------------- hook */

export function useVersionCheck(opts: { intervalMs?: number; reload?: () => void } = {}): void {
  const intervalMs = opts.intervalMs ?? VERSION_POLL_MS;
  const reloadRef = React.useRef(opts.reload ?? (() => window.location.reload()));
  reloadRef.current = opts.reload ?? (() => window.location.reload());

  React.useEffect(() => {
    let alive = true;
    let loaded: string | null = runningBundle();
    let pending = false;
    let lastInteraction = Date.now();
    let idleTimer: number | undefined;

    const reloadNow = (): void => {
      if (!alive) return;
      alive = false;
      reloadRef.current();
    };
    /** The AUTOMATIC reload: only with the new version detected, nothing holding and the tab idle. */
    const maybeReload = (): void => {
      if (!alive || !pending || reloadHeld()) return;
      if (document.hidden || Date.now() - lastInteraction >= VERSION_IDLE_MS) reloadNow();
    };
    const armIdle = (): void => {
      window.clearTimeout(idleTimer);
      if (!pending) return;
      idleTimer = window.setTimeout(maybeReload, Math.max(0, lastInteraction + VERSION_IDLE_MS - Date.now()));
    };
    const onInteraction = (): void => {
      lastInteraction = Date.now();
      armIdle();
    };
    // Coming back to the tab checks right away: that is when the person is going to look at the screen.
    const onVisibility = (): void => {
      maybeReload();
      if (!document.hidden) void check();
    };
    const onRelease = (): void => {
      maybeReload();
      armIdle();
    };

    const check = async (): Promise<void> => {
      const cur = await currentBundle();
      if (!alive || !cur) return;
      if (loaded === null) {
        loaded = cur; // no script on the page (dev server): the first good read is the reference
        return;
      }
      if (cur === loaded) return;
      if (!pending) {
        pending = true;
        toast(t("version.newTitle"), {
          description: t("version.newBody"),
          duration: Infinity,
          action: { label: t("version.reloadNow"), onClick: reloadNow },
        });
      }
      maybeReload();
      armIdle();
    };

    const events = ["mousemove", "keydown", "pointerdown", "scroll", "touchstart"] as const;
    for (const ev of events) window.addEventListener(ev, onInteraction, { passive: true });
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("focus", check);
    holdListeners.add(onRelease);
    void check();
    const poll = window.setInterval(() => void check(), intervalMs);
    return () => {
      alive = false;
      window.clearInterval(poll);
      window.clearTimeout(idleTimer);
      for (const ev of events) window.removeEventListener(ev, onInteraction);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("focus", check);
      holdListeners.delete(onRelease);
    };
  }, [intervalMs]);
}

/** Mounted once in the app: the polling draws nothing, only the notice when there is one. */
export function VersionWatcher(): null {
  useVersionCheck();
  return null;
}
