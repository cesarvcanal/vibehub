import { describe, it, expect, onTestFinished, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeDriverChild } from "../../testkit/fakeDriverChild.js";
import { FakeSocket } from "../../testkit/fakeSocket.js";

vi.setConfig({ testTimeout: 30_000 });

vi.mock("../events/cardEvents.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../events/cardEvents.js")>();
  return { ...actual, observeDriverEvent: () => Promise.resolve() };
});

const { voiceCallWriteFailures } = vi.hoisted(() => ({ voiceCallWriteFailures: { remaining: 0 } }));
vi.mock("../board/registry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../board/registry.js")>();
  return {
    ...actual,
    setCardVoiceCall: (cardId: string, at: number | null) => {
      if (voiceCallWriteFailures.remaining > 0) {
        voiceCallWriteFailures.remaining -= 1;
        return Promise.reject(new Error("disk full"));
      }
      return actual.setCardVoiceCall(cardId, at);
    },
  };
});

const ALBERT = { kind: "user", name: "albert" } as const;
const MUSSA = { kind: "owner", name: "mussa" } as const;
const DRIVER_COMMAND = { file: "docker", args: ["exec"] };

const voiceCall = (active: boolean): Buffer => Buffer.from(JSON.stringify({ type: "voice_call", active }));

async function boot() {
  const dir = await mkdtemp(join(tmpdir(), "vibehub-voice-call-"));
  vi.resetModules();
  const env = await import("../../config/env.js");
  env.config.dataDir = dir;
  const manager = await import("./manager.js");
  const registry = await import("../board/registry.js");
  manager.setDriverSpawnerForTesting(() => fakeDriverChild() as never);
  const project = await registry.createProject({ name: "Shop" });
  const card = await registry.createCard({ projectId: project.id, title: "Checkout" });
  onTestFinished(async () => {
    manager.resetSdkSessionsForTesting();
    manager.setDriverSpawnerForTesting(null);
    await rm(dir, { recursive: true, force: true });
  });
  const startDriver = () => manager.ensureDriverSession({ cardId: card.id, label: "t", command: DRIVER_COMMAND });
  const firstDriver = startDriver();
  const openTab = (origin: typeof ALBERT | typeof MUSSA, session = firstDriver): FakeSocket => {
    const socket = new FakeSocket();
    manager.attachSocket(session, socket as never, origin);
    return socket;
  };
  const callStamp = async (): Promise<number | null | undefined> => (await registry.getCard(card.id))?.voiceCallAt;
  const settleBoardWrites = () => registry.setCardPendingQuestion(card.id, null);
  return { manager, registry, card, startDriver, openTab, callStamp, settleBoardWrites };
}

describe("chamada de voz no chat do card — o board sabe que tem gente falando com a IA", () => {
  it("a aba que entra em chamada marca o card, e desligar tira a marca", async () => {
    const world = await boot();
    const albert = world.openTab(ALBERT);
    albert.emit("message", voiceCall(true));
    await vi.waitFor(async () => expect(typeof (await world.callStamp())).toBe("number"));
    albert.emit("message", voiceCall(false));
    await vi.waitFor(async () => expect((await world.callStamp()) ?? null).toBeNull());
  });

  it("com duas abas em chamada, a marca só sai quando a última sai — e fechar a aba conta como desligar", async () => {
    const world = await boot();
    const albert = world.openTab(ALBERT);
    const mussa = world.openTab(MUSSA);
    albert.emit("message", voiceCall(true));
    mussa.emit("message", voiceCall(true));
    await vi.waitFor(async () => expect(typeof (await world.callStamp())).toBe("number"));
    albert.emit("close");
    await world.settleBoardWrites();
    expect(typeof (await world.callStamp())).toBe("number");
    mussa.emit("close");
    await vi.waitFor(async () => expect((await world.callStamp()) ?? null).toBeNull());
  });

  it("a aba presa no driver que está saindo não apaga a marca de quem já está em chamada no driver novo do mesmo card", async () => {
    const world = await boot();
    const albert = world.openTab(ALBERT);
    albert.emit("message", voiceCall(true));
    await vi.waitFor(async () => expect(typeof (await world.callStamp())).toBe("number"));
    world.manager.stopCardDriver(world.card.id);
    const mussa = world.openTab(MUSSA, world.startDriver());
    mussa.emit("message", voiceCall(true));
    albert.emit("close");
    await world.settleBoardWrites();
    expect(typeof (await world.callStamp())).toBe("number");
  });

  it("a gravação que limparia a marca falha uma vez: a nova tentativa grava o estado atual e o microfone não fica preso", async () => {
    const world = await boot();
    const albert = world.openTab(ALBERT);
    albert.emit("message", voiceCall(true));
    await vi.waitFor(async () => expect(typeof (await world.callStamp())).toBe("number"));
    voiceCallWriteFailures.remaining = 1;
    albert.emit("message", voiceCall(false));
    await world.settleBoardWrites();
    expect(typeof (await world.callStamp())).toBe("number");
    await vi.waitFor(async () => expect((await world.callStamp()) ?? null).toBeNull(), { timeout: 10_000 });
  });

  it("o aviso de chamada nunca vira mensagem para a IA", async () => {
    const world = await boot();
    const albert = world.openTab(ALBERT);
    albert.emit("message", voiceCall(true));
    await vi.waitFor(async () => expect(typeof (await world.callStamp())).toBe("number"));
    const { readHistory } = await import("./history.js");
    expect((await readHistory(world.card.id)).filter((event) => event.type === "user")).toEqual([]);
  });

  it("no boot do servidor, a marca que sobrou de uma chamada de antes do restart é limpa", async () => {
    const world = await boot();
    await world.registry.setCardVoiceCall(world.card.id, 1_000);
    await world.registry.clearStaleVoiceCalls();
    expect((await world.callStamp()) ?? null).toBeNull();
  });
});
