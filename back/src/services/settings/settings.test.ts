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

  it("defaults the idle hibernation to three hours and validates what replaces it", async () => {
    const s = await fresh();
    expect((await s.getSettings()).idleHibernateMinutes).toBe(180);

    expect((await s.updateSettings({ idleHibernateMinutes: 45 })).idleHibernateMinutes).toBe(45);
    // 0 is the spelling of "never" — a valid choice, not a rejected one.
    expect((await s.updateSettings({ idleHibernateMinutes: 0 })).idleHibernateMinutes).toBe(0);

    await expect(s.updateSettings({ idleHibernateMinutes: -1 })).rejects.toThrow(/idleHibernateMinutes/);
    await expect(s.updateSettings({ idleHibernateMinutes: 10_081 })).rejects.toThrow(/idleHibernateMinutes/);
    await expect(s.updateSettings({ idleHibernateMinutes: 1.5 })).rejects.toThrow(/idleHibernateMinutes/);
    // and a rejected write changes nothing
    expect((await s.getSettings()).idleHibernateMinutes).toBe(0);
  });

  it("validates the git identity", async () => {
    const s = await fresh();
    await expect(s.updateSettings({ git: { name: "  " } })).rejects.toThrow(/cannot be empty/);
    await expect(s.updateSettings({ git: { email: "not-an-email" } })).rejects.toThrow(/valid address/);
    await expect(s.updateSettings({ git: { email: "two words@host" } })).rejects.toThrow(/valid address/);
    await expect(s.updateSettings({ git: { email: "a@b@c" } })).rejects.toThrow(/valid address/);
  });

  it("accepts the seeded default git email — a dotless host is valid for git", async () => {
    const s = await fresh();
    // Regression: the validator once required a dot in the host, so `vibehub@localhost` (the
    // seeded default) failed its OWN validation and the settings form could not save ANYTHING.
    const seeded = (await s.getSettings()).git.email;
    expect((await s.updateSettings({ git: { email: seeded } })).git.email).toBe(seeded);
    expect((await s.updateSettings({ git: { email: "cesar@localhost" } })).git.email).toBe("cesar@localhost");
    expect((await s.updateSettings({ git: { email: "ada@example.com" } })).git.email).toBe("ada@example.com");
  });

  it("normalizes an empty default account label to null", async () => {
    const s = await fresh();
    expect((await s.updateSettings({ defaultAccountLabel: "  " })).defaultAccountLabel).toBeNull();
    expect((await s.updateSettings({ defaultAccountLabel: " work " })).defaultAccountLabel).toBe("work");
  });

  it("defaults the SDK driver flag to OFF and round-trips it", async () => {
    const s = await fresh();
    expect((await s.getSettings()).sdkDriver).toBe(false);
    expect((await s.updateSettings({ sdkDriver: true })).sdkDriver).toBe(true);
    expect((await s.updateSettings({ sdkDriver: false })).sdkDriver).toBe(false);
  });

  it("rejects a non-boolean sdkDriver", async () => {
    const s = await fresh();
    // @ts-expect-error — exercising the runtime guard
    await expect(s.updateSettings({ sdkDriver: "yes" })).rejects.toThrow(/must be a boolean/);
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
