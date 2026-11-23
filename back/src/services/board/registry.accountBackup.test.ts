import { describe, it, expect, vi, onTestFinished } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function freshRegistry() {
  const dir = await mkdtemp(join(tmpdir(), "vibehub-account-backup-"));
  onTestFinished(() => rm(dir, { recursive: true, force: true }));
  vi.resetModules();
  const env = await import("../../config/env.js");
  env.config.dataDir = dir;
  return await import("./registry.js");
}

type Registry = Awaited<ReturnType<typeof freshRegistry>>;

async function registryWithAccounts(names: readonly string[]): Promise<Registry> {
  const reg = await freshRegistry();
  for (const name of names) await reg.createAccount({ name });
  return reg;
}

describe("reserva de conta", () => {
  it("grava e limpa a reserva de uma conta nomeada", async () => {
    const reg = await registryWithAccounts(["albert", "cesar"]);

    await expect(reg.setAccountBackup("albert", "cesar")).resolves.toEqual({ accountSlug: "albert", backupAccountSlug: "cesar" });
    const withBackup = await reg.listAccounts();
    expect(withBackup.find((account) => account.slug === "albert")?.backupAccountSlug).toBe("cesar");

    await reg.setAccountBackup("albert", null);
    const cleared = await reg.listAccounts();
    expect(cleared.find((account) => account.slug === "albert")).not.toHaveProperty("backupAccountSlug");
  });

  it("grava a reserva da conta padrão em config", async () => {
    const reg = await registryWithAccounts(["albert"]);

    await reg.setAccountBackup("default", "albert");

    expect((await reg.getConfig()).defaultAccountBackup).toBe("albert");
    await reg.setAccountBackup("default", null);
    expect(await reg.getConfig()).not.toHaveProperty("defaultAccountBackup");
  });

  it("uma conta nomeada pode ter a conta padrão como reserva", async () => {
    const reg = await registryWithAccounts(["albert"]);

    await reg.setAccountBackup("albert", "default");

    expect((await reg.readAccountBackups()).get("albert")).toBe("default");
  });

  it.each([
    ["reserva inexistente", "albert", "ghost", /account not found/],
    ["conta de origem inexistente", "ghost", "albert", /account not found/],
    ["reserva igual à própria conta", "albert", "albert", /an account cannot be its own backup/],
    ["a conta padrão como reserva dela mesma", "default", "default", /an account cannot be its own backup/],
  ])("recusa %s", async (_case, accountSlug, backupAccountSlug, error) => {
    const reg = await registryWithAccounts(["albert"]);

    await expect(reg.setAccountBackup(accountSlug, backupAccountSlug)).rejects.toThrow(error);
  });

  it("lê a reserva de cada conta, inclusive a da conta padrão", async () => {
    const reg = await registryWithAccounts(["albert", "cesar"]);
    await reg.setAccountBackup("albert", "cesar");
    await reg.setAccountBackup("default", "albert");

    const backups = await reg.readAccountBackups();

    expect([...backups.entries()].sort()).toEqual([["albert", "cesar"], ["default", "albert"]]);
  });

  it("recusa apagar conta que é reserva de outra", async () => {
    const reg = await registryWithAccounts(["albert", "cesar"]);
    await reg.setAccountBackup("albert", "cesar");

    await expect(reg.removeAccount("cesar")).rejects.toThrow(/is the backup of albert/);
  });

  it("recusa apagar conta que é reserva da conta padrão", async () => {
    const reg = await registryWithAccounts(["cesar"]);
    await reg.setAccountBackup("default", "cesar");

    await expect(reg.removeAccount("cesar")).rejects.toThrow(/is the backup of default/);
  });
});
