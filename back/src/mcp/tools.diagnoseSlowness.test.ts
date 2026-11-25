import { describe, it, expect, onTestFinished, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectMcpClient } from "../testkit/mcpClient.js";
import { mockHostExecutor } from "../testkit/fakeHost.js";
import { runnerCapture } from "../testkit/runnerCapture.js";

vi.setConfig({ testTimeout: 30_000 });

async function load() {
  const dataDir = mkdtempSync(join(tmpdir(), "vibehub-diagnose-tools-"));
  onTestFinished(() => rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }));
  vi.resetModules();
  const env = await import("../config/env.js");
  env.config.dataDir = dataDir;
  const scripts: string[] = [];
  const registry = await import("../services/board/registry.js");
  const users = await import("../auth/users.js");
  const owner = users.publicUser(await users.createUser("cesar", "senha-forte-123", "owner"));
  const member = users.publicUser(await users.createUser("mussa", "senha-forte-456", "member"));
  const project = await registry.createProject({ name: "vibehub" });
  const asking = await registry.createCard({ projectId: project.id, title: "Diagnosticar demora" });
  const heavy = await registry.createCard({ projectId: project.id, title: "Testes pesados" });
  const capture = runnerCapture({
    processes: [
      { pid: 201, comm: "node (vitest 1)", ticksBefore: 0, ticksAfter: 300, startTicks: 99_000, rssPages: 256_000, cardId: heavy.id, args: "npx vitest run" },
      { pid: 202, comm: "chrome", ticksBefore: 0, ticksAfter: 2, startTicks: 10_000, rssPages: 51_200, cardId: "1b0e4c1e-0000-4000-8000-000000000000" },
    ],
  });
  mockHostExecutor(async (script) => {
    scripts.push(script);
    return { stdout: capture, stderr: "" };
  });
  const { createMcpServer } = await import("./server.js");
  const { call } = await connectMcpClient(createMcpServer("test"));
  return { registry, owner, member, asking, heavy, scripts, call };
}

describe("vibehub_diagnose_slowness", () => {
  it("o dono vê o card pesado pelo nome, os processos de card apagado e o servidor que rouba CPU, numa leitura só", async () => {
    const env = await load();
    await env.registry.stampCardActor(env.asking.id, env.owner.id);
    const answer = await env.call("vibehub_diagnose_slowness", { from: env.asking.id });
    expect(answer.findings.map((finding: { kind: string }) => finding.kind)).toEqual(
      expect.arrayContaining(["server_steal", "cpu_limit", "idle_card_busy", "orphan_processes"]),
    );
    expect(answer.cards).toEqual([expect.objectContaining({ id: env.heavy.id, title: "Testes pesados", cpuPct: 150 })]);
    expect(answer.orphans.topProcesses).toEqual([expect.objectContaining({ pid: 202, comm: "chrome" })]);
    expect(answer.machine.cpu.stealPct).toBe(44);
    expect(env.scripts).toHaveLength(1);
  });

  it("o membro vê a máquina, mas o card que não alcança vira uma soma sem nome", async () => {
    const env = await load();
    await env.registry.stampCardActor(env.asking.id, env.member.id);
    const answer = await env.call("vibehub_diagnose_slowness", { from: env.asking.id });
    expect(answer.machine.cpu.stealPct).toBe(44);
    expect(answer.cards).toEqual([]);
    expect(answer.others).toEqual({ cpuPct: 151, rssMb: 1200, processCount: 2 });
    expect(JSON.stringify(answer)).not.toContain("Testes pesados");
  });

  it("o membro vê o card que foi compartilhado com ele", async () => {
    const env = await load();
    await env.registry.stampCardActor(env.asking.id, env.member.id);
    await env.registry.shareWith({ kind: "card", targetId: env.heavy.id, userId: env.member.id, level: "view" });
    const answer = await env.call("vibehub_diagnose_slowness", { from: env.asking.id });
    expect(answer.cards.map((card: { title: string }) => card.title)).toEqual(["Testes pesados"]);
  });

  it("sem pessoa por trás do card não lê o runner", async () => {
    const env = await load();
    const answer = await env.call("vibehub_diagnose_slowness", { from: env.asking.id });
    expect(answer.error).toMatch(/nobody gave this card an order/);
    expect(env.scripts).toEqual([]);
  });
});
