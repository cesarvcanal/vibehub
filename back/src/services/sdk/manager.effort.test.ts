import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "../../config/env.js";
import { applyLiveEffort, cardDefaultEffort, onCardStatusSink } from "../board/agentState.js";
import {
  EFFORT_ACK_TIMEOUT_MS,
  applyDriverEffort,
  driverDefaultEffort,
  ensureDriverSession,
  handleClientFrame,
  resetSdkSessionsForTesting,
  setDriverSpawnerForTesting,
  stopCardDriver,
} from "./manager.js";
import { replayableHistoryEvent } from "./history.js";

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

/** The last `set_effort` written to the driver, with the id its confirmation has to carry. */
const lastEffortFrame = () => frames().filter((f) => f.type === "set_effort").at(-1) as { type: string; id: string; effort: string | null };
const confirm = (event: object) => spawned[0]!.stdout.emit("data", line({ type: "effort_ack", ...event }));

describe("sdk manager — a inteligência trocada com o driver de pé", () => {
  it("no meio do turno, o nível vai ao driver e só conta como aplicado quando ele CONFIRMA", async () => {
    const session = ensureDriverSession({ cardId: CARD, label: "t", command: { file: "docker", args: ["exec"] } });
    spawned[0]!.stdout.emit("data", line({ type: "ready" }));
    handleClientFrame(session, `{"type":"user","text":"revisa os PRs"}`);
    await flush();

    const applied = applyDriverEffort(CARD, "high");
    const frame = lastEffortFrame();
    expect(frame).toMatchObject({ type: "set_effort", effort: "high" });
    expect(frame.id).toMatch(/\S/);
    let settled = false;
    void applied.then(() => { settled = true; });
    await flush();
    expect(settled).toBe(false);

    confirm({ id: frame.id, effort: "high" });
    expect(await applied).toBe(true);
    // Nada foi parado: o mesmo driver, o mesmo turno.
    expect(spawned).toHaveLength(1);
    expect(session.closed).toBe(false);
    expect(session.activeTurns).toBe(1);
  });

  it("a sessão recusou (confirmação com erro): não aplicado, e quem trocou cai no reinício", async () => {
    ensureDriverSession({ cardId: CARD, label: "t", command: { file: "docker", args: ["exec"] } });
    const applied = applyDriverEffort(CARD, "medium");
    confirm({ id: lastEffortFrame().id, error: "control request failed" });
    expect(await applied).toBe(false);
  });

  it("a confirmação de OUTRA troca não responde por esta", async () => {
    ensureDriverSession({ cardId: CARD, label: "t", command: { file: "docker", args: ["exec"] } });
    const first = applyDriverEffort(CARD, "low");
    const firstId = lastEffortFrame().id;
    const second = applyDriverEffort(CARD, "max");
    const secondId = lastEffortFrame().id;
    expect(secondId).not.toBe(firstId);

    let firstSettled = false;
    void first.then(() => { firstSettled = true; });
    confirm({ id: secondId, error: "refused" });
    expect(await second).toBe(false);
    await flush();
    expect(firstSettled).toBe(false);
    confirm({ id: firstId, effort: "low" });
    expect(await first).toBe(true);
  });

  it("um driver que nunca confirma vence o prazo: não aplicado", async () => {
    ensureDriverSession({ cardId: CARD, label: "t", command: { file: "docker", args: ["exec"] } });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const applied = applyDriverEffort(CARD, "high");
      await vi.advanceTimersByTimeAsync(EFFORT_ACK_TIMEOUT_MS);
      expect(await applied).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("o driver morreu ou foi parado antes de confirmar: não aplicado, sem esperar o prazo", async () => {
    ensureDriverSession({ cardId: CARD, label: "t", command: { file: "docker", args: ["exec"] } });
    const crashed = applyDriverEffort(CARD, "high");
    spawned[0]!.emit("close", 1);
    expect(await crashed).toBe(false);

    ensureDriverSession({ cardId: CARD, label: "t", command: { file: "docker", args: ["exec"] } });
    const stopped = applyDriverEffort(CARD, "high");
    stopCardDriver(CARD);
    expect(await stopped).toBe(false);
  });

  it("é o aplicador que o board consulta (applyLiveEffort), e espera a mesma confirmação", async () => {
    ensureDriverSession({ cardId: CARD, label: "t", command: { file: "docker", args: ["exec"] } });
    const applied = applyLiveEffort(CARD, "xhigh");
    expect(lastEffortFrame()).toMatchObject({ type: "set_effort", effort: "xhigh" });
    confirm({ id: lastEffortFrame().id, effort: "xhigh" });
    expect(await applied).toBe(true);
  });

  it("sem driver — nunca subiu, ou já parou — não há a quem aplicar: quem trocou reinicia", async () => {
    expect(await applyDriverEffort(CARD, "high")).toBe(false);
    expect(await applyLiveEffort(CARD, "high")).toBe(false);

    ensureDriverSession({ cardId: CARD, label: "t", command: { file: "docker", args: ["exec"] } });
    stopCardDriver(CARD);
    expect(await applyDriverEffort(CARD, "high")).toBe(false);
  });

  it("o caso do card e9146043: subagente em PRIMEIRO PLANO rodando, a troca vai ao driver e a chamada dele volta", async () => {
    // 29/10: Extra alto escolhido com a ferramenta Agent aberta. Nada pode matar o driver — senão o
    // CLI retomado devolve a chamada como "session ended before this call's result was recorded".
    const session = ensureDriverSession({ cardId: CARD, label: "t", command: { file: "docker", args: ["exec"] } });
    spawned[0]!.stdout.emit("data", line({ type: "ready" }));
    handleClientFrame(session, `{"type":"user","text":"executa o plano"}`);
    await flush();
    spawned[0]!.stdout.emit("data", line({ type: "tool_use", id: "task-fg", name: "Agent", input: { description: "Implement Task 1" } }));
    await flush();

    const applied = applyLiveEffort(CARD, "xhigh");
    confirm({ id: lastEffortFrame().id, effort: "xhigh" });
    expect(await applied).toBe(true);
    expect(session.closed).toBe(false);
    expect(session.activeTurns).toBe(1);

    spawned[0]!.stdout.emit("data", line({ type: "tool_result", id: "task-fg", isError: false, text: "Task 1 pronta" }));
    spawned[0]!.stdout.emit("data", line({ type: "result", subtype: "success", isError: false }));
    await flush();
    expect(session.activeTurns).toBe(0);
    expect(spawned).toHaveLength(1); // o mesmo driver do começo ao fim
  });

  it("voltar ao padrão da conta (null) também vai ao driver vivo, sem reiniciar", async () => {
    const session = ensureDriverSession({ cardId: CARD, label: "t", command: { file: "docker", args: ["exec"] } });
    spawned[0]!.stdout.emit("data", line({ type: "ready" }));
    handleClientFrame(session, `{"type":"user","text":"revisa os PRs"}`);
    await flush();

    const applied = applyDriverEffort(CARD, null);
    expect(lastEffortFrame()).toMatchObject({ type: "set_effort", effort: null });
    confirm({ id: lastEffortFrame().id, effort: "medium" });
    expect(await applied).toBe(true);
    expect(session.closed).toBe(false);
    expect(spawned).toHaveLength(1);
  });

  it("voltar ao padrão da conta: o nível que a sessão confirmou passa a ser o padrão que o pill lê", async () => {
    // Um driver que subiu com --effort nunca anunciou o padrão da conta (effort_default só vem de um
    // CLI sem nível). A confirmação da volta ao padrão diz qual é.
    ensureDriverSession({ cardId: CARD, label: "t", command: { file: "docker", args: ["exec"] } });
    expect(driverDefaultEffort(CARD)).toBeNull();
    const applied = applyDriverEffort(CARD, null);
    confirm({ id: lastEffortFrame().id, effort: "high" });
    expect(await applied).toBe(true);
    expect(driverDefaultEffort(CARD)).toBe("high");

    // A confirmação de um nível FIXADO não é o padrão da conta.
    const pinned = applyDriverEffort(CARD, "low");
    confirm({ id: lastEffortFrame().id, effort: "low" });
    await pinned;
    expect(driverDefaultEffort(CARD)).toBe("high");
  });

  it("a confirmação é estado, não conversa: nenhuma linha de histórico, nenhum frame no navegador", async () => {
    const session = ensureDriverSession({ cardId: CARD, label: "t", command: { file: "docker", args: ["exec"] } });
    const sent: string[] = [];
    session.sockets.add({ readyState: 1, send: (s: string) => sent.push(s) } as never);
    const applied = applyDriverEffort(CARD, "high");
    confirm({ id: lastEffortFrame().id, effort: "high" });
    await applied;
    await flush();
    expect(sent.some((s) => s.includes("effort_ack"))).toBe(false);
  });

  it("o aviso de que a troca tirou o turno do nível da palavra vai aos navegadores, não ao histórico", async () => {
    const session = ensureDriverSession({ cardId: CARD, label: "t", command: { file: "docker", args: ["exec"] } });
    const sent: string[] = [];
    session.sockets.add({ readyState: 1, send: (s: string) => sent.push(s) } as never);
    spawned[0]!.stdout.emit("data", line({ type: "keyword_effort_replaced" }));
    await flush();
    expect(sent.map((s) => JSON.parse(s) as { type: string }).some((e) => e.type === "keyword_effort_replaced")).toBe(true);
    expect(replayableHistoryEvent({ type: "keyword_effort_replaced" } as never)).toBe(false);
  });

  it("um driver cujo processo já saiu não conta como vivo", async () => {
    ensureDriverSession({ cardId: CARD, label: "t", command: { file: "docker", args: ["exec"] } });
    spawned[0]!.exitCode = 1;
    expect(await applyDriverEffort(CARD, "high")).toBe(false);
  });
});

/**
 * O NÍVEL ANTES DA PRIMEIRA RESPOSTA: o driver anuncia no boot o padrão da conta (`effort_default`),
 * e o board o lê para o pill de um card sem nível fixado — que antes só sabia dele quando a primeira
 * resposta carimbava o transcript.
 */
describe("sdk manager — o nível padrão que o driver anuncia", () => {
  it("guarda o anunciado e o entrega ao board; um nível desconhecido não entra", async () => {
    ensureDriverSession({ cardId: CARD, label: "t", command: { file: "docker", args: ["exec"] } });
    expect(driverDefaultEffort(CARD)).toBeNull();
    spawned[0]!.stdout.emit("data", line({ type: "effort_default", effort: "medium" }));
    await flush();
    expect(driverDefaultEffort(CARD)).toBe("medium");
    expect(cardDefaultEffort(CARD)).toBe("medium");

    spawned[0]!.stdout.emit("data", line({ type: "effort_default", effort: "turbo" }));
    await flush();
    expect(driverDefaultEffort(CARD)).toBe("medium");
  });

  it("não vai para a conversa: nenhuma linha de histórico, nenhum frame no navegador", async () => {
    const session = ensureDriverSession({ cardId: CARD, label: "t", command: { file: "docker", args: ["exec"] } });
    const sent: string[] = [];
    session.sockets.add({ readyState: 1, send: (s: string) => sent.push(s) } as never);
    spawned[0]!.stdout.emit("data", line({ type: "effort_default", effort: "high" }));
    await flush();
    expect(sent.some((s) => s.includes("effort_default"))).toBe(false);
  });

  it("sem driver, ninguém diz nada", async () => {
    expect(driverDefaultEffort(CARD)).toBeNull();
    ensureDriverSession({ cardId: CARD, label: "t", command: { file: "docker", args: ["exec"] } });
    spawned[0]!.stdout.emit("data", line({ type: "effort_default", effort: "high" }));
    await flush();
    stopCardDriver(CARD);
    expect(driverDefaultEffort(CARD)).toBeNull();
    expect(cardDefaultEffort(CARD)).toBeNull();
  });
});
