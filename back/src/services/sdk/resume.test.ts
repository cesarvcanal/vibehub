import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "../../config/env.js";
import type { Card, Project } from "../board/registry.js";
import type { Settings } from "../settings/settings.js";
import { ensureDriverSession, injectSystemTurn, resetSdkSessionsForTesting, setDriverSpawnerForTesting } from "./manager.js";
import { readHistory } from "./history.js";
import { writeInflightMarker, readInflightMarker } from "./inflight.js";
import {
  NOTE_AUTO_OFF,
  NOTE_NOT_AGAIN,
  NOTE_RESUMING,
  RESUME_CONTINUATION_TEXT,
  SYSTEM_ORIGIN,
  resumeInterruptedTurns,
  type ResumeDeps,
} from "./resume.js";

/**
 * THE BUG THIS FILE PINS (2x em produção, 2026-08-31): um deploy do painel reinicia o back, o
 * driver SDK morre junto NO MEIO DE UM TURNO e o card fica mudo — sem linha de aviso, sem retomada.
 * O sweep de boot transforma o marcador durável do turno em (1) uma linha de sistema visível no
 * histórico e (2) UMA retomada automática — nunca duas (loop deploy→resume→deploy→resume).
 */

const CARD = "eeee498d-98dd-44b6-97ee-c06a181c3769";

interface FakeChild extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
  stdin: { write: (s: string) => boolean; end: () => void; written: string[]; ended: boolean };
  kill: () => void;
  killed: boolean;
}

function fakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  const written: string[] = [];
  child.stdin = { written, ended: false, write: (s) => { written.push(s); return true; }, end: () => { child.stdin.ended = true; } };
  child.killed = false;
  child.kill = () => { child.killed = true; };
  return child;
}

const card = { id: CARD, projectId: "p1", worktreeSlug: "t", resumeSessionId: "11111111-2222-3333-4444-555555555555" } as unknown as Card;
const project = { id: "p1", name: "proj" } as unknown as Project;

function settingsWith(over: Partial<Settings> = {}): Settings {
  return { sdkDriver: true, sdkAutoResume: true, ...over } as Settings;
}

let dir = "";
let savedDataDir = "";
let spawned: FakeChild[] = [];
let installed = 0;

function deps(over: Partial<ResumeDeps> = {}, settings: Settings = settingsWith()): ResumeDeps {
  return {
    listMarkers: async () => {
      const marker = await readInflightMarker(CARD);
      return marker ? [{ cardId: CARD, marker }] : [];
    },
    clearMarker: async (cardId) => { const { clearInflightMarker } = await import("./inflight.js"); await clearInflightMarker(cardId); },
    getCard: async (id) => (id === CARD ? card : undefined),
    getProject: async (id) => (id === "p1" ? project : undefined),
    settings: async () => settings,
    installDriver: async () => { installed += 1; },
    commandFor: async () => ({ file: "docker", args: ["exec"] }),
    ensureSession: ensureDriverSession,
    inject: injectSystemTurn,
    appendNote: async (cardId, text) => {
      const { appendHistory } = await import("./history.js");
      await appendHistory(cardId, { type: "system_note", text, at: Date.now() });
    },
    ...over,
  };
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "vibehub-sdk-resume-"));
  savedDataDir = config.dataDir;
  config.dataDir = dir;
  spawned = [];
  installed = 0;
  setDriverSpawnerForTesting(() => {
    const child = fakeChild();
    spawned.push(child);
    return child as never;
  });
});

afterEach(async () => {
  resetSdkSessionsForTesting();
  setDriverSpawnerForTesting(null);
  config.dataDir = savedDataDir;
  await rm(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("resumeInterruptedTurns — the boot sweep", () => {
  it("no markers = nothing to do (no driver, no notes)", async () => {
    const summary = await resumeInterruptedTurns(deps());
    expect(summary).toEqual({ resumed: [], noted: [] });
    expect(spawned.length).toBe(0);
  });

  it("an orphaned turn gets the visible system line AND the automatic resume with system provenance", async () => {
    await writeInflightMarker(CARD, { startedAt: 1, preview: "trabalho longo", attempts: 0 });
    const summary = await resumeInterruptedTurns(deps());
    expect(summary.resumed).toEqual([CARD]);
    expect(installed).toBe(1);

    // The driver came back up and received the continuation as a NORMAL user turn on stdin —
    // never converted, never wrapped in a notification (the "No response requested." lesson).
    expect(spawned.length).toBe(1);
    const frames = spawned[0]!.stdin.written.map((s) => JSON.parse(s) as { type: string; text?: string });
    expect(frames).toEqual([{ type: "user", text: RESUME_CONTINUATION_TEXT }]);

    // The history shows what happened, in order: the system line, then the injected turn — the
    // latter stamped with SYSTEM provenance so it never reads as the person's own words (#48).
    await vi.waitFor(async () => {
      const history = await readHistory(CARD);
      expect(history.map((e) => e.type)).toEqual(["system_note", "user"]);
      expect((history[0] as { text: string }).text).toBe(NOTE_RESUMING);
      expect(history[1]!.from).toEqual(SYSTEM_ORIGIN);
    });

    // The resumed turn's own marker spends the one automatic attempt: a second death only notes.
    await vi.waitFor(async () => {
      expect((await readInflightMarker(CARD))?.attempts).toBe(1);
    });
  });

  it("attempts >= 1 (the interrupted turn WAS already a resume): only the line, no loop", async () => {
    await writeInflightMarker(CARD, { startedAt: 1, attempts: 1 });
    const summary = await resumeInterruptedTurns(deps());
    expect(summary).toEqual({ resumed: [], noted: [CARD] });
    expect(spawned.length).toBe(0);

    const history = await readHistory(CARD);
    expect(history.map((e) => e.type)).toEqual(["system_note"]);
    expect((history[0] as { text: string }).text).toBe(NOTE_NOT_AGAIN);
    // Marker consumed — the NEXT boot finds nothing and stays quiet.
    expect(await readInflightMarker(CARD)).toBeNull();
  });

  it("sdkAutoResume off: only the line saying so, marker consumed, no driver", async () => {
    await writeInflightMarker(CARD, { startedAt: 1, attempts: 0 });
    const summary = await resumeInterruptedTurns(deps({}, settingsWith({ sdkAutoResume: false })));
    expect(summary).toEqual({ resumed: [], noted: [CARD] });
    expect(spawned.length).toBe(0);
    const history = await readHistory(CARD);
    expect((history[0] as { text: string }).text).toBe(NOTE_AUTO_OFF);
    expect(await readInflightMarker(CARD)).toBeNull();
  });

  it("sdkDriver off entirely: same as auto-resume off (a resume would be refused anyway)", async () => {
    await writeInflightMarker(CARD, { startedAt: 1, attempts: 0 });
    const summary = await resumeInterruptedTurns(deps({}, settingsWith({ sdkDriver: false })));
    expect(summary.noted).toEqual([CARD]);
    expect(spawned.length).toBe(0);
  });

  it("a deleted card's marker is swept away silently — no one left to tell", async () => {
    await writeInflightMarker(CARD, { startedAt: 1, attempts: 0 });
    const summary = await resumeInterruptedTurns(deps({ getCard: async () => undefined }));
    expect(summary).toEqual({ resumed: [], noted: [] });
    expect(await readInflightMarker(CARD)).toBeNull();
    expect(await readHistory(CARD)).toEqual([]);
  });

  it("a card that fails does not take the sweep down (best-effort per card)", async () => {
    await writeInflightMarker(CARD, { startedAt: 1, attempts: 0 });
    const summary = await resumeInterruptedTurns(deps({ commandFor: async () => { throw new Error("runner down"); } }));
    expect(summary.resumed).toEqual([]);
    // The note went down before the failure; the marker was consumed so the next boot does not
    // re-note the same interruption forever.
    const history = await readHistory(CARD);
    expect((history[0] as { text: string }).text).toBe(NOTE_RESUMING);
    expect(await readInflightMarker(CARD)).toBeNull();
  });
});
