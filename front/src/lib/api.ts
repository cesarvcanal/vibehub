import axios, { type AxiosRequestConfig } from "axios";

/**
 * The single HTTP client.
 *
 * Auth is a session **cookie**, not a bearer token, so `withCredentials` is on and there is no
 * token to stash anywhere. In dev, Vite proxies `/api` to the back-end, so the browser always
 * talks to its own origin and the cookie behaves exactly as it will in production.
 */
export const api = axios.create({
  baseURL: "/api",
  withCredentials: true,
  headers: { "Content-Type": "application/json" },
});

/**
 * What to do when the session turns out to be dead.
 *
 * React registers a handler (clear the query cache, navigate to /login without a full reload).
 * Before React mounts — or if nobody registered — we fall back to a hard redirect, so we never
 * render stale data from an expired session.
 */
type UnauthorizedHandler = () => void;
let unauthorizedHandler: UnauthorizedHandler | null = null;

export function setUnauthorizedHandler(handler: UnauthorizedHandler | null): void {
  unauthorizedHandler = handler;
}

/**
 * Routes that are allowed to 401 without kicking the user out: they are how we *discover*
 * whether there is a session at all.
 */
const SILENT_401 = ["/auth/me", "/auth/login", "/setup/state", "/setup/owner"];

function isSilent(url: string | undefined): boolean {
  if (!url) return false;
  return SILENT_401.some((path) => url.startsWith(path) || url.startsWith(`/api${path}`));
}

api.interceptors.response.use(
  (response) => response,
  (error) => {
    const status = error?.response?.status;
    if (status === 401 && !isSilent(error?.config?.url)) {
      if (unauthorizedHandler) {
        unauthorizedHandler();
      } else if (typeof window !== "undefined" && window.location.pathname !== "/login") {
        window.location.replace("/login");
      }
    }
    return Promise.reject(error);
  },
);

/* ---------------------------------------------------------------- helpers */

export function get<T>(url: string, config?: AxiosRequestConfig): Promise<T> {
  return api.get<T>(url, config).then((r) => r.data);
}

export function post<T>(url: string, body?: unknown, config?: AxiosRequestConfig): Promise<T> {
  return api.post<T>(url, body, config).then((r) => r.data);
}

export function patch<T>(url: string, body?: unknown, config?: AxiosRequestConfig): Promise<T> {
  return api.patch<T>(url, body, config).then((r) => r.data);
}

export function del<T>(url: string, config?: AxiosRequestConfig): Promise<T> {
  return api.delete<T>(url, config).then((r) => r.data);
}
