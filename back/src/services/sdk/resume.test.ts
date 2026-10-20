import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "../../config/env.js";
import type { Card, Project } from "../board/registry.js";
import type { Settings } from "../settings/settings.js";
import { BACKGROUND_HOLD_MAX_MS, ensureDriverSession, injectSystemTurn, resetSdkSessionsForTesting, setDriverSpawnerForTesting } from "./manager.js";
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
  NOTE_AUTO_OFF,
  NOTE_BACKGROUND_STALE,
  NOTE_NOT_AGAIN,
  NOTE_RESUMING,
  RESUME_CONTINUATION_TEXT,
  SYSTEM_ORIGIN,
  handOffSdkOnShutdown,
  isStaleBackgroundOnly,
  resumeAfterDriverCrash,
  resumeContinuationText,
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
/** O processo antigo e o novo de um deploy blue/green — ids no formato que o back gera. */
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
    restoreWorkspace: async () => false,
    commandFor: async () => ({ file: "docker", args: ["exec"] }),
    ensureSession: ensureDriverSession,
    inject: injectSystemTurn,
    readMarker: readInflightMarker,
    // Os marcadores que os testes escrevem são assinados por ESTE processo (INFLIGHT_OWNER), que
    // não bate: é o processo antigo de um deploy, já morto. O sweep sob teste faz o papel do NOVO.
    selfOwner: NOVO,
    ownerAlive: isInflightOwnerAlive,
    turnRunning: () => false,
    wait: async () => undefined,
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
    expect(text).not.toContain("- t8"); // a lista é curta: contexto, não inventário
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
    await writeInflightMarker(CARD, { startedAt: 1, attempts: 1, progressed: true });
    const summary = await resumeInterruptedTurns(deps());
    expect(summary.resumed).toEqual([CARD]);
    expect(spawned.length).toBe(1);
    // A nova retomada nasce SEM progresso: se morrer antes de fazer qualquer coisa, a próxima só anota.
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
    await writeInflightMarker(CARD, { startedAt: 1, attempts: MAX_AUTO_RESUMES, progressed: true });
    const summary = await resumeInterruptedTurns(deps());
    expect(summary).toEqual({ resumed: [], noted: [CARD] });
    expect(spawned.length).toBe(0);
    const history = await readHistory(CARD);
    expect((history[0] as { text: string }).text).toBe(NOTE_NOT_AGAIN);
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

/** Um marcador escrito por OUTRO processo do back (o container antigo de um blue/green). */
async function markerFrom(owner: string, cardId = CARD): Promise<void> {
  await mkdir(join(dir, SDK_INFLIGHT_DIR), { recursive: true });
  await writeFile(join(dir, SDK_INFLIGHT_DIR, `${cardId}.json`), JSON.stringify({ startedAt: 1, preview: "jest longo", attempts: 0, owner }), "utf8");
}

/** O batimento que o processo `owner` mantém enquanto vive — `null` = ele morreu (SIGKILL). */
async function heartbeat(owner: string, alive: boolean): Promise<void> {
  const file = join(dir, SDK_INFLIGHT_DIR, "owners", owner);
  if (!alive) { await rm(file, { force: true }); return; }
  await mkdir(join(file, ".."), { recursive: true });
  await writeFile(file, String(Date.now()), "utf8");
}

/**
 * O BUG DA PRINT (produção, 2026-10-08): "Continue de onde parou" aparecia como `Sistema (vibehub)`
 * e de novo como bolha, depois de "Atividade no terminal". O deploy do tech.multi é BLUE/GREEN: o
 * container novo sobe e fica saudável com o ANTIGO ainda no ar, rodando o turno. O sweep do novo
 * via o marcador, concluía "interrompido" e retomava um turno VIVO — e o espelho do back antigo, que
 * não conhecia aquela fala, gravava a linha que o CLI escreveu como conversa do terminal.
 *
 * Um marcador só é órfão quando o processo que o escreveu já não está vivo.
 */
describe("resumeInterruptedTurns — o turno ainda vivo na instância antiga (deploy blue/green)", () => {
  it("espera o dono morrer: nada de nota nem de retomada enquanto ele bate, e retoma UMA vez depois", async () => {
    await markerFrom(ANTIGO);
    await heartbeat(ANTIGO, true);
    let esperas = 0;
    const summary = await resumeInterruptedTurns(deps({
      wait: async () => {
        // Enquanto o antigo bate, o card não ganhou nada: nem a nota, nem o driver novo.
        expect(await readHistory(CARD)).toEqual([]);
        expect(spawned.length).toBe(0);
        esperas += 1;
        if (esperas === 2) await heartbeat(ANTIGO, false); // o `docker rm -f` do tech.multi
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
      // O `result` do turno chega no back antigo, que apaga o marcador — o sweep relê e vê que acabou.
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
    await writeInflightMarker(OUTRO, { startedAt: 1, attempts: 0 }); // dono morto: órfão já
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
 * O DRIVER CAIU com o back de pé (OOM, kill, o docker exec que morreu): o marcador é deste processo,
 * que segue vivo — o sweep de boot nunca o veria como órfão. A retomada acontece aqui, na hora, com
 * as mesmas regras do boot (nota visível, continuação de sistema, trava anti-loop) e as palavras
 * certas: não houve atualização do painel nenhuma.
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
    expect(await readInflightMarker(CARD)).toBeNull();
  });
});
