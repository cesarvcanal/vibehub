import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { isEntryPoint } from "./index.js";

/**
 * The "run main() only when executed directly" guard. Comparing import.meta.url with a hand-made
 * `file://${argv[1]}` never matched on Windows (backslashes, drive letter) nor with a space in the
 * path (the URL has %20) — and then `node dist/index.js` exited silently, with no server and no
 * error. The comparison must be URL against URL.
 */
describe("isEntryPoint", () => {
  const script = join(tmpdir(), "vibe hub", "dist", "index.js");

  it("matches the module that node was asked to run — spaces and native separators included", () => {
    expect(isEntryPoint(pathToFileURL(script).href, script)).toBe(true);
  });

  it("does not match when the module was imported by something else (the tests, a tool)", () => {
    expect(isEntryPoint(pathToFileURL(script).href, join(tmpdir(), "vitest.mjs"))).toBe(false);
    expect(isEntryPoint(pathToFileURL(script).href, undefined)).toBe(false);
  });
});
