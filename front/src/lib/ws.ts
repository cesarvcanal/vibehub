/**
 * Build an absolute WebSocket URL for an `/api/...` path.
 *
 * Everything is same-origin (Vite proxies `/api` in dev, the back-end serves the built front in
 * production), so the only thing to work out is ws:// vs wss:// — and Vite's base, "/" in production,
 * for an app served under a prefix (see lib/api.ts).
 */
export function wsUrl(path: string): string {
  const base = import.meta.env.BASE_URL.replace(/\/$/, "");
  const normalised = `${base}${path.startsWith("/") ? path : `/${path}`}`;
  if (typeof window === "undefined") return `ws://localhost${normalised}`;
  const scheme = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${scheme}//${window.location.host}${normalised}`;
}
