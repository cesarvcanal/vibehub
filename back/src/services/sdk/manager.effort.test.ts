import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "../../config/env.js";
import { applyLiveEffort, onCardStatusSink } from "../board/agentState.js";
import {
  applyDriverEffort,
  ensureDriverSession,
  handleClientFrame,
  resetSdkSessionsForTesting,
  setDriverSpawnerForTesting,
  stopCardDriver,
} from "./manager.js";

/**
 * A INTELIGÊNCIA TROCADA COM O CHAT DE PÉ. A troca no pill virava um reinício pendente que só vinha
 * no fim do turno — e um turno com subagentes em segundo plano não acabava a tempo: a sessão seguia
 * no nível velho (produção, 2026-10-27). O manager entrega o nível ao driver vivo, que o aplica na
 * sessão sem reiniciar; sem driver, a resposta é "não aplicado" e quem trocou reinicia, como antes.
 */
vi.mock("../board/registry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../board/registry.js")>();
  return {
    ...actual,
    markCardHumanActive: () => Promise.resolve(undefined),
    updateCard: () => Promise.resolve(undefined),
    getCard: () => Promise.resolve({ id: CARD, column: "working", status: "working", pausedAt: null }),
    setCardAwaitingDecision: () => Promise.resolve(),
  };
});
onCardStatusSink(() => Promise.resolve(undefined));

const CARD = "bbbb498d-98dd-44b6-97ee-c06a181c3769";

interface FakeChild extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
  stdin: EventEmitter & { write: (s: string) => boolean; end: () => void; writable: boolean };
  exitCode: number | null;
  kill: () => void;
  written: string[];
}

function fakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.written = [];
  const stdin = new EventEmitter() as FakeChild["stdin"];
  stdin.writable = true;
  stdin.write = (s: string) => { child.written.push(s); return true; };
  stdin.end = () => { stdin.writable = false; };
  child.stdin = stdin;
  child.exitCode = null;
  child.kill = () => {};
  return child;
}

const line = (event: object) => Buffer.from(JSON.stringify(event) + "\n");
const flush = () => new Promise((r) => setTimeout(r, 0));

let dir = "";
let savedDataDir = "";
let spawned: FakeChild[] = [];
/** The control frames written to the driver's stdin, parsed. */
const frames = () => spawned[0]!.written.flatMap((s) => s.split("\n").filter(Boolean).map((l) => JSON.parse(l) as { type: string }));

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "vibehub-sdk-effort-"));
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
  resetSdkSessionsForTesting();
  setDriverSpawnerForTesting(null);
  await flush();
  config.dataDir = savedDataDir;
  await rm(dir, { recursive: true, force: true });
});

describe("sdk manager — a inteligência trocada com o driver de pé", () => {
  it("no meio do turno, o nível vai ao driver como set_effort e o turno segue aberto", async () => {
    const session = ensureDriverSession({ cardId: CARD, label: "t", command: { file: "docker", args: ["exec"] } });
    spawned[0]!.stdout.emit("data", line({ type: "ready" }));
    handleClientFrame(session, `{"type":"user","text":"revisa os PRs"}`);
    await flush();

    expect(applyDriverEffort(CARD, "high")).toBe(true);
    expect(frames().at(-1)).toEqual({ type: "set_effort", effort: "high" });
    // Nada foi parado: o mesmo driver, o mesmo turno.
    expect(spawned).toHaveLength(1);
    expect(session.closed).toBe(false);
    expect(session.activeTurns).toBe(1);
  });

  it("é o aplicador que o board consulta (applyLiveEffort)", async () => {
    ensureDriverSession({ cardId: CARD, label: "t", command: { file: "docker", args: ["exec"] } });
    expect(applyLiveEffort(CARD, "xhigh")).toBe(true);
    expect(frames().at(-1)).toEqual({ type: "set_effort", effort: "xhigh" });
  });

  it("sem driver — nunca subiu, ou já parou — não há a quem aplicar: quem trocou reinicia", async () => {
    expect(applyDriverEffort(CARD, "high")).toBe(false);
    expect(applyLiveEffort(CARD, "high")).toBe(false);

    ensureDriverSession({ cardId: CARD, label: "t", command: { file: "docker", args: ["exec"] } });
    stopCardDriver(CARD);
    expect(applyDriverEffort(CARD, "high")).toBe(false);
  });

  it("um driver cujo processo já saiu não conta como vivo", async () => {
    ensureDriverSession({ cardId: CARD, label: "t", command: { file: "docker", args: ["exec"] } });
    spawned[0]!.exitCode = 1;
    expect(applyDriverEffort(CARD, "high")).toBe(false);
  });
});
