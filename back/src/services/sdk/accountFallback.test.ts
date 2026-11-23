import { describe, it, expect, onTestFinished, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.setConfig({ testTimeout: 30_000 });

vi.mock("../events/cardEvents.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../events/cardEvents.js")>();
  return { ...actual, observeDriverEvent: () => Promise.resolve() };
});

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

const RESETS_AT_SECONDS = 1_900_000_000;
const ORDER = { kind: "owner", name: "albert" } as const;
const DRIVER_COMMAND = { file: "docker", args: ["exec"] };

interface BootOptions {
  backups: ReadonlyArray<readonly [string, string]>;
  cardAccount: string;
  beforeContinuation?: (cardId: string) => void;
  startDriverFails?: boolean;
}

async function boot({ backups, cardAccount, beforeContinuation, startDriverFails }: BootOptions) {
  const dir = await mkdtemp(join(tmpdir(), "vibehub-account-fallback-"));
  vi.resetModules();
  const env = await import("../../config/env.js");
  env.config.dataDir = dir;
  const manager = await import("./manager.js");
  const registry = await import("../board/registry.js");
  const agentState = await import("../board/agentState.js");
  const history = await import("./history.js");
  const fallback = await import("./accountFallback.js");
  const spawned: FakeChild[] = [];
  manager.setDriverSpawnerForTesting(() => {
    const child = fakeChild();
    spawned.push(child);
    return child as never;
  });
  for (const name of ["albert", "cesar", "mussa"]) await registry.createAccount({ name });
  for (const [account, backup] of backups) await registry.setAccountBackup(account, backup);
  const project = await registry.createProject({ name: "Shop" });
  const card = await registry.createCard({ projectId: project.id, title: "Checkout" }, { accountSlug: cardAccount });
  const restarted: string[] = [];
  const stopWatching = fallback.watchAccountRefusals({
    restartCard: async (cardId) => {
      restarted.push(cardId);
      manager.stopCardDriver(cardId);
    },
    startDriver: async (cardId) => {
      if (startDriverFails) throw new Error("runner unreachable");
      const session = manager.ensureDriverSession({ cardId, label: "t", command: DRIVER_COMMAND });
      beforeContinuation?.(cardId);
      return session;
    },
  });
  onTestFinished(async () => {
    stopWatching();
    manager.resetSdkSessionsForTesting();
    manager.setDriverSpawnerForTesting(null);
    await rm(dir, { recursive: true, force: true });
  });
  const session = manager.ensureDriverSession({ cardId: card.id, label: "t", command: DRIVER_COMMAND });
  const emit = (driverIndex: number, event: object) => spawned[driverIndex]!.stdout.emit("data", Buffer.from(JSON.stringify(event) + "\n"));
  const userWrites = (driverIndex: number) => (spawned[driverIndex]?.stdin.written ?? [])
    .map((written) => JSON.parse(written) as { type: string; text?: string })
    .filter((frame) => frame.type === "user")
    .map((frame) => frame.text);
  const refuseForUsage = (driverIndex: number) => {
    emit(driverIndex, { type: "usage_limited", rateLimit: { status: "rejected", rateLimitType: "five_hour", resetsAt: RESETS_AT_SECONDS } });
    emit(driverIndex, { type: "result", subtype: "success", isError: true, result: "You've hit your limit" });
  };
  const refuseLogin = (driverIndex: number) => {
    emit(driverIndex, { type: "login_failed" });
    emit(driverIndex, { type: "result", subtype: "success", isError: true, result: "Invalid API key · Please run /login" });
  };
  const notes = async () => (await history.readHistory(card.id))
    .filter((event) => event.type === "system_note")
    .map((event) => (event as { text: string }).text);
  return { manager, registry, agentState, fallback, card, session, spawned, restarted, emit, userWrites, refuseForUsage, refuseLogin, notes };
}

describe("troca automática para a conta reserva no chat nativo", () => {
  it("conta estourada troca para a reserva e o turno continua sem a pessoa redigitar", async () => {
    const world = await boot({ backups: [["albert", "cesar"]], cardAccount: "albert" });
    world.manager.sendAgentTurn(world.session, "abre o PR", ORDER);

    world.refuseForUsage(0);

    await vi.waitFor(() => expect(world.userWrites(1)).toEqual([world.fallback.ACCOUNT_FALLBACK_CONTINUE_TEXT]));
    expect((await world.registry.getCard(world.card.id))?.accountSlug).toBe("cesar");
    expect(world.restarted).toEqual([world.card.id]);
    expect((await world.notes()).some((note) => note.includes("albert") && note.includes("Seguindo na conta cesar"))).toBe(true);
  });

  it("depois da troca a revisão não espera a renovação da conta antiga", async () => {
    const world = await boot({ backups: [["albert", "cesar"]], cardAccount: "albert" });
    world.manager.sendAgentTurn(world.session, "abre o PR", ORDER);

    world.refuseForUsage(0);

    await vi.waitFor(() => expect(world.spawned).toHaveLength(2));
    expect(world.agentState.cardUsageLimit(world.card.id)).toBeNull();
  });

  it("mensagem da pessoa durante a troca: a continuação não entra por cima", async () => {
    const world = await boot({
      backups: [["albert", "cesar"]],
      cardAccount: "albert",
      beforeContinuation: (cardId) => {
        const live = world.manager.liveDriverSession(cardId);
        if (live) world.manager.sendAgentTurn(live, "na verdade, só roda os testes", ORDER);
      },
    });
    world.manager.sendAgentTurn(world.session, "abre o PR", ORDER);

    world.refuseForUsage(0);

    await vi.waitFor(() => expect(world.userWrites(1)).toEqual(["na verdade, só roda os testes"]));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(world.userWrites(1)).toEqual(["na verdade, só roda os testes"]);
  });

  it("reserva sem login segue para a próxima da cadeia", async () => {
    const world = await boot({ backups: [["albert", "cesar"], ["cesar", "mussa"]], cardAccount: "albert" });
    world.manager.sendAgentTurn(world.session, "abre o PR", ORDER);
    world.refuseForUsage(0);
    await vi.waitFor(() => expect(world.userWrites(1)).toHaveLength(1));

    world.refuseLogin(1);

    await vi.waitFor(async () => expect((await world.registry.getCard(world.card.id))?.accountSlug).toBe("mussa"));
    await vi.waitFor(() => expect(world.userWrites(2)).toEqual([world.fallback.ACCOUNT_FALLBACK_CONTINUE_TEXT]));
    expect((await world.registry.getCard(world.card.id))?.accountLoan?.originalAccount).toBe("albert");
  });

  it("sem reserva configurada o card fica como hoje, com o aviso de limite", async () => {
    const world = await boot({ backups: [], cardAccount: "mussa" });
    world.manager.sendAgentTurn(world.session, "abre o PR", ORDER);

    world.refuseForUsage(0);

    await new Promise((resolve) => setTimeout(resolve, 100));
    expect((await world.registry.getCard(world.card.id))?.accountSlug).toBe("mussa");
    expect(world.spawned).toHaveLength(1);
    expect(world.agentState.cardUsageLimit(world.card.id)).toEqual({ resetsAt: RESETS_AT_SECONDS * 1000 });
  });

  it("erro de login fora de uma troca não troca a conta", async () => {
    const world = await boot({ backups: [["albert", "cesar"]], cardAccount: "albert" });
    world.manager.sendAgentTurn(world.session, "abre o PR", ORDER);

    world.refuseLogin(0);

    await new Promise((resolve) => setTimeout(resolve, 100));
    expect((await world.registry.getCard(world.card.id))?.accountSlug).toBe("albert");
    expect(world.spawned).toHaveLength(1);
  });

  it("todas as contas da cadeia sem limite: o chat avisa e o card não troca mais", async () => {
    const world = await boot({ backups: [["albert", "cesar"]], cardAccount: "albert" });
    world.manager.sendAgentTurn(world.session, "abre o PR", ORDER);
    world.refuseForUsage(0);
    await vi.waitFor(() => expect(world.userWrites(1)).toHaveLength(1));

    world.refuseForUsage(1);

    await vi.waitFor(async () => expect((await world.notes()).some((note) => note.includes(world.fallback.ACCOUNT_CHAIN_EXHAUSTED_NOTE))).toBe(true));
    expect(world.spawned).toHaveLength(2);
    expect((await world.registry.getCard(world.card.id))?.accountSlug).toBe("cesar");
  });

  it("o chat não abre na reserva: o card avisa que a troca falhou e o que fazer", async () => {
    const world = await boot({ backups: [["albert", "cesar"]], cardAccount: "albert", startDriverFails: true });
    world.manager.sendAgentTurn(world.session, "abre o PR", ORDER);

    world.refuseForUsage(0);

    await vi.waitFor(async () => expect((await world.notes()).some((note) => note.includes(world.fallback.ACCOUNT_FALLBACK_FAILED_NOTE))).toBe(true));
    expect((await world.registry.getCard(world.card.id))?.accountSlug).toBe("cesar");
  });

  it("a primeira resposta boa na reserva zera a cadeia e mantém o empréstimo", async () => {
    const world = await boot({ backups: [["albert", "cesar"]], cardAccount: "albert" });
    world.manager.sendAgentTurn(world.session, "abre o PR", ORDER);
    world.refuseForUsage(0);
    await vi.waitFor(() => expect(world.userWrites(1)).toHaveLength(1));

    world.emit(1, { type: "result", subtype: "success", isError: false });

    await vi.waitFor(async () => expect((await world.registry.getCard(world.card.id))?.accountLoan?.exhausted).toEqual([]));
    expect((await world.registry.getCard(world.card.id))?.accountLoan?.originalAccount).toBe("albert");
  });
});
