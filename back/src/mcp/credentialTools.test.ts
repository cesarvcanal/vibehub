import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

/**
 * The Cofre WRITE tools end to end over MCP: what an agent sends and what it gets back. The point
 * under test is the invariant — no response ever carries a secret, and nothing is written unless
 * the owner opted the card's project in.
 */

let dir = "";

async function connect() {
  vi.resetModules();
  vi.doMock("../services/board/registry.js", () => ({
    getCard: vi.fn(async (id: string) => (id === "card-1" ? { id, projectId: "p1" } : undefined)),
  }));
  const env = await import("../config/env.js");
  env.config.dataDir = dir;
  env.config.secretKey = "";
  const creds = await import("../services/credentials/credentials.js");
  const capture = await import("../services/credentials/capture.js");
  capture.resetCaptureForTesting();
  const { registerCredentialTools } = await import("./credentialTools.js");
  const server = new McpServer({ name: "t", version: "1" });
  registerCredentialTools(server, "card");
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "agent", version: "1" });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  const call = async (name: string, args: Record<string, unknown>) => {
    const res = await client.callTool({ name, arguments: args });
    const text = (res.content as { type: string; text: string }[])[0]!.text;
    return { text, json: JSON.parse(text) as Record<string, any> };
  };
  return { client, call, creds, capture };
}

beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "vibehub-credtools-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); vi.restoreAllMocks(); });

describe("Cofre write tools over MCP", () => {
  it("are registered, and no tool takes a password as input", async () => {
    const { client } = await connect();
    const tools = (await client.listTools()).tools;
    const names = tools.map((t) => t.name);
    for (const n of ["vibehub_credential_generate", "vibehub_credential_captures", "vibehub_credential_save_capture"]) {
      expect(names).toContain(n);
    }
    for (const t of tools) {
      const props = Object.keys((t.inputSchema as { properties?: object }).properties ?? {});
      expect(props.filter((p) => /pass(word)?$|secret|^value$/i.test(p))).toEqual([]);
    }
  });

  it("generate is refused (with guidance, no write) until the project is opted in", async () => {
    const { call, creds } = await connect();
    const { json } = await call("vibehub_credential_generate", { card: "card-1", name: "erp-dev-admin", username: "admin-dev" });
    expect(json.error).toMatch(/Settings . Cofre/);
    expect(await creds.listCredentials()).toHaveLength(0);
  });

  it("generate stores the credential and the response never carries the password", async () => {
    const { call, creds } = await connect();
    await creds.setAgentWriteProjects(["p1"]);
    const { text, json } = await call("vibehub_credential_generate", { card: "card-1", name: "erp-dev-admin", username: "admin-dev", length: 40 });
    expect(json.generated).toBe(true);
    expect(json.credential).toMatchObject({ name: "erp-dev-admin", type: "userpass" });
    const stored = await creds.resolveCredential("erp-dev-admin");
    expect(stored.secret).toHaveLength(40);
    expect(text).not.toContain(stored.secret);
    expect(text).not.toContain("admin-dev");
    // The new credential is immediately visible to the list/fill path, by name.
    const list = await call("vibehub_credential_list", { card: "card-1" });
    expect(list.json.credentials).toEqual([{ name: "erp-dev-admin", type: "userpass" }]);
  });

  it("generate rejects a too-short length at the schema", async () => {
    const { client, creds } = await connect();
    await creds.setAgentWriteProjects(["p1"]);
    const res = await client.callTool({ name: "vibehub_credential_generate", arguments: { card: "card-1", name: "x1", length: 8 } });
    expect(res.isError).toBe(true);
    expect(await creds.listCredentials()).toHaveLength(0);
  });

  it("captures + save_capture: list without the password, save by id", async () => {
    const { call, creds, capture } = await connect();
    await creds.setAgentWriteProjects(["p1"]);
    capture.recordCapture("card-1", { url: "https://erp.multi/login", username: "ada", password: "s3cr3t" });
    const listed = await call("vibehub_credential_captures", { card: "card-1" });
    expect(listed.text).not.toContain("s3cr3t");
    const id = listed.json.captures[0].id as string;
    const saved = await call("vibehub_credential_save_capture", { card: "card-1", captureId: id, name: "erp-multi" });
    expect(saved.text).not.toContain("s3cr3t");
    expect(saved.json.credential).toMatchObject({ name: "erp-multi", type: "userpass" });
    expect((await creds.resolveCredential("erp-multi")).secret).toBe("s3cr3t");
  });
});
