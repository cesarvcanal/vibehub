import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const runScript = vi.fn(async () => ({ stdout: "", stderr: "" }));
const sendFailure = { current: null as Error | null };
const sendToTerminal = vi.fn(async (cardId: string, _text: string) => {
  if (sendFailure.current) throw sendFailure.current;
  return { sent: true, cardId, title: "", project: "" };
});
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
});
afterEach(async () => { await rm(dirs.current, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); });

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
