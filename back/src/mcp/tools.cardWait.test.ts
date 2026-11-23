import { describe, it, expect, onTestFinished, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectMcpClient } from "../testkit/mcpClient.js";
import { mockHostExecutor } from "../testkit/fakeHost.js";

vi.setConfig({ testTimeout: 30_000 });

async function load() {
  const dataDir = mkdtempSync(join(tmpdir(), "vibehub-wait-tools-"));
  onTestFinished(() => rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }));
  vi.resetModules();
  const env = await import("../config/env.js");
  env.config.dataDir = dataDir;
  mockHostExecutor(async () => ({ stdout: "", stderr: "" }));
  const registry = await import("../services/board/registry.js");
  const users = await import("../auth/users.js");
  const { createMcpServer } = await import("./server.js");
  const owner = users.publicUser(await users.createUser("cesar", "senha-forte-123", "owner"));
  const member = users.publicUser(await users.createUser("mussa", "senha-forte-456", "member"));
  const project = await registry.createProject({ name: "vibehub" });
  const waiting = await registry.createCard({ projectId: project.id, title: "Complemento" });
  const target = await registry.createCard({ projectId: project.id, title: "Captura de falhas" });
  const { call } = await connectMcpClient(createMcpServer("test"));
  return { registry, owner, member, waiting, target, call };
}

describe("vibehub_wait_for_card e vibehub_cancel_wait", () => {
  it("o card registra a espera em nome da pessoa que deu a ordem e recebe o título do card esperado", async () => {
    const env = await load();
    await env.registry.stampCardActor(env.waiting.id, env.owner.id);
    const answer = await env.call("vibehub_wait_for_card", {
      card: env.waiting.id, waitFor: env.target.id, instruction: "faça o PR complementar", base: "main",
    });
    expect(answer).toEqual({ waiting: true, waitFor: { cardId: env.target.id, title: "Captura de falhas" }, base: "main" });
    expect((await env.registry.getCard(env.waiting.id))?.waitingFor).toMatchObject({
      cardId: env.target.id, instruction: "faça o PR complementar", base: "main", createdBy: env.owner.id,
    });
  });

  it("um card que a pessoa por trás não vê responde que não existe", async () => {
    const env = await load();
    await env.registry.stampCardActor(env.waiting.id, env.member.id);
    const answer = await env.call("vibehub_wait_for_card", { card: env.waiting.id, waitFor: env.target.id, instruction: "x" });
    expect(answer.error).toMatch(/card not found/);
    expect((await env.registry.getCard(env.waiting.id))?.waitingFor).toBeUndefined();
  });

  it("sem pessoa por trás do card não há em nome de quem esperar", async () => {
    const env = await load();
    const answer = await env.call("vibehub_wait_for_card", { card: env.waiting.id, waitFor: env.target.id, instruction: "x" });
    expect(answer.error).toMatch(/nobody gave this card an order/);
  });

  it("o card cancela a própria espera e cancelar de novo avisa que não há espera", async () => {
    const env = await load();
    await env.registry.stampCardActor(env.waiting.id, env.owner.id);
    await env.call("vibehub_wait_for_card", { card: env.waiting.id, waitFor: env.target.id, instruction: "x" });
    expect(await env.call("vibehub_cancel_wait", { card: env.waiting.id })).toEqual({ cancelled: true });
    expect((await env.registry.getCard(env.waiting.id))?.waitingFor).toBeUndefined();
    expect((await env.call("vibehub_cancel_wait", { card: env.waiting.id })).error).toMatch(/no wait/);
  });
});
