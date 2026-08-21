import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dir = "";

async function freshVault(secretKey = "") {
  vi.resetModules();
  const env = await import("../config/env.js");
  env.config.dataDir = dir;
  env.config.secretKey = secretKey;
  return await import("./vault.js");
}

beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "vibehub-vault-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe("local vault", () => {
  it("round-trips a secret", async () => {
    const v = await freshVault();
    await v.secretSet("GITHUB_TOKEN", "ghp_abc");
    expect(await v.secretGet("GITHUB_TOKEN")).toBe("ghp_abc");
  });

  it("never stores plaintext on disk and keeps the file at 600", async () => {
    const v = await freshVault();
    await v.secretSet("CLAUDE_TOKEN", "super-secret-value");
    const raw = await readFile(join(dir, "secrets.enc"), "utf8");
    expect(raw).not.toContain("super-secret-value");
    expect((await stat(join(dir, "secrets.enc"))).mode & 0o777).toBe(0o600);
  });

  it("survives a reopen using the generated master key", async () => {
    const first = await freshVault();
    await first.secretSet("A_KEY", "value-1");
    const second = await freshVault();
    expect(await second.secretGet("A_KEY")).toBe("value-1");
  });

  it("decrypts with an explicit VIBEHUB_SECRET_KEY", async () => {
    const first = await freshVault("passphrase-from-env");
    await first.secretSet("A_KEY", "value-1");
    const second = await freshVault("passphrase-from-env");
    expect(await second.secretGet("A_KEY")).toBe("value-1");
  });

  it("fails loudly when the master key is wrong", async () => {
    const first = await freshVault("right-key");
    await first.secretSet("A_KEY", "value-1");
    const second = await freshVault("wrong-key");
    await expect(second.secretGet("A_KEY")).rejects.toThrow(/vault/i);
  });

  it("rejects invalid keys and empty values", async () => {
    const v = await freshVault();
    await expect(v.secretSet("lower_case", "x")).rejects.toThrow(/invalid secret key/);
    await expect(v.secretSet("OK_KEY", "")).rejects.toThrow(/cannot be empty/);
  });

  it("ensure creates once and then returns the stored value", async () => {
    const v = await freshVault();
    const a = await v.secretEnsure("RUNNER_TOKEN", () => "first");
    const b = await v.secretEnsure("RUNNER_TOKEN", () => "second");
    expect([a, b]).toEqual(["first", "first"]);
  });

  it("lists keys without values and deletes", async () => {
    const v = await freshVault();
    await v.secretSet("B_KEY", "b");
    await v.secretSet("A_KEY", "a");
    const list = await v.secretList();
    expect(list.map((s) => s.key)).toEqual(["A_KEY", "B_KEY"]);
    expect(JSON.stringify(list)).not.toContain("\"a\"");
    expect(await v.secretDelete("A_KEY")).toBe(true);
    expect(await v.secretDelete("A_KEY")).toBe(false);
  });

  it("serializes concurrent writes", async () => {
    const v = await freshVault();
    await Promise.all(Array.from({ length: 20 }, (_, i) => v.secretSet(`K${i}`, `v${i}`)));
    expect(await v.secretList()).toHaveLength(20);
  });
});
