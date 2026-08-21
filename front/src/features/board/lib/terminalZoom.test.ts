import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  clampFontSize, nextFontSize, applyZoom, zoomActionFromKey, readTerminalFontSize,
  writeTerminalFontSize, writeClipboard,
  TERMINAL_FONT_MIN, TERMINAL_FONT_MAX, TERMINAL_FONT_DEFAULT, TERMINAL_FONT_SIZE_KEY,
} from "./terminalZoom";

describe("clampFontSize", () => {
  it("keeps a size inside the readable range", () => {
    expect(clampFontSize(14)).toBe(14);
    expect(clampFontSize(2)).toBe(TERMINAL_FONT_MIN);
    expect(clampFontSize(99)).toBe(TERMINAL_FONT_MAX);
  });
  it("rounds and refuses nonsense", () => {
    expect(clampFontSize(13.6)).toBe(14);
    expect(clampFontSize(Number.NaN)).toBe(TERMINAL_FONT_MIN);
    expect(clampFontSize(Number.POSITIVE_INFINITY)).toBe(TERMINAL_FONT_MIN);
  });
});

describe("nextFontSize", () => {
  it("steps one notch and stops at the edges", () => {
    expect(nextFontSize(13, 1)).toBe(14);
    expect(nextFontSize(13, -1)).toBe(12);
    expect(nextFontSize(TERMINAL_FONT_MAX, 1)).toBe(TERMINAL_FONT_MAX);
    expect(nextFontSize(TERMINAL_FONT_MIN, -1)).toBe(TERMINAL_FONT_MIN);
  });
});

describe("zoomActionFromKey", () => {
  const key = (init: Partial<KeyboardEventInit> & { key: string }, type = "keydown") =>
    new KeyboardEvent(type, { ...init });

  it("reads the three zoom shortcuts on both platforms", () => {
    expect(zoomActionFromKey(key({ key: "+", metaKey: true }))).toBe("in");
    expect(zoomActionFromKey(key({ key: "=", ctrlKey: true }))).toBe("in");
    expect(zoomActionFromKey(key({ key: "-", metaKey: true }))).toBe("out");
    expect(zoomActionFromKey(key({ key: "_", ctrlKey: true }))).toBe("out");
    expect(zoomActionFromKey(key({ key: "0", metaKey: true }))).toBe("reset");
  });

  it("ignores a bare key, an Alt combo, and keyup", () => {
    expect(zoomActionFromKey(key({ key: "+" }))).toBeNull();
    expect(zoomActionFromKey(key({ key: "+", metaKey: true, altKey: true }))).toBeNull();
    expect(zoomActionFromKey(key({ key: "+", metaKey: true }, "keyup"))).toBeNull();
  });

  it("leaves ordinary typing alone", () => {
    expect(zoomActionFromKey(key({ key: "a", metaKey: true }))).toBeNull();
    expect(zoomActionFromKey(key({ key: "c", metaKey: true }))).toBeNull();
  });
});

describe("applyZoom", () => {
  it("steps in and out, and reset goes back to the default", () => {
    expect(applyZoom(13, "in")).toBe(14);
    expect(applyZoom(13, "out")).toBe(12);
    expect(applyZoom(19, "reset")).toBe(TERMINAL_FONT_DEFAULT);
  });
});

describe("persistence", () => {
  beforeEach(() => localStorage.clear());

  it("round-trips through localStorage", () => {
    writeTerminalFontSize(16);
    expect(readTerminalFontSize()).toBe(16);
    expect(localStorage.getItem(TERMINAL_FONT_SIZE_KEY)).toBe("16");
  });

  it("falls back when nothing is stored or the value is junk", () => {
    expect(readTerminalFontSize(13)).toBe(13);
    localStorage.setItem(TERMINAL_FONT_SIZE_KEY, "not-a-number");
    expect(readTerminalFontSize(13)).toBe(13);
  });

  it("clamps a stored value that is out of range", () => {
    localStorage.setItem(TERMINAL_FONT_SIZE_KEY, "999");
    expect(readTerminalFontSize()).toBe(TERMINAL_FONT_MAX);
  });

  it("survives storage being unavailable — the zoom just does not persist", () => {
    const getItem = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(readTerminalFontSize(13)).toBe(13);
    expect(() => writeTerminalFontSize(15)).not.toThrow();
    getItem.mockRestore();
    setItem.mockRestore();
  });
});

describe("writeClipboard", () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => { warn = vi.spyOn(console, "warn").mockImplementation(() => undefined); });
  afterEach(() => warn.mockRestore());

  it("uses the modern API on the happy path and never touches the fallback", async () => {
    const write = vi.fn(async () => undefined);
    const fallback = vi.fn(() => true);
    writeClipboard("hello", write, fallback);
    await Promise.resolve();
    expect(write).toHaveBeenCalledWith("hello");
    expect(fallback).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it("falls back when the API rejects — an http LAN install must still copy", async () => {
    const write = vi.fn(async () => { throw new Error("not allowed"); });
    const fallback = vi.fn(() => true);
    writeClipboard("hello", write, fallback);
    await Promise.resolve();
    await Promise.resolve();
    expect(fallback).toHaveBeenCalledWith("hello");
    expect(warn).not.toHaveBeenCalled();
  });

  it("falls back when the API throws synchronously (no navigator.clipboard at all)", () => {
    const write = vi.fn(() => { throw new Error("undefined is not a function"); });
    const fallback = vi.fn(() => true);
    writeClipboard("hello", write as unknown as (t: string) => Promise<void>, fallback);
    expect(fallback).toHaveBeenCalled();
  });

  it("warns with both reasons when neither path copies — silence was the original bug", async () => {
    const write = vi.fn(async () => { throw new Error("insecure context"); });
    writeClipboard("hello", write, () => false);
    await Promise.resolve();
    await Promise.resolve();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("clipboard"), expect.anything());
  });

  it("warns when the fallback itself throws", async () => {
    const write = vi.fn(async () => { throw new Error("insecure context"); });
    writeClipboard("hello", write, () => { throw new Error("no document"); });
    await Promise.resolve();
    await Promise.resolve();
    expect(warn).toHaveBeenCalled();
  });
});
