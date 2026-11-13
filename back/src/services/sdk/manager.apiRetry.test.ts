import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "../../config/env.js";
import { readHistory, rewindHistory } from "./history.js";
import { readInflightMarker } from "./inflight.js";
import {
  API_RETRY_DELAYS_MS,
  API_RETRY_TEXT,
  NOTE_API_RETRY_EXHAUSTED,
  attachSocket,
  driverTurnRunning,
  ensureDriverSession,
  isTransientApiFailure,
  resetSdkSessionsForTesting,
  sendAgentTurn,
  setDriverSpawnerForTesting,
  stopCardDriver,
} from "./manager.js";

/**
 * THE TURN THE NETWORK KNOCKED DOWN (production, card 8f2a, 23/10/2026 18:46): the CLI exhausted its
 * own attempts and closed the turn with "API Error: Can't reach the API server — check your internet or
 * DNS (EAI_AGAIN)". Nothing tried again: the card sat at "falhou" until someone wrote
 * "continua". A TRANSIENT API failure now comes back on its own, with a growing wait and a cap.
 */

const { observed } = vi.hoisted(() => ({ observed: [] as Array<{ type: string; isError?: boolean }> }));
vi.mock("../events/cardEvents.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../events/cardEvents.js")>();
  return {
    ...actual,
    observeDriverEvent: (_cardId: string, event: { type: string; isError?: boolean }) => { observed.push(event); return Promise.resolve(); },
  };
});

vi.mock("../board/registry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../board/registry.js")>();
  return { ...actual, markCardHumanActive: () => Promise.resolve(undefined) };
});

const CARD = "eeee498d-98dd-44b6-97ee-c06a181c3769";
const EAI = "API Error: Can't reach the API server — check your internet or DNS (EAI_AGAIN)";

interface FakeChild extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
  stdin: EventEmitter & { write: (s: string) => boolean; end: () => void; written: string[]; writable: boolean };
  exitCode: number | null;
  kill: () => void;
}

function fakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  const stdin = new EventEmitter() as FakeChild["stdin"];
  stdin.written = [];
  stdin.writable = true;
  stdin.write = (s: string) => { stdin.written.push(s); return true; };
  stdin.end = () => { stdin.writable = false; };
  child.stdin = stdin;
  child.exitCode = null;
  child.kill = () => undefined;
  return child;
}

let dir = "";
let savedDataDir = "";
let spawned: FakeChild[] = [];

beforeEach(async () => {
  observed.length = 0;
  dir = await mkdtemp(join(tmpdir(), "vibehub-sdk-apiretry-"));
  savedDataDir = config.dataDir;
  config.dataDir = dir;
  spawned = [];
  setDriverSpawnerForTesting(() => {
    const child = fakeChild();
    spawned.push(child);
    return child as never;
  });
});

afterEach(async () => {
  vi.useRealTimers();
  resetSdkSessionsForTesting();
  setDriverSpawnerForTesting(null);
  await rewindHistory(CARD, "");
  config.dataDir = savedDataDir;
  await rm(dir, { recursive: true, force: true });
});

const ensure = () => ensureDriverSession({ cardId: CARD, label: "t", command: { file: "docker", args: ["exec"] } });
const emit = (event: object) => spawned[0]!.stdout.emit("data", Buffer.from(JSON.stringify(event) + "\n"));
const userWrites = () => spawned[0]!.stdin.written
  .map((w) => JSON.parse(w) as { type: string; text?: string })
  .filter((f) => f.type === "user")
  .map((f) => f.text);
const ORDER = { kind: "owner", name: "cesar" } as const;

describe("isTransientApiFailure — o que é falha passageira da API", () => {
  it("rede, DNS, timeout, sobrecarga e 5xx: sim", () => {
    for (const text of [
      EAI,
      "API Error: Connection error.",
      "API Error: Request timed out.",
      "API Error: 529 {\"type\":\"error\",\"error\":{\"type\":\"overloaded_error\",\"message\":\"Overloaded\"}}",
      "API Error: 500 {\"type\":\"error\",\"error\":{\"type\":\"api_error\",\"message\":\"Internal server error\"}}",
      "API Error: 503 upstream connect error",
      "API Error: fetch failed (ECONNRESET)",
    ]) expect(isTransientApiFailure(text), text).toBe(true);
  });

  it("credencial, pedido inválido, limite do plano, erro de ferramenta ou texto qualquer: não", () => {
    for (const text of [
      "API Error: 401 {\"type\":\"error\",\"error\":{\"type\":\"authentication_error\"}}",
      "API Error: 400 {\"type\":\"error\",\"error\":{\"type\":\"invalid_request_error\",\"message\":\"prompt is too long\"}}",
      "API Error: 429 {\"type\":\"error\",\"error\":{\"type\":\"rate_limit_error\"}}",
      "Claude AI usage limit reached|1793050000",
      "error_during_execution",
      "O teste falhou com ECONNRESET no banco",
      "",
      undefined,
    ]) expect(isTransientApiFailure(text), String(text)).toBe(false);
  });
});

describe("falha transitória da API — o turno volta sozinho", () => {
  it("EAI_AGAIN no fim do turno: nota visível agora, e a ordem de continuar depois da primeira espera", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const session = ensure();
    sendAgentTurn(session, "roda a suíte e abre o PR", ORDER);
    emit({ type: "result", subtype: "success", isError: true, result: EAI });
    expect(userWrites()).toEqual(["roda a suíte e abre o PR"]);
    // the wait is part of the turn: the dot stays "trabalhando", the marker stays in case a deploy lands
    // in the middle of it, and whoever follows from outside does not get a "falhou" the panel is already resolving
    expect(driverTurnRunning(CARD)).toBe(true);
    expect(observed.filter((e) => e.type === "result")).toEqual([]);
    vi.advanceTimersByTime(API_RETRY_DELAYS_MS[0]! - 1);
    expect(userWrites()).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(userWrites()).toEqual(["roda a suíte e abre o PR", API_RETRY_TEXT]);
    expect(driverTurnRunning(CARD)).toBe(true);
    vi.useRealTimers();
    await vi.waitFor(async () => expect((await readInflightMarker(CARD))?.preview).toContain("falha temporária"));
    await vi.waitFor(async () => {
      const history = await readHistory(CARD);
      expect(history.some((e) => e.type === "system_note" && /API/.test(String((e as { text?: string }).text)))).toBe(true);
      const retry = history.find((e) => e.type === "user" && (e as { text?: string }).text === API_RETRY_TEXT) as { from?: { kind: string } } | undefined;
      expect(retry?.from?.kind).toBe("system");
    });
  });

  it("durante a espera o marcador do turno fica no disco: um deploy ali é retomado pelo boot", async () => {
    const session = ensure();
    sendAgentTurn(session, "roda a suíte e abre o PR", ORDER);
    emit({ type: "result", subtype: "success", isError: true, result: EAI });
    await new Promise((r) => setTimeout(r, 100)); // gives time for a wrongful delete to happen
    expect((await readInflightMarker(CARD))?.preview).toBe("roda a suíte e abre o PR");
    expect(userWrites()).toHaveLength(1);
  });

  it("falha que não é da rede (401) não é repetida", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const session = ensure();
    sendAgentTurn(session, "faz", ORDER);
    emit({ type: "result", subtype: "success", isError: true, result: "API Error: 401 authentication_error" });
    expect(driverTurnRunning(CARD)).toBe(false);
    expect(observed.filter((e) => e.type === "result")).toHaveLength(1);
    vi.advanceTimersByTime(API_RETRY_DELAYS_MS.reduce((a, b) => a + b, 0) + 1);
    expect(userWrites()).toEqual(["faz"]);
  });

  it("a pessoa escreveu durante a espera: a mensagem dela é o turno, a nova tentativa não vai", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const session = ensure();
    sendAgentTurn(session, "faz", ORDER);
    emit({ type: "result", subtype: "success", isError: true, result: EAI });
    const socket = Object.assign(new EventEmitter(), { sent: [] as string[], readyState: 1, send(s: string) { this.sent.push(s); }, close() {} });
    attachSocket(session, socket as never);
    socket.emit("message", Buffer.from(`{"type":"user","text":"e aí?"}`));
    vi.advanceTimersByTime(API_RETRY_DELAYS_MS[0]! + 1);
    expect(userWrites()).toEqual(["faz", "e aí?"]);
  });

  it("Parar durante a espera cancela a nova tentativa: o painel não desfaz o clique da pessoa", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const session = ensure();
    sendAgentTurn(session, "faz", ORDER);
    emit({ type: "result", subtype: "success", isError: true, result: EAI });
    const socket = Object.assign(new EventEmitter(), { sent: [] as string[], readyState: 1, send(s: string) { this.sent.push(s); }, close() {} });
    attachSocket(session, socket as never);
    socket.emit("message", Buffer.from(`{"type":"interrupt"}`));
    expect(driverTurnRunning(CARD)).toBe(false);
    vi.advanceTimersByTime(API_RETRY_DELAYS_MS.reduce((a, b) => a + b, 0) + 1);
    expect(userWrites()).toEqual(["faz"]);
  });

  it("a nova tentativa não pôde ser escrita (driver saiu): o card para com nota e o 'falhou' sai", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const session = ensure();
    sendAgentTurn(session, "faz", ORDER);
    emit({ type: "result", subtype: "success", isError: true, result: EAI });
    spawned[0]!.exitCode = 1;
    vi.advanceTimersByTime(API_RETRY_DELAYS_MS[0]!);
    expect(userWrites()).toEqual(["faz"]);
    expect(driverTurnRunning(CARD)).toBe(false);
    expect(observed.filter((e) => e.type === "result" && e.isError)).toHaveLength(1);
    vi.useRealTimers();
    await vi.waitFor(async () => {
      const history = await readHistory(CARD);
      expect(history.some((e) => e.type === "system_note" && (e as { text?: string }).text === NOTE_API_RETRY_EXHAUSTED)).toBe(true);
    });
  });

  it("driver parado (pausa, hibernação) durante a espera: nada é escrito", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const session = ensure();
    sendAgentTurn(session, "faz", ORDER);
    emit({ type: "result", subtype: "success", isError: true, result: EAI });
    stopCardDriver(CARD);
    vi.advanceTimersByTime(API_RETRY_DELAYS_MS[0]! + 1);
    expect(userWrites()).toEqual(["faz"]);
  });

  it("falhas seguidas esperam cada vez mais, param no teto com nota, e um turno bom zera a conta", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const session = ensure();
    sendAgentTurn(session, "faz", ORDER);
    for (const delay of API_RETRY_DELAYS_MS) {
      emit({ type: "result", subtype: "success", isError: true, result: EAI });
      vi.advanceTimersByTime(delay);
    }
    expect(userWrites()).toHaveLength(1 + API_RETRY_DELAYS_MS.length);
    // the cap: one more failure becomes a note, never another send
    emit({ type: "result", subtype: "success", isError: true, result: EAI });
    vi.advanceTimersByTime(10 * API_RETRY_DELAYS_MS.at(-1)!);
    expect(userWrites()).toHaveLength(1 + API_RETRY_DELAYS_MS.length);
    // gave up: now the card does stop and the "falhou" goes out, once
    expect(driverTurnRunning(CARD)).toBe(false);
    expect(observed.filter((e) => e.type === "result")).toHaveLength(1);
    vi.useRealTimers();
    await vi.waitFor(async () => {
      const history = await readHistory(CARD);
      expect(history.some((e) => e.type === "system_note" && (e as { text?: string }).text === NOTE_API_RETRY_EXHAUSTED)).toBe(true);
    });

    // after a turn that succeeded, the next drop starts the count from zero
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    sendAgentTurn(session, "de novo", ORDER);
    emit({ type: "result", subtype: "success", isError: false, result: "feito" });
    sendAgentTurn(session, "mais uma", ORDER);
    emit({ type: "result", subtype: "success", isError: true, result: EAI });
    vi.advanceTimersByTime(API_RETRY_DELAYS_MS[0]!);
    expect(userWrites().at(-1)).toBe(API_RETRY_TEXT);
  });
});
