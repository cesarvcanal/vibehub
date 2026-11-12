import * as React from "react";

/** `Date.now()` that refreshes every second while `active` — and no timer when not. */
export function useNow(active: boolean): number {
  const [, setTick] = React.useState(0);
  React.useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setTick((n) => n + 1), 1_000);
    return () => clearInterval(timer);
  }, [active]);
  return Date.now();
}

/** Is the tab in view? When hidden, an on-screen clock does not need to tick. */
export function usePageVisible(): boolean {
  const read = (): boolean => typeof document === "undefined" || document.visibilityState !== "hidden";
  const [visible, setVisible] = React.useState(read);
  React.useEffect(() => {
    const onChange = (): void => setVisible(read());
    document.addEventListener("visibilitychange", onChange);
    return () => document.removeEventListener("visibilitychange", onChange);
  }, []);
  return visible;
}
