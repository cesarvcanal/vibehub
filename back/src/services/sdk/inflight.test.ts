import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "../../config/env.js";
import {
  SDK_INFLIGHT_DIR,
  INFLIGHT_PREVIEW_MAX,
  clearInflightMarker,
  inflightPreview,
  listInflightMarkers,
  parseMarker,
  readInflightMarker,
  writeInflightMarker,
} from "./inflight.js";

/**
 * The durable "turn in flight" record: written when a user turn enters the driver, removed when the
 * driver's result closes it — so a marker still on disk AT BOOT is the proof a restart interrupted
 * a turn. These tests pin the disk contract the boot sweep (resume.ts) depends on.
 */

const CARD = "aaaa498d-98dd-44b6-97ee-c06a181c3769";

let dir = "";
let savedDataDir = "";

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "vibehub-sdk-inflight-"));
  savedDataDir = config.dataDir;
  config.dataDir = dir;
});

afterEach(async () => {
  config.dataDir = savedDataDir;
  await rm(dir, { recursive: true, force: true });
});

describe("inflight markers", () => {
  it("writes, reads back and clears one card's marker", async () => {
    await writeInflightMarker(CARD, { startedAt: 123, preview: "roda os testes", attempts: 0 });
    expect(await readInflightMarker(CARD)).toEqual({ startedAt: 123, preview: "roda os testes", attempts: 0 });

    await clearInflightMarker(CARD);
    expect(await readInflightMarker(CARD)).toBeNull();
    // Clearing again is idempotent — a double result must not throw.
    await clearInflightMarker(CARD);
  });

  it("survives what a restart survives: the file is on disk, plain JSON", async () => {
    await writeInflightMarker(CARD, { startedAt: 5, attempts: 1 });
    const raw = await readFile(join(dir, SDK_INFLIGHT_DIR, `${CARD}.json`), "utf8");
    expect(JSON.parse(raw)).toEqual({ startedAt: 5, attempts: 1 });
  });

  it("lists every marker on disk — the boot sweep's input", async () => {
    const card2 = "bbbb498d-98dd-44b6-97ee-c06a181c3769";
    await writeInflightMarker(CARD, { startedAt: 1, attempts: 0 });
    await writeInflightMarker(card2, { startedAt: 2, attempts: 1 });
    const listed = await listInflightMarkers();
    expect(listed.map((m) => m.cardId).sort()).toEqual([CARD, card2]);
  });

  it("an empty or missing dir is simply no orphans", async () => {
    expect(await listInflightMarkers()).toEqual([]);
  });

  it("cleans up torn/foreign files instead of treating them as turns", async () => {
    await mkdir(join(dir, SDK_INFLIGHT_DIR), { recursive: true });
    await writeFile(join(dir, SDK_INFLIGHT_DIR, `${CARD}.json`), "{torn", "utf8");
    expect(await listInflightMarkers()).toEqual([]);
    expect(await readInflightMarker(CARD)).toBeNull();
  });

  it("refuses a card id that is not id-shaped — nothing path-like ever touches the fs", async () => {
    // Reads degrade to "no marker" and writes to a logged no-op: the guard throws before any fs
    // call, and every caller is fire-and-forget by design.
    expect(await readInflightMarker("../../etc/passwd")).toBeNull();
    await writeInflightMarker("../../etc/passwd", { startedAt: 1, attempts: 0 });
    expect(await listInflightMarkers()).toEqual([]);
  });

  it("parseMarker validates shape and defaults attempts", () => {
    expect(parseMarker(JSON.stringify({ startedAt: 9 }))).toEqual({ startedAt: 9, preview: undefined, attempts: 0 });
    expect(parseMarker(JSON.stringify({ startedAt: 9, attempts: 2, preview: "x" }))).toEqual({ startedAt: 9, attempts: 2, preview: "x" });
    expect(parseMarker(JSON.stringify({ attempts: 2 }))).toBeNull(); // no startedAt = not a marker
    expect(parseMarker("null")).toBeNull();
    expect(parseMarker("not json")).toBeNull();
  });

  it("inflightPreview flattens whitespace and caps the length", () => {
    expect(inflightPreview("  faz\n o   deploy ")).toBe("faz o deploy");
    const long = "x".repeat(INFLIGHT_PREVIEW_MAX * 2);
    expect(inflightPreview(long).length).toBe(INFLIGHT_PREVIEW_MAX);
    expect(inflightPreview(long).endsWith("…")).toBe(true);
  });
});
