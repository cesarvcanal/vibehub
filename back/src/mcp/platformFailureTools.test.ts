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
});
