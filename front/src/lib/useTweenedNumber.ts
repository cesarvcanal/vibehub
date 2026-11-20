import * as React from "react";

const prefersReducedMotion = (): boolean => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const easeOutCubic = (progress: number): number => 1 - (1 - progress) ** 3;

export function useTweenedNumber(target: number, durationMs: number, initialValue: number = target): number {
  const [shown, setShown] = React.useState(initialValue);
  const shownRef = React.useRef(initialValue);

  React.useEffect(() => {
    if (prefersReducedMotion()) {
      shownRef.current = target;
      setShown(target);
      return;
    }
    const from = shownRef.current;
    if (from === target) return;
    const startedAt = performance.now();
    const frame = { id: 0 };
    const step = (now: number): void => {
      const progress = Math.min(1, Math.max(0, (now - startedAt) / durationMs));
      const value = from + (target - from) * easeOutCubic(progress);
      shownRef.current = value;
      setShown(value);
      if (progress < 1) frame.id = requestAnimationFrame(step);
    };
    frame.id = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame.id);
  }, [target, durationMs]);

  return prefersReducedMotion() ? target : shown;
}
