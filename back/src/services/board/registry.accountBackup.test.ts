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

const RENEWS_AT = 1_800_000_000_000;

async function cardOnChain(options: { cardAccount?: string; projectAccount?: string } = {}) {
  const reg = await registryWithAccounts(["albert", "cesar", "mussa"]);
  await reg.setAccountBackup("albert", "cesar");
  await reg.setAccountBackup("cesar", "mussa");
  const project = await reg.createProject({ name: "Shop", ...(options.projectAccount ? { defaultAccountSlug: options.projectAccount } : {}) });
  const card = await reg.createCard({ projectId: project.id, title: "Checkout" }, options.cardAccount ? { accountSlug: options.cardAccount } : {});
  return { reg, cardId: card.id };
}

describe("troca automática para a conta reserva", () => {
  it("troca o card para a reserva e guarda a conta original com o horário de renovação", async () => {
    const { reg, cardId } = await cardOnChain({ cardAccount: "albert" });

    const outcome = await reg.switchCardToBackupAccount(cardId, { account: "albert", renewsAt: RENEWS_AT });

    expect(outcome).toMatchObject({ outcome: "switched", from: "albert", to: "cesar" });
    const card = await reg.getCard(cardId);
    expect(card?.accountSlug).toBe("cesar");
    expect(card?.accountLoan).toEqual({
      originalAccountSlug: "albert",
      originalAccount: "albert",
      renewsAt: RENEWS_AT,
      exhausted: [{ account: "albert", renewsAt: RENEWS_AT }],
    });
  });

  it("segunda recusa do mesmo turno não troca de novo", async () => {
    const { reg, cardId } = await cardOnChain({ cardAccount: "albert" });
    await reg.switchCardToBackupAccount(cardId, { account: "albert", renewsAt: RENEWS_AT });

    const repeated = await reg.switchCardToBackupAccount(cardId, { account: "albert", renewsAt: RENEWS_AT });

    expect(repeated).toEqual({ outcome: "superseded" });
    expect((await reg.getCard(cardId))?.accountSlug).toBe("cesar");
  });

  it("na cadeia o empréstimo continua apontando para a conta original", async () => {
    const { reg, cardId } = await cardOnChain({ cardAccount: "albert" });
    await reg.switchCardToBackupAccount(cardId, { account: "albert", renewsAt: RENEWS_AT });

    const second = await reg.switchCardToBackupAccount(cardId, { account: "cesar", renewsAt: RENEWS_AT + 1 });

    expect(second).toMatchObject({ outcome: "switched", from: "cesar", to: "mussa" });
    const card = await reg.getCard(cardId);
    expect(card?.accountLoan).toMatchObject({ originalAccount: "albert", renewsAt: RENEWS_AT });
  });

  it("todas as contas da cadeia esgotadas: não troca e diz quais esgotaram", async () => {
    const { reg, cardId } = await cardOnChain({ cardAccount: "albert" });
    await reg.switchCardToBackupAccount(cardId, { account: "albert", renewsAt: RENEWS_AT });
    await reg.switchCardToBackupAccount(cardId, { account: "cesar", renewsAt: RENEWS_AT });

    const last = await reg.switchCardToBackupAccount(cardId, { account: "mussa", renewsAt: RENEWS_AT });

    expect(last).toEqual({ outcome: "exhausted", exhausted: ["albert", "cesar", "mussa"] });
    expect((await reg.getCard(cardId))?.accountSlug).toBe("mussa");
  });

  it("conta sem reserva configurada não troca", async () => {
    const { reg, cardId } = await cardOnChain({ cardAccount: "mussa" });

    await expect(reg.switchCardToBackupAccount(cardId, { account: "mussa" })).resolves.toEqual({ outcome: "noBackup" });
    expect((await reg.getCard(cardId))?.accountLoan).toBeUndefined();
  });

  it("card que herdava a conta do projeto troca e volta a herdar", async () => {
    const { reg, cardId } = await cardOnChain({ projectAccount: "albert" });
    await reg.switchCardToBackupAccount(cardId, { account: "albert", renewsAt: RENEWS_AT });

    const { after } = await reg.returnCardAccount(cardId);

    expect(after.accountSlug).toBeUndefined();
    expect(after.accountLoan).toBeUndefined();
  });

  it("voltar devolve a conta original mesmo depois de várias trocas", async () => {
    const { reg, cardId } = await cardOnChain({ cardAccount: "albert" });
    await reg.switchCardToBackupAccount(cardId, { account: "albert", renewsAt: RENEWS_AT });
    await reg.switchCardToBackupAccount(cardId, { account: "cesar", renewsAt: RENEWS_AT });

    const { before, after } = await reg.returnCardAccount(cardId);

    expect(before.accountSlug).toBe("mussa");
    expect(after.accountSlug).toBe("albert");
  });

  it("reserva na conta padrão com o projeto em outra conta não tem como ser gravada no card: cadeia esgotada", async () => {
    const reg = await registryWithAccounts(["albert"]);
    await reg.setAccountBackup("albert", "default");
    const project = await reg.createProject({ name: "Shop", defaultAccountSlug: "albert" });
    const card = await reg.createCard({ projectId: project.id, title: "Checkout" });

    const outcome = await reg.switchCardToBackupAccount(card.id, { account: "albert" });

    expect(outcome).toEqual({ outcome: "exhausted", exhausted: ["albert"] });
    expect((await reg.getCard(card.id))?.accountSlug).toBeUndefined();
  });

  it("card com conta própria troca para a conta padrão do runner", async () => {
    const reg = await registryWithAccounts(["albert"]);
    await reg.setAccountBackup("albert", "default");
    const project = await reg.createProject({ name: "Shop" });
    const card = await reg.createCard({ projectId: project.id, title: "Checkout" }, { accountSlug: "albert" });

    const outcome = await reg.switchCardToBackupAccount(card.id, { account: "albert" });

    expect(outcome).toMatchObject({ outcome: "switched", from: "albert", to: "default" });
    expect((await reg.getCard(card.id))?.accountSlug).toBeUndefined();
  });

  it("voltar num card sem empréstimo é recusado", async () => {
    const { reg, cardId } = await cardOnChain({ cardAccount: "albert" });

    await expect(reg.returnCardAccount(cardId)).rejects.toThrow(/card has no borrowed account/);
  });

  it("primeira resposta boa zera a cadeia mas mantém o empréstimo", async () => {
    const { reg, cardId } = await cardOnChain({ cardAccount: "albert" });
    await reg.switchCardToBackupAccount(cardId, { account: "albert", renewsAt: RENEWS_AT });

    await reg.clearCardFallbackChain(cardId);

    expect((await reg.getCard(cardId))?.accountLoan).toMatchObject({ originalAccount: "albert", exhausted: [] });
  });

  it("troca manual de conta apaga o empréstimo do card", async () => {
    const { reg, cardId } = await cardOnChain({ cardAccount: "albert" });
    await reg.switchCardToBackupAccount(cardId, { account: "albert", renewsAt: RENEWS_AT });

    const card = await reg.updateCard(cardId, { accountSlug: "mussa" });

    expect(card.accountLoan).toBeUndefined();
  });

  it("recusa apagar a conta original de um empréstimo", async () => {
    const reg = await registryWithAccounts(["albert", "cesar"]);
    await reg.setAccountBackup("albert", "cesar");
    const project = await reg.createProject({ name: "Shop" });
    const card = await reg.createCard({ projectId: project.id, title: "Checkout" }, { accountSlug: "albert" });
    await reg.switchCardToBackupAccount(card.id, { account: "albert" });
    await reg.setAccountBackup("albert", null);

    await expect(reg.removeAccount("albert")).rejects.toThrow(/borrowed from account 'albert'/);
  });
});
