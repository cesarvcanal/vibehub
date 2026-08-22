import * as React from "react";

/**
 * Is this a phone-width viewport?
 *
 * The breakpoint is Tailwind's `md` (768px), and it is the SAME number the board's grid uses — the
 * board renders a different set of columns below it, and a layout that disagreed with its own media
 * query would show the "show more" button next to five columns.
 *
 * It reads `matchMedia` rather than `window.innerWidth` so a rotation or a resized window is a
 * subscription, not a resize listener firing sixty times a second. Environments without
 * `matchMedia` (or without a window at all) answer "not mobile", which is the desktop layout the
 * app has always had.
 */
export const MOBILE_QUERY = "(max-width: 767.98px)";

function matches(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia(MOBILE_QUERY).matches;
}

export function useIsMobile(): boolean {
  const [mobile, setMobile] = React.useState(matches);

  React.useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const list = window.matchMedia(MOBILE_QUERY);
    const onChange = () => setMobile(list.matches);
    // Re-read on mount: the first render may have happened before the media list existed (tests
    // install one, and a hydrating page can be measured late).
    onChange();
    // Safari before 14 only has the deprecated pair, and this is a tool people open on a phone.
    if (typeof list.addEventListener === "function") {
      list.addEventListener("change", onChange);
      return () => list.removeEventListener("change", onChange);
    }
    list.addListener(onChange);
    return () => list.removeListener(onChange);
  }, []);

  return mobile;
}
