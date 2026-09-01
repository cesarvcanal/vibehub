import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dir = "";

/** Fresh module graph with the data dir pointed at a temp folder, so the vault and store are clean. */
async function fresh() {
  vi.resetModules();
  vi.doMock("../board/registry.js", () => ({
    getCard: vi.fn(async () => ({ id: "card-1", projectId: "p1" })),
  }));
  const env = await import("../../config/env.js");
  env.config.dataDir = dir;
  env.config.secretKey = "";
  return await import("./credentials.js");
}

beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "vibehub-cred-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); vi.restoreAllMocks(); });

describe("credentials vault namespace round-trip", () => {
  it("stores a userpass credential and resolves both values, but never lists them", async () => {
    const c = await fresh();
    const cred = await c.createCredential({ name: "erp-prod", type: "userpass", username: "ada", password: "s3cr3t" });
    expect(cred.type).toBe("userpass");

    const resolved = await c.resolveCredential("erp-prod");
    expect(resolved.username).toBe("ada");
    expect(resolved.secret).toBe("s3cr3t");

    const list = await c.listCredentials();
    expect(list).toHaveLength(1);
    // The metadata list must NEVER carry a value.
    expect(JSON.stringify(list)).not.toContain("s3cr3t");
    expect(JSON.stringify(list)).not.toContain("ada");
  });

  it("stores a token credential and resolves the single value", async () => {
    const c = await fresh();
    await c.createCredential({ name: "space-token", type: "token", value: "tok_123" });
    const resolved = await c.resolveCredential("space-token");
    expect(resolved.username).toBeUndefined();
    expect(resolved.secret).toBe("tok_123");
  });

  it("never writes the value in plaintext to the store file", async () => {
    const c = await fresh();
    await c.createCredential({ name: "erp-prod", type: "userpass", username: "ada", password: "s3cr3t" });
    const raw = await readFile(join(dir, "credentials.json"), "utf8");
    expect(raw).not.toContain("s3cr3t");
    expect(raw).toContain("erp-prod");
  });

  it("resolves case-insensitively by name", async () => {
    const c = await fresh();
    await c.createCredential({ name: "Erp-Prod", type: "token", value: "tok" });
    expect((await c.resolveCredential("erp-prod")).secret).toBe("tok");
  });
});

describe("credentials validation and lifecycle", () => {
  it("rejects a duplicate name", async () => {
    const c = await fresh();
    await c.createCredential({ name: "dup", type: "token", value: "a" });
    await expect(c.createCredential({ name: "dup", type: "token", value: "b" })).rejects.toThrow(/already exists/);
  });

  it("rejects an invalid name and a missing value", async () => {
    const c = await fresh();
    await expect(c.createCredential({ name: "bad name!", type: "token", value: "a" })).rejects.toThrow(/invalid credential name/);
    await expect(c.createCredential({ name: "ok", type: "userpass", username: "u" })).rejects.toThrow(/password is required/);
  });

  it("delete removes the entry AND its vault values", async () => {
    const c = await fresh();
    const cred = await c.createCredential({ name: "gone", type: "userpass", username: "u", password: "p" });
    expect(await c.deleteCredential(cred.id)).toBe(true);
    expect(await c.listCredentials()).toHaveLength(0);
    await expect(c.resolveCredential("gone")).rejects.toThrow(/not in the vault/);
    // A second delete is a no-op, not an error.
    expect(await c.deleteCredential(cred.id)).toBe(false);
  });

  it("resolving a missing credential points at Settings, never asks for the value", async () => {
    const c = await fresh();
    await expect(c.resolveCredential("nope")).rejects.toThrow(/Settings . Cofre/);
  });

  it("credentialsForCard lists every credential (install-wide, no scope), names and types only", async () => {
    const c = await fresh();
    await c.createCredential({ name: "aa", type: "token", value: "1" });
    await c.createCredential({ name: "bb", type: "userpass", username: "u", password: "pw" });
    const forCard = await c.credentialsForCard("card-1");
    expect(forCard.map((x) => x.name).sort()).toEqual(["aa", "bb"]);
    expect(JSON.stringify(forCard)).not.toContain("secret");
    expect(JSON.stringify(forCard)).not.toContain("\"pw\"");
  });

  it("suggestCredentialName turns a host into a valid name", async () => {
    const c = await fresh();
    expect(c.suggestCredentialName("https://erp.multi/login")).toBe("erp.multi");
    expect(c.suggestCredentialName("www.space.com")).toBe("space.com");
    expect(c.suggestCredentialName("!!!")).toMatch(/^login-/);
  });
});
