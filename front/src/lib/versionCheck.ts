import * as React from "react";
import { toast } from "sonner";
import { t } from "@/i18n";

/**
 * NOVA VERSÃO DO VIBEHUB, enquanto a aba está aberta.
 *
 * Um deploy troca o back e o front, mas a aba aberta antes segue rodando o JavaScript velho até um
 * F5 — e quem olha vê o bug "ainda lá" depois de corrigido (produção, 2026-10-19). Mesmo desenho do
 * `useVersionCheck` do painel tech.multi: sonda o `index.html` (no-store) e compara o bundle de
 * entrada do Vite (`/assets/index-<hash>.js`, muda a cada build). Mudou → um aviso com
 * "Recarregar agora", e a recarga sozinha no primeiro momento SEGURO:
 *
 *  - a aba em segundo plano (na hora, ou quando ela for para lá);
 *  - ou `VERSION_IDLE_MS` sem interação com a aba visível — quem está mexendo não é interrompido.
 *
 * Recarregar não para o trabalho de ninguém: o turno do chat vive no servidor (fechar o socket só
 * o desconecta), e rascunho, fila e outbox moram no localStorage. O que um F5 PERDE é o que está
 * acontecendo NO navegador — um anexo subindo, um áudio sendo gravado. Esses seguram a recarga
 * sozinha (`holdReload`) até terminarem; o botão do aviso continua sendo escolha da pessoa.
 */

/** Sem interação por este tempo, com a aba visível, a recarga sozinha acontece. */
export const VERSION_IDLE_MS = 90_000;

/** De quanto em quanto tempo o `index.html` é sondado. */
export const VERSION_POLL_MS = 60_000;

const BUNDLE_RE = /\/assets\/index-[A-Za-z0-9_-]+\.js/;

/** O bundle de entrada citado num `index.html`, ou null (dev server, página de erro). PURA. */
export function bundleFromHtml(html: string): string | null {
  const m = html.match(BUNDLE_RE);
  return m ? m[0] : null;
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

/** Algo em andamento no navegador que um F5 perderia (`key` único: "upload:<card>"). */
export function holdReload(key: string): void {
  holds.add(key);
}

/** Terminou: a recarga pendente, se houver, volta a poder acontecer. */
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

/** Liga/desliga uma retenção conforme `active`, e solta ao desmontar. */
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
    let loaded: string | null = null;
    let pending = false;
    let lastInteraction = Date.now();
    let idleTimer: number | undefined;

    const reloadNow = (): void => {
      if (!alive) return;
      alive = false;
      reloadRef.current();
    };
    /** A recarga SOZINHA: só com a versão nova detectada, nada segurando e a aba sem uso. */
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
    const onVisibility = (): void => maybeReload();
    const onRelease = (): void => {
      maybeReload();
      armIdle();
    };

    const check = async (): Promise<void> => {
      const cur = await currentBundle();
      if (!alive || !cur) return;
      if (loaded === null) {
        loaded = cur; // a primeira leitura boa é a versão que esta aba está rodando
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

/** Montado uma vez no app: a sondagem não desenha nada, só o aviso quando houver. */
export function VersionWatcher(): null {
  useVersionCheck();
  return null;
}
