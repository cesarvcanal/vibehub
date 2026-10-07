import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";

afterEach(async () => {
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
  // The composer's drafts live in a MODULE map (a half-written message survives the pane
  // unmounting — that is the feature), and the module outlives the test: any file mounting the
  // composer twice with the same card id handed the second test the first one's words. After
  // `cleanup()`, because an unmount is exactly what saves a draft. Imported HERE and lazily, not at
  // the top: a setup file's static imports load before the test file's `vi.mock`s exist, so the
  // composer (and `@/lib/api` under it) would be the REAL modules for every test in the suite. By
  // now the test's mocks are registered, and a file that already loaded the composer gets back
  // the very instance it used.
  const { resetDraftsForTesting } = await import("@/features/board/components/TerminalComposer");
  resetDraftsForTesting();
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

// Radix menus/popovers drive pointer capture and scroll the active item into view — jsdom has
// neither, and without these the very act of opening a dropdown throws.
if (typeof Element !== "undefined") {
  const proto = Element.prototype as unknown as Record<string, unknown>;
  if (!proto.hasPointerCapture) proto.hasPointerCapture = () => false;
  if (!proto.setPointerCapture) proto.setPointerCapture = () => {};
  if (!proto.releasePointerCapture) proto.releasePointerCapture = () => {};
  if (!proto.scrollIntoView) proto.scrollIntoView = () => {};
}
