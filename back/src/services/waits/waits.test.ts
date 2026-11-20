import { describe, it, expect, onTestFinished, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CardWait } from "../board/cardWait.js";
import { buildWakeMessage } from "./waits.js";
import { mockHostExecutor } from "../../testkit/fakeHost.js";

const CLAUDE_ALIVE = { stdout: "bash\nnode\n", stderr: "" };
const runScript = vi.fn<(script: string) => Promise<typeof CLAUDE_ALIVE>>(async () => CLAUDE_ALIVE);

async function load() {
  const dataDir = mkdtempSync(join(tmpdir(), "vibehub-waits-service-"));
  onTestFinished(() => rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }));
  runScript.mockReset();
  runScript.mockResolvedValue(CLAUDE_ALIVE);
  vi.resetModules();
  const env = await import("../../config/env.js");
  env.config.dataDir = dataDir;
  env.config.runner.container = "vibehub-runner";
  mockHostExecutor(runScript);
  const settings = await import("../settings/settings.js");
  await settings.updateSettings({ sdkDriver: false });
  return { registry: await import("../board/registry.js"), waits: await import("./waits.js") };
}

type Loaded = Awaited<ReturnType<typeof load>>;

async function createOpenPair({ registry }: Loaded) {
  const project = await registry.createProject({ name: "Shop" });
  const target = await registry.createCard({ projectId: project.id, title: "Captura de falhas" });
  const waiting = await registry.createCard({ projectId: project.id, title: "Complemento" });
  await registry.applyOpenTerminal(waiting.id);
  return { project, target, waiting };
}

function sentScripts(): string[] {
  return runScript.mock.calls.map((call) => String((call as unknown as string[])[0]));
}

async function startWatch({ waits }: Loaded): Promise<void> {
  onTestFinished(await waits.startCardWaitWatch());
}

describe("buildWakeMessage", () => {
  const wait: CardWait = { cardId: "target-id", instruction: "faça o PR complementar", createdAt: 1, createdBy: "user-1", readyAt: 2 };

  it.each([
    ["pr_merged", { prNumber: 356 }, "PR #356 foi mergeado"],
    ["concluded", {}, "foi concluído (sem PR mergeado pelo vibehub desde que a espera foi criada)"],
    ["concluded", { base: "prod" }, "foi concluído (sem PR mergeado na base prod pelo vibehub desde que a espera foi criada)"],
    ["deleted", {}, "foi apagado"],
  ] as const)("diz como o card esperado terminou (%s) e repete a instrução", (outcome, extra, phrase) => {
    const message = buildWakeMessage({ ...wait, outcome, ...extra }, "Captura de falhas");
    expect(message).toContain(phrase);
    expect(message).toContain("faça o PR complementar");
  });
});

describe("createCardWait", () => {
  it("grava a espera e devolve o título do card esperado; uma espera nova substitui a anterior", async () => {
    const loaded = await load();
    const { target, waiting, project } = await createOpenPair(loaded);
    const other = await loaded.registry.createCard({ projectId: project.id, title: "Outro" });
    await loaded.waits.createCardWait({ waitingCardId: waiting.id, targetCardId: other.id, instruction: "x", createdBy: "user-1" });
    const created = await loaded.waits.createCardWait({
      waitingCardId: waiting.id, targetCardId: target.id, instruction: "  faça o complemento  ", base: "main", createdBy: "user-1",
    });
    expect(created.targetTitle).toBe("Captura de falhas");
    expect((await loaded.registry.getCard(waiting.id))?.waitingFor).toEqual({
      cardId: target.id, instruction: "faça o complemento", base: "main", createdBy: "user-1", createdAt: expect.any(Number),
    });
  });

  it.each([
    ["o próprio card", "self", "", /itself/],
    ["um card que não existe", "missing", "", /card not found/],
    ["um card já concluído", "done", "", /already finished/],
    ["instrução vazia", "target", "   ", /instruction/],
    ["base inválida", "target", "bad base", /branch/],
  ])("recusa esperar %s", async (_case, targetKind, variant, error) => {
    const loaded = await load();
    const { target, waiting } = await createOpenPair(loaded);
    if (targetKind === "done") await loaded.registry.updateCard(target.id, { column: "done" });
    const targetCardId = { self: waiting.id, missing: "00000000-0000-4000-8000-000000000000", done: target.id, target: target.id }[targetKind] as string;
    const instruction = variant === "   " ? "   " : "faça o complemento";
    const base = variant === "bad base" ? "não é branch" : undefined;
    await expect(loaded.waits.createCardWait({ waitingCardId: waiting.id, targetCardId, instruction, base, createdBy: "user-1" })).rejects.toThrow(error);
    expect((await loaded.registry.getCard(waiting.id))?.waitingFor).toBeUndefined();
  });

  it("recusa a espera que fecharia um ciclo entre cards", async () => {
    const loaded = await load();
    const { target, waiting, project } = await createOpenPair(loaded);
    const middle = await loaded.registry.createCard({ projectId: project.id, title: "Meio" });
    await loaded.waits.createCardWait({ waitingCardId: target.id, targetCardId: middle.id, instruction: "x", createdBy: "user-1" });
    await loaded.waits.createCardWait({ waitingCardId: middle.id, targetCardId: waiting.id, instruction: "x", createdBy: "user-1" });
    await expect(loaded.waits.createCardWait({ waitingCardId: waiting.id, targetCardId: target.id, instruction: "x", createdBy: "user-1" }))
      .rejects.toThrow(/cycle/);
  });

  it("recusa uma instrução maior que o limite", async () => {
    const loaded = await load();
    const { target, waiting } = await createOpenPair(loaded);
    await expect(loaded.waits.createCardWait({ waitingCardId: waiting.id, targetCardId: target.id, instruction: "x".repeat(2001), createdBy: "user-1" }))
      .rejects.toThrow(/instruction/);
  });
});

describe("cancelCardWait", () => {
  it("apaga a espera do card e recusa cancelar o que não existe", async () => {
    const loaded = await load();
    const { target, waiting } = await createOpenPair(loaded);
    await loaded.waits.createCardWait({ waitingCardId: waiting.id, targetCardId: target.id, instruction: "x", createdBy: "user-1" });
    await loaded.waits.cancelCardWait(waiting.id);
    expect((await loaded.registry.getCard(waiting.id))?.waitingFor).toBeUndefined();
    await expect(loaded.waits.cancelCardWait(waiting.id)).rejects.toThrow(/no wait/);
  });
});

describe("disparo da espera", () => {
  it("o card esperado concluído acorda quem espera com a instrução, e a espera acaba", async () => {
    const loaded = await load();
    await startWatch(loaded);
    const { target, waiting } = await createOpenPair(loaded);
    await loaded.waits.createCardWait({ waitingCardId: waiting.id, targetCardId: target.id, instruction: "faça o complemento", createdBy: "user-1" });
    await loaded.registry.updateCard(target.id, { column: "done" });
    await vi.waitFor(() => expect(sentScripts().some((script) => script.includes("faça o complemento"))).toBe(true));
    await vi.waitFor(async () => expect((await loaded.registry.getCard(waiting.id))?.waitingFor).toBeUndefined());
  });

  it("falha ao acordar deixa a espera pronta com o motivo visível", async () => {
    const loaded = await load();
    await startWatch(loaded);
    const { target, waiting } = await createOpenPair(loaded);
    await loaded.waits.createCardWait({ waitingCardId: waiting.id, targetCardId: target.id, instruction: "faça o complemento", createdBy: "user-1" });
    runScript.mockImplementation(async (script: string) => {
      if (script.includes("faça o complemento")) throw new Error("runner fora do ar");
      return CLAUDE_ALIVE;
    });
    await loaded.registry.updateCard(target.id, { column: "done" });
    await vi.waitFor(async () => expect((await loaded.registry.getCard(waiting.id))?.waitingFor?.failure?.reason).toBeTruthy());
    expect((await loaded.registry.getCard(waiting.id))?.waitingFor).toMatchObject({ outcome: "concluded", readyAt: expect.any(Number) });
  });

  it("espera que ficou pronta com o back fora acorda o card quando o back sobe", async () => {
    const loaded = await load();
    const { target, waiting } = await createOpenPair(loaded);
    await loaded.waits.createCardWait({ waitingCardId: waiting.id, targetCardId: target.id, instruction: "faça o complemento", createdBy: "user-1" });
    await loaded.registry.updateCard(target.id, { column: "done" });
    expect(sentScripts()).toEqual([]);
    await startWatch(loaded);
    await vi.waitFor(() => expect(sentScripts().some((script) => script.includes("faça o complemento"))).toBe(true));
  });

  it("card pausado com espera pronta não é acordado", async () => {
    const loaded = await load();
    const { target, waiting } = await createOpenPair(loaded);
    await loaded.waits.createCardWait({ waitingCardId: waiting.id, targetCardId: target.id, instruction: "faça o complemento", createdBy: "user-1" });
    await loaded.registry.updateCard(waiting.id, { column: "paused" });
    await loaded.registry.applyCardStatus(waiting.id, "waiting");
    await loaded.registry.updateCard(target.id, { column: "done" });
    expect(await loaded.waits.fireCardWait(waiting.id)).toBe("not_ready");
    expect(sentScripts()).toEqual([]);
    expect((await loaded.registry.getCard(waiting.id))?.waitingFor?.readyAt).toEqual(expect.any(Number));
  });

  it("acordar agora uma espera que ainda não está pronta não envia nada", async () => {
    const loaded = await load();
    const { target, waiting } = await createOpenPair(loaded);
    await loaded.waits.createCardWait({ waitingCardId: waiting.id, targetCardId: target.id, instruction: "x", createdBy: "user-1" });
    expect(await loaded.waits.fireCardWait(waiting.id)).toBe("not_ready");
    expect(sentScripts()).toEqual([]);
  });
});
