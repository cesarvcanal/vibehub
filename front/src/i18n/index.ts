import * as React from "react";
import { en } from "@/i18n/en";
import { ptBR } from "@/i18n/pt-BR";

/**
 * The whole of vibehub's internationalisation: two flat dictionaries, one `t()`, one hook.
 *
 * No dependency, on purpose. This is a self-hosted tool with two languages and a few hundred
 * strings — an i18n framework here would be more configuration than copy. What it does have is the
 * three things a framework is actually used for:
 *
 *  - **`{name}` interpolation**, so a sentence stays one string instead of three fragments glued
 *    around a value in JSX (which is what makes a translation read like a translation).
 *  - **plurals**, through `.one` / `.other` sibling keys picked from `vars.n`.
 *  - **live switching**: `setLanguage()` notifies every `useT()` subscriber, so the language select
 *    in Settings re-renders the app instead of asking for a reload.
 *
 * English is the open-source default and `en.ts` carries the current English copy VERBATIM, so a
 * missing key in the other dictionary degrades to English rather than to a raw key.
 */

export type Language = "en" | "pt-BR";

export const LANGUAGES: readonly { id: Language; label: string }[] = [
  { id: "pt-BR", label: "Português (Brasil)" },
  { id: "en", label: "English" },
] as const;

export const LANGUAGE_KEY = "vibehub.language";

const DICTIONARIES: Record<Language, Record<string, string>> = { en, "pt-BR": ptBR };

export type Vars = Record<string, string | number | undefined | null>;

/** A stored choice, when it is one of ours. Anything else (or no storage at all) is "not chosen". */
export function storedLanguage(): Language | null {
  try {
    const raw = localStorage.getItem(LANGUAGE_KEY);
    return raw === "en" || raw === "pt-BR" ? raw : null;
  } catch {
    return null;
  }
}

/**
 * Which language this browser gets, in order: the stored choice, then the browser's own preference
 * (anything starting with `pt` is Brazilian Portuguese here — there is no pt-PT dictionary), then
 * English. PURE apart from reading storage and `navigator`.
 */
export function resolveLanguage(): Language {
  const stored = storedLanguage();
  if (stored) return stored;
  const nav = typeof navigator !== "undefined" ? navigator.language || "" : "";
  return nav.toLowerCase().startsWith("pt") ? "pt-BR" : "en";
}

let current: Language = resolveLanguage();
const listeners = new Set<() => void>();

export function getLanguage(): Language {
  return current;
}

/** Reflects the language on `<html lang>` so the browser (and a screen reader) knows what it reads. */
function applyHtmlLang(language: Language): void {
  if (typeof document === "undefined") return;
  document.documentElement.lang = language;
}

/**
 * Switches the language for this browser: stored, stamped on `<html>`, and pushed to every
 * subscriber so the screen re-renders where it stands.
 */
export function setLanguage(language: Language): void {
  current = language;
  try {
    localStorage.setItem(LANGUAGE_KEY, language);
  } catch {
    /* private mode: the choice still holds for this session */
  }
  applyHtmlLang(language);
  for (const listener of listeners) listener();
}

/** Test seam: drop the stored choice and re-resolve, without touching `localStorage` semantics. */
export function resetLanguage(): void {
  current = resolveLanguage();
  applyHtmlLang(current);
  for (const listener of listeners) listener();
}

applyHtmlLang(current);

/** Replaces every `{name}` with the matching var. An unknown placeholder is left alone. PURE. */
export function interpolate(template: string, vars?: Vars): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = vars[name];
    return value === undefined || value === null ? match : String(value);
  });
}

/**
 * Looks a key up in the active dictionary, falling back to English and then to the key itself — a
 * visible key is a bug report, and it is far better than a blank button.
 *
 * When `vars.n` is a number and a `.one` / `.other` sibling exists, the count picks the form.
 */
export function t(key: string, vars?: Vars): string {
  const dict = DICTIONARIES[current] ?? en;
  const n = vars?.n;
  const plural = typeof n === "number" ? `${key}.${n === 1 ? "one" : "other"}` : null;
  const resolved =
    plural && (dict[plural] !== undefined || en[plural] !== undefined) ? plural : key;
  const template = dict[resolved] ?? en[resolved] ?? resolved;
  return interpolate(template, vars);
}

/**
 * `t` bound to the component: identical to the module-level one, except the component re-renders
 * when the language changes. Use it anywhere the string is rendered; use `t` for one-shot text like
 * a toast, which is created after the fact and never re-rendered.
 */
export function useT(): typeof t {
  const [, force] = React.useReducer((n: number) => n + 1, 0);
  React.useEffect(() => {
    listeners.add(force);
    return () => {
      listeners.delete(force);
    };
  }, []);
  return t;
}

/**
 * Server messages arrive in English. The common ones are worth translating — they are what a person
 * actually reads when something fails — and anything else passes straight through rather than being
 * mangled or swallowed.
 */
const API_ERROR_KEYS: Record<string, string> = {
  "not found": "apiError.notFound",
  "not authenticated": "apiError.notAuthenticated",
  "invalid username or password": "apiError.invalidCredentials",
  "the runner is unreachable": "apiError.runnerUnreachable",
  "runner is unreachable": "apiError.runnerUnreachable",
  forbidden: "apiError.forbidden",
  unauthorized: "apiError.unauthorized",
  "network error": "apiError.networkError",
  "internal server error": "apiError.internalServerError",
  "bad request": "apiError.badRequest",
  conflict: "apiError.conflict",
  "already exists": "apiError.alreadyExists",
  "missing fields": "apiError.missingFields",
  "invalid token": "apiError.invalidToken",
  "docker is unreachable": "apiError.dockerUnreachable",
  "setup already done": "apiError.setupAlreadyDone",
  "could not read the file": "apiError.couldNotReadFile",
};

/**
 * Translates a known server message, or returns it untouched.
 *
 * In English there is nothing to do: the server already speaks it, and rewriting its message from a
 * dictionary would only flatten the wording it chose (its capitalisation included). The mapping is
 * a translation, not a normalisation.
 */
export function translateApiError(message: string): string {
  if (current === "en") return message;
  const key = API_ERROR_KEYS[message.trim().toLowerCase()];
  return key ? t(key) : message;
}
