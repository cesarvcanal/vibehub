/**
 * Theme is dark by default and follows `prefers-color-scheme` when nobody has chosen.
 * A stored choice pins `data-theme` on <html>, which beats the media query in index.css.
 */
export type ThemeChoice = "system" | "dark" | "light";

const KEY = "vibehub.theme";

export function readTheme(): ThemeChoice {
  try {
    const v = localStorage.getItem(KEY);
    return v === "dark" || v === "light" ? v : "system";
  } catch {
    return "system";
  }
}

export function applyTheme(choice: ThemeChoice): void {
  const root = document.documentElement;
  if (choice === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", choice);
  try {
    if (choice === "system") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, choice);
  } catch {
    /* private mode: the attribute still applies for this session */
  }
}

/** Cycle order for the toolbar button. */
export function nextTheme(choice: ThemeChoice): ThemeChoice {
  return choice === "system" ? "dark" : choice === "dark" ? "light" : "system";
}
