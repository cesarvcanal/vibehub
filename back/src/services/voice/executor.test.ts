import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const runScript = vi.fn(async () => ({ stdout: "", stderr: "" }));
const sendFailure = { current: null as Error | null };
const sendToTerminal = vi.fn<(cardId: string, text: string, opts?: object) => Promise<{ sent: boolean; cardId: string; title: string; project: string }>>(async (cardId) => {
  if (sendFailure.current) throw sendFailure.current;
  return { sent: true, cardId, title: "", project: "" };
});
const opening = { hang: false };
const openCard = vi.fn(async (cardId: string) => {
  if (opening.hang) await new Promise(() => undefined);
  return { id: cardId };
});
const prepareCard = vi.fn(async () => undefined);
const dirs = { current: "" };

async function load() {
  vi.resetModules();
  const env = await import("../../config/env.js");
  env.config.dataDir = dirs.current;
  env.config.runner.container = "vibehub-runner";
  vi.doMock("../../runtime/host.js", async () => {
    const actual = await vi.importActual<typeof import("../../runtime/host.js")>("../../runtime/host.js");
    return { ...actual, hostExecutor: () => ({ kind: "local", label: "test", runScript, ptyCommand: vi.fn(), pipeCommand: vi.fn((line: string) => ({ file: "sh", args: ["-c", line] })) }) };
  });
  vi.doMock("../maestro/maestro.js", async () => ({
    ...(await vi.importActual<typeof import("../maestro/maestro.js")>("../maestro/maestro.js")),
    sendToTerminal,
    waitTerminalReady: vi.fn(async () => ({ ready: true })),
  }));
  vi.doMock("../board/workspace.js", async () => ({
    ...(await vi.importActual<typeof import("../board/workspace.js")>("../board/workspace.js")),
    openCard,
    prepareCard,
  }));
  const registry = await import("../board/registry.js");
  const users = await import("../../auth/users.js");
  const events = await import("../events/cardEvents.js");
  const executor = await import("./executor.js");
  const owner = users.publicUser(await users.createUser("cesar", "senha-forte-123", "owner"));
  const member = users.publicUser(await users.createUser("mussa", "senha-forte-456", "member"));
  const project = await registry.createProject({ name: "erp" });
  const callCard = await registry.createCard({ projectId: project.id, title: "chamada" });
  const otherCard = await registry.createCard({ projectId: project.id, title: "outro" });
  const run = (user: typeof owner, name: string, args: unknown) =>
    executor.runVoiceAction({ user, callCard, name, argumentsJson: typeof args === "string" ? args : JSON.stringify(args) });
  return { registry, events, executor, owner, member, project, callCard, otherCard, run };
}

beforeAll(async () => {
  dirs.current = await mkdtemp(join(tmpdir(), "vibehub-voice-executor-warmup-"));
  await load();
  await rm(dirs.current, { recursive: true, force: true });
}, 60_000);

beforeEach(async () => {
  dirs.current = await mkdtemp(join(tmpdir(), "vibehub-voice-executor-"));
  runScript.mockClear();
  sendToTerminal.mockClear();
  sendFailure.current = null;
  openCard.mockClear();
  prepareCard.mockClear();
  opening.hang = false;
});
afterEach(async () => { vi.useRealTimers(); await rm(dirs.current, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); });

describe("executor da voz", () => {
  it("cria o card como o dono da chamada e já entrega a primeira instrução, acordando o card", async () => {
    const env = await load();
    const output = await env.run(env.owner, "create_card", {
      projectId: env.project.id, title: "Exportar relatório", instruction: "Exporte o relatório de vendas em CSV.",
    }) as { cardId: string; delivered: boolean };
    const created = await env.registry.getCard(output.cardId);
    expect(created?.title).toBe("Exportar relatório");
    expect(created?.projectId).toBe(env.project.id);
    expect(output.delivered).toBe(true);
    expect(sendToTerminal).toHaveBeenCalledTimes(1);
    expect(sendToTerminal.mock.calls[0]?.slice(0, 2)).toEqual([output.cardId, "Exporte o relatório de vendas em CSV."]);
    expect(sendToTerminal.mock.calls[0]?.[2]).toMatchObject({ by: env.owner.id, wake: true });
  });

  it("cria o card provisionando o workspace uma vez só: a abertura, e a entrega encontra o card já vivo", async () => {
    const env = await load();
    await env.run(env.owner, "create_card", { projectId: env.project.id, title: "Exportar relatório", instruction: "Exporte o relatório." });
    expect(openCard).toHaveBeenCalledTimes(1);
    expect(prepareCard).not.toHaveBeenCalled();
    expect(sendToTerminal).toHaveBeenCalledTimes(1);
  });

  it("card que ainda prepara o workspace depois do limite da abertura volta sem entregar, dizendo para reenviar com send_to_card", async () => {
    const env = await load();
    opening.hang = true;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const pending = env.run(env.owner, "create_card", { projectId: env.project.id, title: "Exportar relatório", instruction: "Exporte o relatório." });
    await vi.waitFor(() => expect(openCard).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(20_000);
    const output = await pending as { cardId: string; delivered: boolean; deliveryError: string };
    expect(output).toMatchObject({ opened: false, delivered: false, deliveryError: expect.stringContaining("send_to_card") });
    expect((await env.registry.getCard(output.cardId))?.title).toBe("Exportar relatório");
    expect(sendToTerminal).not.toHaveBeenCalled();
  });

  it("as instruções e a ferramenta dizem à voz o que fazer com delivered: false: contar, reenviar por send_to_card e não criar outro card", async () => {
    const env = await load();
    const instructions = env.executor.executorInstructions({ cardTitle: "chamada", projectName: "erp" });
    const createCard = env.executor.voiceToolDefinitions().find((tool) => tool.name === "create_card")!;
    for (const text of [instructions, createCard.description]) {
      expect(text).toContain("delivered: false");
      expect(text).toContain("send_to_card");
    }
    expect(instructions).toContain("deliveryError");
    expect(instructions).toMatch(/Nunca chame create_card de novo/);
  });

  it("card criado com a instrução que não chegou diz isso na saída, com o motivo, sem esconder o card criado", async () => {
    const env = await load();
    sendFailure.current = new Error("runner fora do ar");
    const output = await env.run(env.owner, "create_card", {
      projectId: env.project.id, title: "Exportar relatório", instruction: "Exporte o relatório.",
    }) as { cardId: string; delivered: boolean; deliveryError: string };
    expect(output).toMatchObject({ delivered: false, deliveryError: "runner fora do ar" });
    expect((await env.registry.getCard(output.cardId))?.title).toBe("Exportar relatório");
  });

  it("recusa mandar mensagem ao próprio card da chamada", async () => {
    const env = await load();
    const refusal = env.run(env.owner, "send_to_card", { cardId: env.callCard.id, text: "faça X" });
    await expect(refusal).rejects.toMatchObject({ status: 400, message: expect.stringContaining("ask_card_agent") });
  });

  it("recusa mover o próprio card da chamada", async () => {
    const env = await load();
    const refusal = env.run(env.owner, "move_cards", { cards: [env.otherCard.id, env.callCard.id], column: "done" });
    await expect(refusal).rejects.toMatchObject({ status: 400 });
    expect((await env.registry.getCard(env.otherCard.id))?.column).not.toBe("done");
  });

  it("move outro card para concluído", async () => {
    const env = await load();
    const output = await env.run(env.owner, "move_cards", { cards: [env.otherCard.id], column: "done" }) as { moved: number };
    expect(output.moved).toBe(1);
    expect((await env.registry.getCard(env.otherCard.id))?.column).toBe("done");
  });

  it("membro sem alcance não vê o card alvo", async () => {
    const env = await load();
    const refusal = env.run(env.member, "send_to_card", { cardId: env.otherCard.id, text: "faça X" });
    await expect(refusal).rejects.toMatchObject({ status: 404, message: "card not found" });
  });

  it("membro não cria card", async () => {
    const env = await load();
    const refusal = env.run(env.member, "create_card", { projectId: env.project.id, title: "x", instruction: "faça X" });
    await expect(refusal).rejects.toMatchObject({ status: 403, message: expect.stringContaining("only the owner") });
  });

  it("notify registra o aviso no card da chamada", async () => {
    const env = await load();
    const output = await env.run(env.owner, "notify", { type: "info", text: "deploy às 18h" }) as { eventId: string };
    const recorded = (await env.events.eventsAfter(0)).events.find((event) => event.id === output.eventId);
    expect(recorded).toMatchObject({ cardId: env.callCard.id, messageType: "info", text: "deploy às 18h" });
  });

  it("lista só os projetos que o usuário alcança", async () => {
    const env = await load();
    expect(await env.run(env.member, "list_projects", {})).toMatchObject({ canCreateCards: false, projects: [] });
    expect(await env.run(env.owner, "list_projects", {})).toMatchObject({ projects: [{ id: env.project.id, name: "erp" }] });
  });

  it.each([
    ["nome desconhecido", "delete_all", "{}"],
    ["JSON inválido", "create_card", "{"],
    ["campo faltando", "create_card", '{"title":"x","instruction":"faça X"}'],
    ["card sem instrução", "create_card", '{"projectId":"p","title":"x"}'],
    ["instrução vazia", "create_card", '{"projectId":"p","title":"x","instruction":"  "}'],
    ["ask_card_agent é do navegador", "ask_card_agent", '{"request":"x"}'],
  ])("%s vira 400", async (_case, name, argumentsJson) => {
    const env = await load();
    await expect(env.run(env.owner, name, argumentsJson)).rejects.toMatchObject({ status: 400 });
  });

  it("cada ferramenta tem o mesmo nome no esquema e na lista", async () => {
    const { executor } = await load();
    expect(executor.voiceToolDefinitions().map((tool) => tool.name)).toEqual([...executor.VOICE_TOOL_NAMES]);
  });

  it("o esquema de cada ferramenta só exige campos que a validação conhece", async () => {
    const { executor } = await load();
    for (const tool of executor.voiceToolDefinitions()) {
      const known = Object.keys(tool.parameters.properties);
      for (const field of tool.parameters.required) expect(known, `${tool.name}.${field}`).toContain(field);
    }
  });
});
