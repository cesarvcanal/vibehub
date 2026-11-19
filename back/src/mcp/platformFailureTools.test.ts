import { describe, it, expect, afterEach, onTestFinished, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

async function connect({ configured = true } = {}) {
  vi.resetModules();
  const dataDir = await mkdtemp(join(tmpdir(), "vibehub-platform-tools-"));
  onTestFinished(() => rm(dataDir, { recursive: true, force: true }));
  vi.doMock("../services/board/registry.js", () => ({
    getCard: vi.fn(async (id: string) => (id === "card-1" ? { id, projectId: "p-erp" } : undefined)),
  }));
  const env = await import("../config/env.js");
  env.config.dataDir = dataDir;
  if (configured) await (await import("../services/settings/settings.js")).updateSettings({ selfProjectId: "p-vibehub" });
  const failures = await import("../services/platformFailures/platformFailures.js");
  const { registerPlatformFailureTools } = await import("./platformFailureTools.js");
  const server = new McpServer({ name: "t", version: "1" });
  registerPlatformFailureTools(server);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "agent", version: "1" });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  const call = async (args: Record<string, unknown>) => {
    const response = await client.callTool({ name: "vibehub_report_platform_failure", arguments: args });
    const text = (response.content as { type: string; text: string }[])[0]!.text;
    const parsed = (() => {
      try {
        return JSON.parse(text) as Record<string, any>;
      } catch {
        return { schemaError: text };
      }
    })();
    return { isError: response.isError === true, json: parsed };
  };
  return { client, call, failures };
}

const REPORT = {
  card: "card-1", kind: "tool_error", component: "vibehub_deliver",
  symptom: "deliver respondeu merged sem PR", evidence: "resposta: { merged: true, prUrl: null }",
  explanation: "A entrega disse que tinha publicado a mudança, mas nenhum pedido de revisão foi aberto.",
};

afterEach(() => { vi.doUnmock("../services/board/registry.js"); });

describe("vibehub_report_platform_failure", () => {
  it("registra o relato do agente com o card afetado", async () => {
    const { call, failures } = await connect();
    expect((await call(REPORT)).json).toMatchObject({ recorded: true, occurrences: 1 });
    expect(await failures.listActivePlatformFailures()).toEqual([
      expect.objectContaining({ source: "agent_report", component: "vibehub_deliver", affectedCardIds: ["card-1"] }),
    ]);
  });

  it("mascara token que o agente pôs na evidência", async () => {
    const { call, failures } = await connect();
    await call({ ...REPORT, evidence: `git disse: x-access-token:${"z".repeat(40)}@github.com` });
    expect((await failures.listActivePlatformFailures())[0]!.evidence).not.toContain("z".repeat(40));
  });

  it("mascara token que o agente pôs no componente", async () => {
    const { call, failures } = await connect();
    await call({ ...REPORT, component: `ghp_${"A".repeat(36)}` });
    expect((await failures.listActivePlatformFailures())[0]!.component).not.toContain("A".repeat(36));
  });

  it("sem projeto do vibehub configurado, recusa dizendo onde configurar", async () => {
    const { call } = await connect({ configured: false });
    expect((await call(REPORT)).json.error).toMatch(/Settings/);
  });

  it("lentidão sem medição é recusada", async () => {
    const { call, failures } = await connect();
    expect((await call({ ...REPORT, kind: "measured_slowness" })).json.error).toMatch(/measuredMs/);
    expect(await failures.listActivePlatformFailures()).toEqual([]);
  });

  it("card que não existe é recusado", async () => {
    const { call } = await connect();
    expect((await call({ ...REPORT, card: "ghost" })).json.error).toMatch(/card/);
  });

  it("relato sem evidência é recusado no schema", async () => {
    const { call } = await connect();
    expect((await call({ ...REPORT, evidence: "" })).isError).toBe(true);
  });

  it("relato sem explicação leiga é recusado no schema", async () => {
    const { call } = await connect();
    const { explanation: _explanation, ...withoutExplanation } = REPORT;
    expect((await call(withoutExplanation)).isError).toBe(true);
  });

  it("registra a queixa do usuário com a explicação leiga e o card de origem", async () => {
    const { call, failures } = await connect();
    const complaint = {
      ...REPORT,
      kind: "user_report",
      component: "usage-meter",
      symptom: "medidor semanal mostra a conta Claude anterior",
      evidence: "a pessoa disse: está 57% mas troquei de conta; GET /api/usage devolve 3% para a conta nova",
      explanation: "O medidor de uso no topo do card mostrou o consumo da conta Claude anterior depois da troca de conta.",
      hypothesis: "cache do front",
    };
    expect((await call(complaint)).json).toMatchObject({ recorded: true });
    expect(await failures.listActivePlatformFailures()).toEqual([expect.objectContaining({
      symptom: "user_report: medidor semanal mostra a conta Claude anterior",
      explanation: complaint.explanation,
      originCardId: "card-1",
    })]);
  });

  it("aceita inconsistência que o próprio agente notou", async () => {
    const { call } = await connect();
    expect((await call({ ...REPORT, kind: "inconsistency" })).json).toMatchObject({ recorded: true });
  });

  it("mascara token que o agente pôs na explicação", async () => {
    const { call, failures } = await connect();
    await call({ ...REPORT, explanation: `use o token ghp_${"B".repeat(36)}` });
    expect((await failures.listActivePlatformFailures())[0]!.explanation).not.toContain("B".repeat(36));
  });

  it("relato de falha que o dono já descartou responde dismissed", async () => {
    const { call, failures } = await connect();
    await call(REPORT);
    await failures.dismissPlatformFailure((await failures.listActivePlatformFailures())[0]!.id);
    expect((await call(REPORT)).json).toEqual({ recorded: false, reason: "dismissed" });
  });

  it("com o teto de falhas ativas cheio, responde cap", async () => {
    const { call, failures } = await connect();
    for (const index of Array.from({ length: failures.ACTIVE_FAILURES_CAP }, (_unused, position) => position)) {
      await call({ ...REPORT, component: `part-${String.fromCharCode(97 + (index % 26))}${Math.floor(index / 26)}` });
    }
    expect((await call({ ...REPORT, component: "brand-new" })).json).toEqual({ recorded: false, reason: "cap" });
  });
});
