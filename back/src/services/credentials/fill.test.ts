import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dir = "";
const runScript = vi.fn();

async function fresh() {
  vi.resetModules();
  runScript.mockReset();
  vi.doMock("../board/registry.js", () => ({
    getCard: vi.fn(async () => ({ id: "aabbccdd-0000-0000-0000-000000000000", projectId: "p1" })),
  }));
  vi.doMock("../../runtime/host.js", () => ({
    hostExecutor: () => ({ runScript }),
    shQuote: (s: string) => `'${s}'`,
  }));
  const env = await import("../../config/env.js");
  env.config.dataDir = dir;
  env.config.secretKey = "";
  env.config.runner.container = "vibehub-runner";
  const fill = await import("./fill.js");
  const creds = await import("./credentials.js");
  return { fill, creds };
}

beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "vibehub-fill-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); vi.restoreAllMocks(); });

describe("buildFillPlan (pure — carries no secret)", () => {
  it("userpass yields USER then PASS", async () => {
    const { fill } = await fresh();
    const plan = fill.buildFillPlan("userpass");
    expect(plan.fields.map((f) => f.ref)).toEqual(["USER", "PASS"]);
    expect(JSON.stringify(plan)).not.toMatch(/secret|password|value.*:/i);
  });

  it("token yields a single VALUE field", async () => {
    const { fill } = await fresh();
    expect(fill.buildFillPlan("token").fields.map((f) => f.ref)).toEqual(["VALUE"]);
  });

  it("honours the given selectors", async () => {
    const { fill } = await fresh();
    const plan = fill.buildFillPlan("userpass", { userSelector: "#u", passSelector: "#p" });
    expect(plan.fields).toEqual([{ ref: "USER", selector: "#u" }, { ref: "PASS", selector: "#p" }]);
    const token = fill.buildFillPlan("token", { passSelector: "#tok" });
    expect(token.fields).toEqual([{ ref: "VALUE", selector: "#tok" }]);
  });
});

describe("buildCdpHostScript (pure)", () => {
  it("embeds the base64 payload, guards the tag and the encoding", async () => {
    const { fill } = await fresh();
    const b64 = Buffer.from(JSON.stringify({ mode: "fill" })).toString("base64");
    const script = fill.buildCdpHostScript("vibehub-runner", "abc123def456", b64);
    expect(script).toContain("docker exec -i");
    expect(script).toContain(b64);
    expect(script).toContain("VIBEHUB_CDP_SCRIPT");
    expect(() => fill.buildCdpHostScript("c", "NOT-HEX", b64)).toThrow(/invalid cdp tag/);
    expect(() => fill.buildCdpHostScript("c", "abcdef12", "not base64!!")).toThrow(/invalid cdp payload/);
  });
});

describe("parseFillResult (pure)", () => {
  it("reads the last JSON line", async () => {
    const { fill } = await fresh();
    expect(fill.parseFillResult('noise\n{"filled":true,"fields":["USER","PASS"]}\n')).toEqual({
      filled: true, fields: ["USER", "PASS"],
    });
  });
  it("surfaces an error line", async () => {
    const { fill } = await fresh();
    expect(() => fill.parseFillResult('{"error":"no browser page is open in this card"}')).toThrow(/no browser page/);
  });
  it("explains a blank answer", async () => {
    const { fill } = await fresh();
    expect(() => fill.parseFillResult("")).toThrow(/did not answer/);
  });
});

describe("fillCredential — the value never leaks into the response", () => {
  it("resolves from the vault, runs the CDP program, returns only field labels", async () => {
    const { fill, creds } = await fresh();
    await creds.createCredential({ name: "erp-prod", type: "userpass", username: "ada", password: "TOPSECRET-PW" });
    runScript.mockResolvedValue({ stdout: '{"filled":true,"fields":["USER","PASS"]}\n', stderr: "" });

    const result = await fill.fillCredential("aabbccdd-0000-0000-0000-000000000000", "erp-prod", { by: "card" });
    expect(result).toEqual({ filled: true, fields: ["USER", "PASS"] });

    // The response object must NOT contain the secret or the username.
    const asText = JSON.stringify(result);
    expect(asText).not.toContain("TOPSECRET-PW");
    expect(asText).not.toContain("ada");
  });

  it("passes the secret to the runner ONLY inside the base64 payload (never as plain argv/text)", async () => {
    const { fill, creds } = await fresh();
    await creds.createCredential({ name: "space", type: "token", value: "PLAINTOKEN-XYZ" });
    runScript.mockResolvedValue({ stdout: '{"filled":true,"fields":["VALUE"]}\n', stderr: "" });

    await fill.fillCredential("aabbccdd-0000-0000-0000-000000000000", "space", { by: "card" });

    expect(runScript).toHaveBeenCalledTimes(1);
    const script: string = runScript.mock.calls[0][0];
    // The plaintext secret must never appear literally in the host script — only base64-wrapped.
    expect(script).not.toContain("PLAINTOKEN-XYZ");
    // The payload sits between the payload heredoc delimiters; decoding it recovers the secret,
    // proving it travels base64-embedded (opaque to ps/logs), not as plain text.
    const between = script.split("VIBEHUB_CDP_PAYLOAD")[1]?.trim() ?? "";
    const decoded = Buffer.from(between, "base64").toString("utf8");
    expect(decoded).toContain("PLAINTOKEN-XYZ");
  });

  it("marks the credential as used only when a fill happened", async () => {
    const { fill, creds } = await fresh();
    await creds.createCredential({ name: "erp", type: "token", value: "t" });
    runScript.mockResolvedValue({ stdout: '{"filled":false,"fields":[]}\n', stderr: "" });
    await fill.fillCredential("aabbccdd-0000-0000-0000-000000000000", "erp");
    expect((await creds.listCredentials())[0].usedAt).toBeUndefined();
  });
});
