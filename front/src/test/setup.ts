import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  // The app remembers a few browsing choices (which projects are unfolded, the zoom). jsdom keeps
  // one storage for the whole file, so without this a test would inherit the previous one's.
  try {
    localStorage.clear();
    sessionStorage.clear();
  } catch {
    /* a test that stubbed storage into throwing — nothing to clear anyway */
  }
});

// jsdom ships neither of these and Radix/sonner reach for them on mount.
if (!window.matchMedia) {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

if (!window.ResizeObserver) {
  window.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}
