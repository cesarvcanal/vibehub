import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "../../config/env.js";
import type { Card, Project } from "../board/registry.js";
import type { Settings } from "../settings/settings.js";
import { BACKGROUND_HOLD_MAX_MS, SYSTEM_ORIGIN, attachSocket, ensureDriverSession, injectSystemTurn, resetSdkSessionsForTesting, setDriverSpawnerForTesting } from "./manager.js";
import { readHistory } from "./history.js";
import {
  INFLIGHT_OWNER,
  SDK_INFLIGHT_DIR,
  isInflightOwnerAlive,
  readInflightMarker,
  touchInflightOwner,
  writeInflightMarker,
} from "./inflight.js";
import {
  CRASH_RESUME_DELAY_MS,
  CRASH_TEXTS,
  MAX_AUTO_RESUMES,
  SETTLED_RESUME_MS,
  NOTE_AUTO_OFF,
  NOTE_AWAITING_ANSWER,
  NOTE_BACKGROUND_STALE,
  NOTE_NOT_AGAIN,
  NOTE_RESUMING,
  NOTE_RESUME_FAILED,
  RESUME_CONTINUATION_TEXT,
  awaitingAnswerInHistory,
  handOffSdkOnShutdown,
  isStaleBackgroundOnly,
  nextResumeAttempt,
  openQuestionIds,
  resumeAfterDriverCrash,
  resumeContinuationText,
  resumeInterruptedTurns,
  type ResumeDeps,
} from "./resume.js";

/**
 * THE BUG THIS FILE PINS (2x in production, 2026-08-31): a panel deploy restarts the back, the
 * SDK driver dies with it IN THE MIDDLE OF A TURN and the card goes silent — no warning line, no resume.
 * The boot sweep turns the turn's durable marker into (1) a visible system line in the
 * history and (2) ONE automatic resume — never two (deploy→resume→deploy→resume loop).
 */

const CARD = "eeee498d-98dd-44b6-97ee-c06a181c3769";
/** The old and the new process of a blue/green deploy — ids in the format the back generates. */
const ANTIGO = "0a1b2c3d-0000-4000-8000-00000000a171";
const NOVO = "0a1b2c3d-0000-4000-8000-0000000000e0";

interface FakeChild extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
  stdin: EventEmitter & { write: (s: string) => boolean; end: () => void; written: string[]; ended: boolean; writable: boolean };
  kill: () => void;
  killed: boolean;
}

function fakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  const written: string[] = [];
  const stdin = new EventEmitter() as FakeChild["stdin"];
  stdin.written = written;
  stdin.ended = false;
  stdin.writable = true;
  stdin.write = (s: string) => { written.push(s); return true; };
  stdin.end = () => { stdin.ended = true; stdin.writable = false; };
  child.stdin = stdin;
  child.killed = false;
  child.kill = () => { child.killed = true; };
  return child;
}

const card = { id: CARD, projectId: "p1", worktreeSlug: "t", openedAt: 1, resumeSessionId: "11111111-2222-3333-4444-555555555555" } as unknown as Card;
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
    restoreWorkspace: async () => false,
    commandFor: async () => ({ file: "docker", args: ["exec"] }),
    ensureSession: ensureDriverSession,
    inject: injectSystemTurn,
    readMarker: readInflightMarker,
    // The markers the tests write are signed by THIS process (INFLIGHT_OWNER), which
    // does not beat: it is a deploy's old process, already dead. The sweep under test plays the NEW one.
    selfOwner: NOVO,
    ownerAlive: isInflightOwnerAlive,
    turnRunning: () => false,
    stopping: () => false,
    reportIdle: () => undefined,
    awaitingAnswer: awaitingAnswerInHistory,
    markAwaitingDecision: async () => undefined,
    wait: async () => undefined,
    appendNote: async (cardId, text, extra) => {
      const { appendHistory } = await import("./history.js");
      await appendHistory(cardId, { type: "system_note", text, ...(extra?.lostBackground ? { lostBackground: extra.lostBackground } : {}), at: Date.now() });
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

  it("O CASO REAL (2026-10-19): turno com segundo plano morto pelo deploy é retomado, e o agente sabe o que morreu", async () => {
    await writeInflightMarker(CARD, {
      startedAt: 1, preview: "(turno aberto pelo próprio Claude: retorno de tarefa em segundo plano ou agendada)", attempts: 0,
      background: { tasks: ["suíte do front", "retorno agendado (ScheduleWakeup): esperar o CI"], since: Date.now() - 60_000, idle: true },
    });
    const summary = await resumeInterruptedTurns(deps());
    expect(summary.resumed).toEqual([CARD]);
    const frames = spawned[0]!.stdin.written.map((s) => JSON.parse(s) as { type: string; text: string });
    expect(frames).toHaveLength(1);
    expect(frames[0]!.text.startsWith(RESUME_CONTINUATION_TEXT)).toBe(true);
    expect(frames[0]!.text).toContain("- suíte do front");
    expect(frames[0]!.text).toContain("- retorno agendado (ScheduleWakeup): esperar o CI");
    await vi.waitFor(async () => expect((await readInflightMarker(CARD))?.attempts).toBe(1));
  });

  it("segundo plano SOZINHO há mais que o teto (um dev server): só a nota, sem acordar o agente", async () => {
    await writeInflightMarker(CARD, {
      startedAt: 1, attempts: 0,
      background: { tasks: ["npm run dev"], since: Date.now() - BACKGROUND_HOLD_MAX_MS - 1, idle: true },
    });
    const summary = await resumeInterruptedTurns(deps());
    expect(summary).toEqual({ resumed: [], noted: [CARD] });
    expect(spawned).toHaveLength(0);
    const history = await readHistory(CARD);
    expect(history.map((e) => (e as { text?: string }).text)).toEqual([NOTE_BACKGROUND_STALE]);
    expect(await readInflightMarker(CARD)).toBeNull();
  });

  it("segundo plano antigo MAS com um turno rodando: é trabalho em andamento, retoma", async () => {
    await writeInflightMarker(CARD, {
      startedAt: 1, attempts: 0,
      background: { tasks: ["npm run dev"], since: Date.now() - BACKGROUND_HOLD_MAX_MS - 1, idle: false },
    });
    expect((await resumeInterruptedTurns(deps())).resumed).toEqual([CARD]);
  });

  it("o teto de retomadas vale também para o segundo plano: sem progresso, não acorda de novo", async () => {
    await writeInflightMarker(CARD, { startedAt: 1, attempts: 1, background: { tasks: ["x"], since: Date.now(), idle: true } });
    const summary = await resumeInterruptedTurns(deps());
    expect(summary.noted).toEqual([CARD]);
    expect(spawned).toHaveLength(0);
  });

  it("resumeContinuationText / isStaleBackgroundOnly — puras", () => {
    expect(resumeContinuationText({ startedAt: 1, attempts: 0 })).toBe(RESUME_CONTINUATION_TEXT);
    const many = Array.from({ length: 12 }, (_, i) => `t${i}`);
    const text = resumeContinuationText({ startedAt: 1, attempts: 0, background: { tasks: many, since: 0, idle: true } });
    expect(text).toContain("- t7");
    expect(text).not.toContain("- t8"); // the list is short: context, not an inventory
    // Real case (this card, 2026-11-10): the resume quoted a command with "ULTRATHINK" and the turn went up to max.
    const cited = resumeContinuationText({ startedAt: 1, attempts: 0, background: { tasks: ["vitest -t ULTRATHINK"], since: 0, idle: false } });
    expect(cited).toContain("- vitest -t ULTRA-THINK");
    expect(cited).not.toMatch(/ultrathink/i);
    const now = 10 * BACKGROUND_HOLD_MAX_MS;
    expect(isStaleBackgroundOnly({ startedAt: 1, attempts: 0 }, now)).toBe(false);
    expect(isStaleBackgroundOnly({ startedAt: 1, attempts: 0, background: { tasks: ["x"], since: now - BACKGROUND_HOLD_MAX_MS, idle: true } }, now)).toBe(false);
    expect(isStaleBackgroundOnly({ startedAt: 1, attempts: 0, background: { tasks: ["x"], since: now - BACKGROUND_HOLD_MAX_MS - 1, idle: true } }, now)).toBe(true);
  });

  it("attempts >= 1 SEM progresso (a retomada morreu antes de fazer qualquer coisa): only the line, no loop", async () => {
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

  it("o turno retomado AVANÇOU e morreu em outro deploy: retoma de novo — o trabalho não fica pela metade", async () => {
    await writeInflightMarker(CARD, { startedAt: Date.now(), attempts: 1, progressed: true });
    const summary = await resumeInterruptedTurns(deps());
    expect(summary.resumed).toEqual([CARD]);
    expect(spawned.length).toBe(1);
    // The new resume is born WITHOUT progress: if it dies before doing anything, the next one only takes note.
    await vi.waitFor(async () => {
      const marker = await readInflightMarker(CARD);
      expect(marker?.attempts).toBe(2);
      expect(marker?.progressed).toBeUndefined();
    });
  });

  it("o turno retomado só ganha 'avançou' quando a IA produz algo — texto ou ferramenta", async () => {
    await writeInflightMarker(CARD, { startedAt: 1, attempts: 0 });
    await resumeInterruptedTurns(deps());
    await vi.waitFor(async () => { expect((await readInflightMarker(CARD))?.attempts).toBe(1); });
    const out = spawned[0]!.stdout;
    out.emit("data", Buffer.from(JSON.stringify({ type: "ready" }) + "\n"));
    out.emit("data", Buffer.from(JSON.stringify({ type: "session", sessionId: "11111111-2222-3333-4444-555555555555" }) + "\n"));
    await new Promise((r) => setTimeout(r, 20));
    expect((await readInflightMarker(CARD))?.progressed).toBeUndefined();
    out.emit("data", Buffer.from(JSON.stringify({ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }) + "\n"));
    await vi.waitFor(async () => {
      const marker = await readInflightMarker(CARD);
      expect(marker?.progressed).toBe(true);
      expect(marker?.attempts).toBe(1);
    });
  });

  it("o teto de retomadas seguidas para mesmo com progresso — um turno que derruba o próprio painel não vira loop", async () => {
    // Each round dies right after advancing: it is the panel going down because of the turn itself, not long work.
    await writeInflightMarker(CARD, { startedAt: Date.now(), attempts: MAX_AUTO_RESUMES, progressed: true });
    const summary = await resumeInterruptedTurns(deps());
    expect(summary).toEqual({ resumed: [], noted: [CARD] });
    expect(spawned.length).toBe(0);
    const history = await readHistory(CARD);
    expect((history[0] as { text: string }).text).toBe(NOTE_NOT_AGAIN);
  });

  it("O CASO REAL (2026-11-10): dia de muitos deploys — a retomada que trabalhou por minutos não gasta o teto", async () => {
    // troca-de-effort-f121: a deploy every ~5 min, the 5th resume (progressed: true) stopped the card midway.
    await writeInflightMarker(CARD, { startedAt: Date.now() - SETTLED_RESUME_MS - 1_000, attempts: MAX_AUTO_RESUMES, progressed: true });
    const summary = await resumeInterruptedTurns(deps());
    expect(summary.resumed).toEqual([CARD]);
    expect(spawned.length).toBe(1);
    // The chain restarts: the new resume still needs to advance, and the cap counts from it again.
    await vi.waitFor(async () => {
      const marker = await readInflightMarker(CARD);
      expect(marker?.attempts).toBe(1);
      expect(marker?.progressed).toBeUndefined();
    });
  });

  it("trabalhou por minutos mas SEM avançar: continua sendo o loop, só a linha", async () => {
    await writeInflightMarker(CARD, { startedAt: Date.now() - SETTLED_RESUME_MS - 1_000, attempts: 2 });
    const summary = await resumeInterruptedTurns(deps());
    expect(summary).toEqual({ resumed: [], noted: [CARD] });
    expect(spawned.length).toBe(0);
  });

  it("nextResumeAttempt — pura: o número da próxima retomada, ou null", () => {
    const now = 10 * SETTLED_RESUME_MS;
    const fresh = now - 1_000;
    const settled = now - SETTLED_RESUME_MS;
    expect(nextResumeAttempt({ startedAt: fresh, attempts: 0 }, now)).toBe(1);
    expect(nextResumeAttempt({ startedAt: fresh, attempts: 1 }, now)).toBeNull();
    expect(nextResumeAttempt({ startedAt: settled, attempts: 1 }, now)).toBeNull();
    expect(nextResumeAttempt({ startedAt: fresh, attempts: 1, progressed: true }, now)).toBe(2);
    expect(nextResumeAttempt({ startedAt: fresh, attempts: MAX_AUTO_RESUMES - 1, progressed: true }, now)).toBe(MAX_AUTO_RESUMES);
    expect(nextResumeAttempt({ startedAt: fresh, attempts: MAX_AUTO_RESUMES, progressed: true }, now)).toBeNull();
    expect(nextResumeAttempt({ startedAt: settled, attempts: MAX_AUTO_RESUMES, progressed: true }, now)).toBe(1);
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

  it("alguém escreveu NESTE processo enquanto o sweep preparava a retomada: nada é injetado", async () => {
    await writeInflightMarker(CARD, { startedAt: 1, attempts: 0 });
    const summary = await resumeInterruptedTurns(deps({
      restoreWorkspace: async () => {
        await writeInflightMarker(CARD, { startedAt: 7, preview: "mensagem nova", attempts: 0 });
        return false;
      },
    }));
    expect(summary.resumed).toEqual([]);
    expect(spawned.length).toBe(0);
    expect(await readInflightMarker(CARD)).toMatchObject({ startedAt: 7 });
  });

  it("a card that fails does not take the sweep down (best-effort per card)", async () => {
    await writeInflightMarker(CARD, { startedAt: 1, attempts: 0 });
    const summary = await resumeInterruptedTurns(deps({ commandFor: async () => { throw new Error("runner down"); } }));
    expect(summary.resumed).toEqual([]);
    // The note went down before the failure; the marker was consumed so the next boot does not
    // re-note the same interruption forever.
    const history = await readHistory(CARD);
    expect((history[0] as { text: string }).text).toBe(NOTE_RESUMING);
    // …and the card does not keep saying "retomando…" forever: the next line says it did not work.
    expect(history.map((e) => (e as { text?: string }).text)).toEqual([NOTE_RESUMING, NOTE_RESUME_FAILED]);
    expect(await readInflightMarker(CARD)).toBeNull();
  });
});

/**
 * THE DEPLOY WITH THE CARD UP (production, 2026-11-03): the agent asked four questions, the person ticked
 * the options, and a deploy killed the driver midway. The resume sent "Continue de onde parou" — which
 * closed the card as "Você respondeu por mensagem" — and the agent asked AGAIN, on a new,
 * blank card: everything that had been ticked was lost. A turn stopped on a question has nothing to
 * resume: it waits for the person. The card stays open and the click goes to the model as a message (the
 * orphan's answer, see manager.ts).
 */
const QUESTIONS = [
  { question: "Como marcamos o trucado?", header: "Trucado", options: [{ label: "Tipo no cadastro" }, { label: "Faixa de capacidade" }] },
];

async function historyWith(events: Array<Record<string, unknown>>): Promise<void> {
  const { appendHistory } = await import("./history.js");
  for (const event of events) await appendHistory(CARD, event as never);
}

describe("resumeInterruptedTurns — o turno parado numa pergunta", () => {
  it("O CASO REAL: o cartão esperando resposta fica aberto — nada de retomada nem de pergunta refeita", async () => {
    const idle: string[] = [];
    const awaiting: string[] = [];
    await historyWith([
      { type: "user", text: "vamos fechar o trucado", at: 5 },
      { type: "user_question", id: "q_1_1", questions: QUESTIONS, at: 10 },
    ]);
    await writeInflightMarker(CARD, { startedAt: 5, preview: "vamos fechar o trucado", attempts: 0 });
    const summary = await resumeInterruptedTurns(deps({ reportIdle: (id) => idle.push(id), markAwaitingDecision: async (id) => { awaiting.push(id); } }));
    expect(summary).toEqual({ resumed: [], noted: [CARD] });
    expect(spawned).toHaveLength(0);
    expect(installed).toBe(0);
    expect(awaiting).toEqual([CARD]); // review #222, f1: the card lights up "precisa de você"
    const history = await readHistory(CARD);
    // the card stays pending: no question_result closed it
    expect(history.some((e) => e.type === "question_result")).toBe(false);
    expect((history.at(-1) as { text?: string }).text).toBe(NOTE_AWAITING_ANSWER);
    expect(await readInflightMarker(CARD)).toBeNull();
    expect(idle).toEqual([CARD]); // the dot goes to waiting: it is the person's turn
  });

  it("vale também para um turno que já era retomada — esperar a pessoa não é loop", async () => {
    await historyWith([{ type: "user_question", id: "q_1_1", questions: QUESTIONS, at: 10 }]);
    await writeInflightMarker(CARD, { startedAt: 5, attempts: 2, progressed: true });
    const summary = await resumeInterruptedTurns(deps());
    expect(summary.noted).toEqual([CARD]);
    expect((await readHistory(CARD)).map((e) => (e as { text?: string }).text).at(-1)).toBe(NOTE_AWAITING_ANSWER);
  });

  it("a pergunta JÁ tinha resposta quando o deploy chegou: retoma como sempre", async () => {
    await historyWith([
      { type: "user_question", id: "q_1_1", questions: QUESTIONS, at: 10 },
      { type: "question_result", id: "q_1_1", answers: [{ selected: ["Tipo no cadastro"] }], at: 11 },
    ]);
    await writeInflightMarker(CARD, { startedAt: 5, attempts: 0 });
    const summary = await resumeInterruptedTurns(deps());
    expect(summary.resumed).toEqual([CARD]);
  });

  it("uma pergunta aberta de ANTES deste turno não segura a retomada", async () => {
    await historyWith([{ type: "user_question", id: "q_1_1", questions: QUESTIONS, at: 3 }]);
    await writeInflightMarker(CARD, { startedAt: 5, attempts: 0 });
    const summary = await resumeInterruptedTurns(deps());
    expect(summary.resumed).toEqual([CARD]);
  });

  it("com segundo plano morto junto, o cartão também fica aberto — e a nota guarda o que morreu", async () => {
    await historyWith([{ type: "user_question", id: "q_1_1", questions: QUESTIONS, at: 10 }]);
    await writeInflightMarker(CARD, { startedAt: 5, attempts: 0, background: { tasks: ["suíte do back"], since: Date.now(), idle: false } });
    const summary = await resumeInterruptedTurns(deps());
    expect(summary.noted).toEqual([CARD]);
    expect(spawned).toHaveLength(0);
    const note = (await readHistory(CARD)).at(-1) as { text?: string; lostBackground?: string[] };
    expect(note.text).toBe(NOTE_AWAITING_ANSWER);
    expect(note.lostBackground).toEqual(["suíte do back"]);
  });

  it("subagentes em paralelo que morreram com o reinício vão na nota (revisão #222, f2)", async () => {
    await historyWith([
      { type: "tool_use", id: "t_agent", name: "Agent", input: { description: "auditar o estoque" }, at: 6 },
      { type: "tool_use", id: "t_done", name: "Task", input: { description: "já voltou" }, at: 7 },
      { type: "tool_result", id: "t_done", toolResult: { lines: 1 }, at: 8 },
      { type: "user_question", id: "q_1_1", questions: QUESTIONS, at: 10 },
    ]);
    await writeInflightMarker(CARD, { startedAt: 5, attempts: 0 });
    await resumeInterruptedTurns(deps());
    const note = (await readHistory(CARD)).at(-1) as { lostBackground?: string[] };
    expect(note.lostBackground).toEqual(["subagente: auditar o estoque"]);
  });

  it("openQuestionIds — pura: aberta desde o início do turno, sem resultado", () => {
    expect(openQuestionIds([
      { type: "user_question", id: "q_old", at: 1 },
      { type: "user_question", id: "q_a", at: 10 },
      { type: "user_question", id: "q_b", at: 11 },
      { type: "question_result", id: "q_a", at: 12 },
      { type: "user_question", id: "q_sem_hora" },
    ], 5)).toEqual(["q_b"]);
  });

  it("o histórico ilegível não trava a retomada: na dúvida, retoma como sempre", async () => {
    await writeInflightMarker(CARD, { startedAt: 5, attempts: 0 });
    const summary = await resumeInterruptedTurns(deps({ awaitingAnswer: async () => { throw new Error("EBUSY"); } }));
    expect(summary.resumed).toEqual([CARD]);
  });

  it("depois da nota, o clique no cartão chega ao modelo como a resposta da órfã — com o segundo plano que morreu", async () => {
    await historyWith([{ type: "user_question", id: "q_1_1", questions: QUESTIONS, at: 10 }]);
    await writeInflightMarker(CARD, { startedAt: 5, attempts: 0, background: { tasks: ["suíte do back"], since: Date.now(), idle: false } });
    await resumeInterruptedTurns(deps());
    const session = ensureDriverSession({ cardId: CARD, label: "t", command: { file: "docker", args: ["exec"] } });
    const socket = Object.assign(new EventEmitter(), { readyState: 1, send: () => undefined, close: () => undefined });
    attachSocket(session, socket as never, { kind: "user", name: "cesar" });
    socket.emit("message", Buffer.from(JSON.stringify({ type: "question_answer", id: "q_1_1", answers: [{ selected: ["Faixa de capacidade"] }] })));
    await vi.waitFor(() => {
      const frames = spawned[0]!.stdin.written.map((w) => JSON.parse(w) as { type: string; text?: string });
      const answer = frames.find((f) => f.type === "user")?.text ?? "";
      expect(answer).toContain("Faixa de capacidade");
      expect(answer).toContain("- suíte do back");
    });
  });
});

/** A marker written by ANOTHER back process (a blue/green's old container). */
async function markerFrom(owner: string, cardId = CARD): Promise<void> {
  await mkdir(join(dir, SDK_INFLIGHT_DIR), { recursive: true });
  await writeFile(join(dir, SDK_INFLIGHT_DIR, `${cardId}.json`), JSON.stringify({ startedAt: 1, preview: "jest longo", attempts: 0, owner }), "utf8");
}

/** The heartbeat the `owner` process keeps while it lives — `null` = it died (SIGKILL). */
async function heartbeat(owner: string, alive: boolean): Promise<void> {
  const file = join(dir, SDK_INFLIGHT_DIR, "owners", owner);
  if (!alive) { await rm(file, { force: true }); return; }
  await mkdir(join(file, ".."), { recursive: true });
  await writeFile(file, String(Date.now()), "utf8");
}

/**
 * THE SCREENSHOT BUG (production, 2026-10-08): "Continue de onde parou" showed up as `Sistema (vibehub)`
 * and again as a bubble, after "Atividade no terminal". The tech.multi deploy is BLUE/GREEN: the
 * new container comes up and turns healthy with the OLD one still up, running the turn. The new one's sweep
 * saw the marker, concluded "interrupted" and resumed a LIVE turn — and the old back's mirror, which
 * did not know that speech, recorded the line the CLI wrote as terminal conversation.
 *
 * A marker is only orphaned when the process that wrote it is no longer alive.
 */
describe("resumeInterruptedTurns — o turno ainda vivo na instância antiga (deploy blue/green)", () => {
  it("espera o dono morrer: nada de nota nem de retomada enquanto ele bate, e retoma UMA vez depois", async () => {
    await markerFrom(ANTIGO);
    await heartbeat(ANTIGO, true);
    let esperas = 0;
    const summary = await resumeInterruptedTurns(deps({
      wait: async () => {
        // While the old one beats, the card got nothing: neither the note nor the new driver.
        expect(await readHistory(CARD)).toEqual([]);
        expect(spawned.length).toBe(0);
        esperas += 1;
        if (esperas === 2) await heartbeat(ANTIGO, false); // tech.multi's `docker rm -f`
      },
    }));

    expect(esperas).toBe(2);
    expect(summary.resumed).toEqual([CARD]);
    expect(spawned.length).toBe(1);
    await vi.waitFor(async () => {
      expect((await readHistory(CARD)).map((e) => e.type)).toEqual(["system_note", "user"]);
    });
  });

  it("o turno TERMINOU lá enquanto o novo esperava: nada a retomar, nada a anotar", async () => {
    await markerFrom(ANTIGO);
    await heartbeat(ANTIGO, true);
    const { clearInflightMarker } = await import("./inflight.js");
    const summary = await resumeInterruptedTurns(deps({
      // The turn's `result` arrives at the old back, which deletes the marker — the sweep re-reads and sees it is over.
      wait: async () => { await clearInflightMarker(CARD); },
    }));

    expect(summary).toEqual({ resumed: [], noted: [] });
    expect(spawned.length).toBe(0);
    expect(await readHistory(CARD)).toEqual([]);
  });

  it("o marcador passou a ser DESTE processo (alguém mandou mensagem no novo): não é órfão, fica onde está", async () => {
    await markerFrom(NOVO);
    const summary = await resumeInterruptedTurns(deps());

    expect(summary).toEqual({ resumed: [], noted: [] });
    expect(spawned.length).toBe(0);
    expect(await readInflightMarker(CARD)).not.toBeNull();
  });

  it("marcador sem dono (escrito pela versão anterior): órfão na hora, como sempre foi", async () => {
    await mkdir(join(dir, SDK_INFLIGHT_DIR), { recursive: true });
    await writeFile(join(dir, SDK_INFLIGHT_DIR, `${CARD}.json`), JSON.stringify({ startedAt: 1, attempts: 0 }), "utf8");
    let esperas = 0;
    const summary = await resumeInterruptedTurns(deps({ wait: async () => { esperas += 1; } }));

    expect(esperas).toBe(0);
    expect(summary.resumed).toEqual([CARD]);
  });

  it("o turno vivo de um card não segura a retomada de outro", async () => {
    const OUTRO = "ffff498d-98dd-44b6-97ee-c06a181c3769";
    await markerFrom(ANTIGO);
    await heartbeat(ANTIGO, true);
    await writeInflightMarker(OUTRO, { startedAt: 1, attempts: 0 }); // dead owner: orphaned right away
    const viuOutroRetomado: boolean[] = [];
    const summary = await resumeInterruptedTurns(deps({
      listMarkers: async () => [
        { cardId: CARD, marker: (await readInflightMarker(CARD))! },
        { cardId: OUTRO, marker: (await readInflightMarker(OUTRO))! },
      ],
      getCard: async (id) => (id === CARD ? card : id === OUTRO ? ({ ...card, id: OUTRO } as Card) : undefined),
      wait: async () => {
        await vi.waitFor(() => { if (spawned.length === 0) throw new Error("o outro card ainda não foi retomado"); }, { timeout: 500 }).catch(() => undefined);
        viuOutroRetomado.push(spawned.length > 0);
        await heartbeat(ANTIGO, false);
      },
    }));

    expect(viuOutroRetomado).toEqual([true]);
    expect(summary.resumed.sort()).toEqual([CARD, OUTRO].sort());
  });
});

describe("handOffSdkOnShutdown — o adeus do processo antigo", () => {
  it("encerra os drivers, MANTÉM o marcador e larga o batimento — o sinal que o processo novo espera", async () => {
    await touchInflightOwner();
    const session = ensureDriverSession({ cardId: CARD, label: "t", command: { file: "docker", args: ["exec"] } });
    await writeInflightMarker(CARD, { startedAt: 1, attempts: 0 });
    expect(await isInflightOwnerAlive(INFLIGHT_OWNER)).toBe(true);

    handOffSdkOnShutdown();

    expect(spawned[0]!.stdin.ended).toBe(true);
    expect(session.closed).toBe(true);
    expect(await readInflightMarker(CARD)).not.toBeNull();
    expect(await isInflightOwnerAlive(INFLIGHT_OWNER)).toBe(false);
  });
});

/**
 * THE DRIVER DROPPED with the back up (OOM, kill, the docker exec that died): the marker belongs to this process,
 * which is still alive — the boot sweep would never see it as an orphan. The resume happens here, right away, with
 * the same rules as the boot (visible note, system continuation, anti-loop guard) and the right
 * words: there was no panel update at all.
 */
describe("resumeAfterDriverCrash — o driver caiu, o back não", () => {
  const crashDeps = (over: Partial<ResumeDeps> = {}) => deps({ selfOwner: INFLIGHT_OWNER, ...over });

  it("retoma o turno da pessoa depois de uma espera, com nota e continuação que falam de queda", async () => {
    const waits: number[] = [];
    const marker = { startedAt: 5, preview: "tarefa longa", attempts: 0 };
    await writeInflightMarker(CARD, marker);
    const outcome = await resumeAfterDriverCrash(CARD, marker, crashDeps({ wait: async (ms) => { waits.push(ms); } }));
    expect(outcome).toBe("resumed");
    expect(waits).toEqual([CRASH_RESUME_DELAY_MS]);
    expect(spawned.length).toBe(1);
    const frames = spawned[0]!.stdin.written.map((s) => JSON.parse(s) as { type: string; text?: string });
    expect(frames).toEqual([{ type: "user", text: CRASH_TEXTS.continuation }]);
    await vi.waitFor(async () => {
      const history = await readHistory(CARD);
      expect(history.map((e) => e.type)).toEqual(["system_note", "user"]);
      expect((history[0] as { text: string }).text).toBe(CRASH_TEXTS.resuming);
      expect(history[1]!.from).toEqual(SYSTEM_ORIGIN);
      expect((await readInflightMarker(CARD))?.attempts).toBe(1);
    });
  });

  it("queda com tarefa de fundo: o agente sabe o que morreu — e nada fala em reinício do painel", async () => {
    const marker = { startedAt: 5, attempts: 0, background: { tasks: ["suíte do back"], since: Date.now(), idle: false } };
    await writeInflightMarker(CARD, marker);
    expect(await resumeAfterDriverCrash(CARD, marker, crashDeps())).toBe("resumed");
    const frames = spawned[0]!.stdin.written.map((s) => JSON.parse(s) as { text: string });
    expect(frames[0]!.text.startsWith(CRASH_TEXTS.continuation)).toBe(true);
    expect(frames[0]!.text).toContain("- suíte do back");
    expect(frames[0]!.text).not.toMatch(/O reinício|atualização do painel/);
  });

  it("a pessoa seguiu enquanto isso (o marcador já é de outro turno): nada", async () => {
    const crashed = { startedAt: 5, attempts: 0 };
    await writeInflightMarker(CARD, { startedAt: 9, preview: "nova mensagem", attempts: 0 });
    expect(await resumeAfterDriverCrash(CARD, crashed, crashDeps())).toBe("skipped");
    expect(spawned.length).toBe(0);
    expect(await readHistory(CARD)).toEqual([]);
  });

  it("o marcador sumiu (o turno acabou de outro jeito): nada", async () => {
    expect(await resumeAfterDriverCrash(CARD, { startedAt: 5, attempts: 0 }, crashDeps())).toBe("skipped");
    expect(spawned.length).toBe(0);
  });

  it("um driver sucessor já está com turno rodando: nada (sem dois turnos na mesma sessão)", async () => {
    const marker = { startedAt: 5, attempts: 0 };
    await writeInflightMarker(CARD, marker);
    expect(await resumeAfterDriverCrash(CARD, marker, crashDeps({ turnRunning: () => true }))).toBe("skipped");
    expect(spawned.length).toBe(0);
    expect(await readInflightMarker(CARD)).not.toBeNull();
  });

  it("a pessoa seguiu DURANTE a preparação (sucessor + mensagem): a continuação não cai em cima dela", async () => {
    const marker = { startedAt: 5, attempts: 0 };
    await writeInflightMarker(CARD, marker);
    const outcome = await resumeAfterDriverCrash(CARD, marker, crashDeps({
      // While the driver's command is being built, the front reconnects and the person sends theirs.
      commandFor: async () => {
        await writeInflightMarker(CARD, { startedAt: 9, preview: "a da pessoa", attempts: 0 });
        return { file: "docker", args: ["exec"] };
      },
    }));
    expect(outcome).toBe("skipped");
    expect(spawned.length).toBe(0);
    expect(await readInflightMarker(CARD)).toMatchObject({ startedAt: 9, attempts: 0 });
  });

  it("o back está desligando (SIGTERM na espera): nada é retomado AQUI — o marcador fica para o processo novo", async () => {
    const marker = { startedAt: 5, attempts: 0 };
    await writeInflightMarker(CARD, marker);
    expect(await resumeAfterDriverCrash(CARD, marker, crashDeps({ stopping: () => true }))).toBe("skipped");
    expect(spawned.length).toBe(0);
    expect(await readHistory(CARD)).toEqual([]);
    expect(await readInflightMarker(CARD)).toMatchObject({ startedAt: 5, attempts: 0 });
  });

  it("SIGTERM durante a PREPARAÇÃO: não injeta nem sobe driver", async () => {
    const marker = { startedAt: 5, attempts: 0 };
    await writeInflightMarker(CARD, marker);
    let stopping = false;
    const outcome = await resumeAfterDriverCrash(CARD, marker, crashDeps({
      stopping: () => stopping,
      commandFor: async () => { stopping = true; return { file: "docker", args: ["exec"] }; },
    }));
    expect(outcome).toBe("skipped");
    expect(spawned.length).toBe(0);
    expect(await readInflightMarker(CARD)).toMatchObject({ startedAt: 5 });
  });

  it("a pessoa PAUSOU (ou o card hibernou) depois da queda: não revive o card", async () => {
    const marker = { startedAt: 5, attempts: 0 };
    await writeInflightMarker(CARD, marker);
    const paused = { ...card, pausedAt: 99 } as unknown as Card;
    expect(await resumeAfterDriverCrash(CARD, marker, crashDeps({ getCard: async () => paused }))).toBe("skipped");
    expect(spawned.length).toBe(0);
    expect(await readHistory(CARD)).toEqual([]);
    expect(await readInflightMarker(CARD)).toBeNull();
  });

  it("queda com o agente esperando resposta: o cartão fica aberto, e a nota fala de queda", async () => {
    await historyWith([{ type: "user_question", id: "q_1_1", questions: QUESTIONS, at: 10 }]);
    const marker = { startedAt: 5, attempts: 0 };
    await writeInflightMarker(CARD, marker);
    expect(await resumeAfterDriverCrash(CARD, marker, crashDeps())).toBe("noted");
    expect(spawned).toHaveLength(0);
    expect((await readHistory(CARD)).map((e) => (e as { text?: string }).text).at(-1)).toBe(CRASH_TEXTS.awaitingAnswer);
  });

  it("queda que NÃO retoma: a bolinha vai a aguardando (o manager a segurou em trabalhando)", async () => {
    const idle: string[] = [];
    const marker = { startedAt: 5, attempts: 1 };
    await writeInflightMarker(CARD, marker);
    expect(await resumeAfterDriverCrash(CARD, marker, crashDeps({ reportIdle: (id) => idle.push(id) }))).toBe("noted");
    expect(idle).toEqual([CARD]);
  });

  it("queda que retoma: a bolinha não passa por aguardando", async () => {
    const idle: string[] = [];
    const marker = { startedAt: 5, attempts: 0 };
    await writeInflightMarker(CARD, marker);
    expect(await resumeAfterDriverCrash(CARD, marker, crashDeps({ reportIdle: (id) => idle.push(id) }))).toBe("resumed");
    expect(idle).toEqual([]);
  });

  it("superada por um turno vivo no sucessor: a bolinha é dele, nada a acertar", async () => {
    const idle: string[] = [];
    const marker = { startedAt: 5, attempts: 0 };
    await writeInflightMarker(CARD, marker);
    const outcome = await resumeAfterDriverCrash(CARD, marker, crashDeps({ turnRunning: () => true, reportIdle: (id) => idle.push(id) }));
    expect(outcome).toBe("skipped");
    expect(idle).toEqual([]);
  });

  it("falha antes da preparação (settings ilegíveis): o marcador sai, sem retomada fora de hora no próximo deploy", async () => {
    const marker = { startedAt: 5, attempts: 0 };
    await writeInflightMarker(CARD, marker);
    const outcome = await resumeAfterDriverCrash(CARD, marker, crashDeps({ settings: async () => { throw new Error("disco"); } }));
    expect(outcome).toBe("skipped");
    expect(await readInflightMarker(CARD)).toBeNull();
  });

  it("a retomada que caiu antes de avançar: só a linha, sem loop", async () => {
    const marker = { startedAt: 5, attempts: 1 };
    await writeInflightMarker(CARD, marker);
    expect(await resumeAfterDriverCrash(CARD, marker, crashDeps())).toBe("noted");
    expect(spawned.length).toBe(0);
    const history = await readHistory(CARD);
    expect(history.map((e) => (e as { text?: string }).text)).toEqual([CRASH_TEXTS.notAgain]);
    expect(await readInflightMarker(CARD)).toBeNull();
  });

  it("sdkAutoResume desligado: a linha diz, e o marcador sai", async () => {
    const marker = { startedAt: 5, attempts: 0 };
    await writeInflightMarker(CARD, marker);
    const outcome = await resumeAfterDriverCrash(CARD, marker, deps({ selfOwner: INFLIGHT_OWNER }, settingsWith({ sdkAutoResume: false })));
    expect(outcome).toBe("noted");
    expect(((await readHistory(CARD))[0] as { text: string }).text).toBe(CRASH_TEXTS.autoOff);
    expect(await readInflightMarker(CARD)).toBeNull();
  });

  it("nunca lança: uma falha vira log e o marcador sai", async () => {
    const marker = { startedAt: 5, attempts: 0 };
    await writeInflightMarker(CARD, marker);
    const outcome = await resumeAfterDriverCrash(CARD, marker, crashDeps({ commandFor: async () => { throw new Error("runner fora"); } }));
    expect(outcome).toBe("noted");
    expect((await readHistory(CARD)).map((e) => (e as { text?: string }).text)).toEqual([CRASH_TEXTS.resuming, NOTE_RESUME_FAILED]);
    expect(await readInflightMarker(CARD)).toBeNull();
  });
});
