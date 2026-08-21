/**
 * Build an absolute WebSocket URL for an `/api/...` path.
 *
 * Everything is same-origin (Vite proxies `/api` in dev, the back-end serves the built front in
 * production), so the only thing to work out is ws:// vs wss://.
 */
export function wsUrl(path: string): string {
  const normalised = path.startsWith("/") ? path : `/${path}`;
  if (typeof window === "undefined") return `ws://localhost${normalised}`;
  const scheme = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${scheme}//${window.location.host}${normalised}`;
}
