import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "../../config/env.js";
import {
  PROVENANCE_DIR,
  PROVENANCE_CACHE_MAX,
  PROVENANCE_MATCH_WINDOW_MS,
  matchOrigin,
  normalizeProvenanceKey,
  pickOrigin,
  primeProvenance,
  recordOrigin,
  resetProvenanceCache,
  type MessageOrigin,
  type ProvenanceEntry,
} from "./provenance.js";

/**
 * WHAT THIS PINS: who sent a message into a card is recorded at send time and matched back to the
 * transcript's anonymous "user" lines by normalized text + nearest timestamp — best-effort by
 * design (identical texts close together can swap labels), but never inventing an attribution for
 * a text that was not recorded.
 */

const CARD = "aaaa498d1-98dd-44b6-97ee-c06a181c376";
const AGENT: MessageOrigin = { kind: "agent", name: "card preview", sourceCardId: "c1", sourceProjectId: "p1" };
const USER: MessageOrigin = { kind: "user", name: "alex" };

let dir = "";
let savedDataDir = "";

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "vibehub-provenance-"));
  savedDataDir = config.dataDir;
  config.dataDir = dir;
  resetProvenanceCache();
});
afterEach(async () => {
  config.dataDir = savedDataDir;
  resetProvenanceCache();
  await rm(dir, { recursive: true, force: true });
});

describe("normalizeProvenanceKey", () => {
  it("collapses whitespace exactly like the front's normalizeMessage", () => {
    expect(normalizeProvenanceKey("  roda\n os   testes \t")).toBe("roda os testes");
    expect(normalizeProvenanceKey("   ")).toBe("");
  });
});

describe("recordOrigin + matchOrigin", () => {
  it("records a send and matches the transcript echo by text and time", async () => {
    await recordOrigin(CARD, "roda os testes", AGENT, 1_000);
    expect(matchOrigin(CARD, "roda\nos  testes", 3_000)).toEqual(AGENT);
  });

  it("returns nothing for a text that was never recorded (no invented attribution)", async () => {
    await recordOrigin(CARD, "roda os testes", AGENT, 1_000);
    expect(matchOrigin(CARD, "outra mensagem", 1_000)).toBeUndefined();
    expect(matchOrigin(CARD, "", 1_000)).toBeUndefined();
  });

  it("persists to one ndjson per card and survives a cache reset via primeProvenance", async () => {
    await recordOrigin(CARD, "oi", USER, 500);
    const raw = await readFile(join(dir, PROVENANCE_DIR, `${CARD}.ndjson`), "utf8");
    expect(JSON.parse(raw.trim())).toEqual({ at: 500, key: "oi", origin: USER });

    resetProvenanceCache(); // a backend restart
    expect(matchOrigin(CARD, "oi", 600)).toBeUndefined();
    await primeProvenance(CARD);
    expect(matchOrigin(CARD, "oi", 600)).toEqual(USER);
  });

  it("refuses a card id that is not id-shaped (it names a file)", async () => {
    await expect(primeProvenance("../etc/passwd")).rejects.toThrow(/invalid card id/);
  });

  it("caps the in-memory tail so a chatty card cannot grow the matcher unbounded", async () => {
    for (let i = 0; i < PROVENANCE_CACHE_MAX + 5; i += 1) {
      await recordOrigin(CARD, `msg ${i}`, USER, i);
    }
    expect(matchOrigin(CARD, "msg 0", 0)).toBeUndefined(); // evicted
    expect(matchOrigin(CARD, `msg ${PROVENANCE_CACHE_MAX + 4}`, PROVENANCE_CACHE_MAX + 4)).toEqual(USER);
  });
});

describe("pickOrigin", () => {
  const entry = (at: number, origin: MessageOrigin): ProvenanceEntry => ({ at, key: "mesma frase", origin });

  it("picks the entry nearest in time when the same text was sent twice", () => {
    const entries = [entry(1_000, AGENT), entry(60_000, USER)];
    expect(pickOrigin(entries, "mesma frase", 2_000)).toEqual(AGENT);
    expect(pickOrigin(entries, "mesma frase", 59_000)).toEqual(USER);
  });

  it("rejects a match outside the window (an old send must not label a new message)", () => {
    const entries = [entry(1_000, AGENT)];
    expect(pickOrigin(entries, "mesma frase", 1_000 + PROVENANCE_MATCH_WINDOW_MS + 1)).toBeUndefined();
  });

  it("an event with no timestamp takes the newest entry for its text", () => {
    const entries = [entry(1_000, AGENT), entry(2_000, USER)];
    expect(pickOrigin(entries, "mesma frase", 0)).toEqual(USER);
  });
});
