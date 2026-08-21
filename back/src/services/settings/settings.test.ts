import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dir = "";

async function fresh() {
  vi.resetModules();
  const env = await import("../../config/env.js");
  env.config.dataDir = dir;
  return await import("./settings.js");
}

beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "vibehub-settings-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe("settings", () => {
  it("starts from defaults on a fresh install", async () => {
    const s = await fresh();
    const settings = await s.getSettings();
    expect(settings.autonomous).toBe(true);
    expect(settings.setupCompletedAt).toBeNull();
    expect(settings.git.name).toBeTruthy();
  });

  it("applies a partial update without clobbering the rest", async () => {
    const s = await fresh();
    await s.updateSettings({ git: { name: "Ada Lovelace" } });
    const settings = await s.updateSettings({ autonomous: false });
    expect(settings.git.name).toBe("Ada Lovelace");
    expect(settings.autonomous).toBe(false);
  });

  it("validates the git identity", async () => {
    const s = await fresh();
    await expect(s.updateSettings({ git: { name: "  " } })).rejects.toThrow(/cannot be empty/);
    await expect(s.updateSettings({ git: { email: "not-an-email" } })).rejects.toThrow(/valid address/);
  });

  it("normalizes an empty default account label to null", async () => {
    const s = await fresh();
    expect((await s.updateSettings({ defaultAccountLabel: "  " })).defaultAccountLabel).toBeNull();
    expect((await s.updateSettings({ defaultAccountLabel: " work " })).defaultAccountLabel).toBe("work");
  });

  it("stamps setup completion once — the first timestamp wins", async () => {
    const s = await fresh();
    const first = await s.markSetupCompleted();
    const second = await s.markSetupCompleted();
    expect(second.setupCompletedAt).toBe(first.setupCompletedAt);
  });

  it("survives a reopen and fills fields added by later versions", async () => {
    const first = await fresh();
    await first.updateSettings({ git: { email: "ada@example.com" } });
    const second = await fresh();
    const settings = await second.getSettings();
    expect(settings.git.email).toBe("ada@example.com");
    expect(settings.autonomous).toBe(true);
  });
});
