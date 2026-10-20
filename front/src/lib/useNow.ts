import * as React from "react";

/** `Date.now()` que se refaz a cada segundo enquanto `active` — e nenhum timer quando não. */
export function useNow(active: boolean): number {
  const [, setTick] = React.useState(0);
  React.useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setTick((n) => n + 1), 1_000);
    return () => clearInterval(timer);
  }, [active]);
  return Date.now();
}

/** A aba está à vista? Escondida, um relógio na tela não precisa andar. */
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
