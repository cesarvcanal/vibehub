import { onTestFinished, vi } from "vitest";

export function useFakeAnimationFrames(): void {
  vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame", "performance"] });
  onTestFinished(() => { vi.useRealTimers(); });
}
