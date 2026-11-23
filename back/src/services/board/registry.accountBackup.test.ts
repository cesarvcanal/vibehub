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
const BEFORE_RENEWAL = RENEWS_AT - 60_000;
const USAGE_LIMIT = { reason: "usage_limit", renewsAt: RENEWS_AT } as const;

interface ChainOptions {
  backups?: ReadonlyArray<readonly [string, string]>;
  cardAccount?: string;
  projectAccount?: string;
}

async function cardOnChain({ backups = [["albert", "cesar"], ["cesar", "mussa"]], cardAccount, projectAccount }: ChainOptions = {}) {
  const reg = await registryWithAccounts(["albert", "cesar", "mussa"]);
  for (const [accountSlug, backupAccountSlug] of backups) await reg.setAccountBackup(accountSlug, backupAccountSlug);
  const project = await reg.createProject({ name: "Shop", ...(projectAccount ? { defaultAccountSlug: projectAccount } : {}) });
  const card = await reg.createCard({ projectId: project.id, title: "Checkout" }, cardAccount ? { accountSlug: cardAccount } : {});
  return { reg, cardId: card.id };
}

describe("troca automática para a conta reserva", () => {
  it("troca o card para a reserva e guarda a conta original com o horário de renovação", async () => {
    const { reg, cardId } = await cardOnChain({ cardAccount: "albert" });

    const outcome = await reg.switchCardToBackupAccount(cardId, USAGE_LIMIT, BEFORE_RENEWAL);

    expect(outcome).toMatchObject({ outcome: "switched", from: "albert", to: "cesar", returnedToOriginal: false });
    const card = await reg.getCard(cardId);
    expect(card?.accountSlug).toBe("cesar");
    expect(card?.accountLoan).toEqual({
      originalCardAccountSlug: "albert",
      originalEffectiveAccount: "albert",
      renewsAt: RENEWS_AT,
      exhausted: [{ accountSlug: "albert", renewsAt: RENEWS_AT }],
    });
  });

  it("na cadeia o empréstimo continua apontando para a conta original", async () => {
    const { reg, cardId } = await cardOnChain({ cardAccount: "albert" });
    await reg.switchCardToBackupAccount(cardId, USAGE_LIMIT, BEFORE_RENEWAL);

    const second = await reg.switchCardToBackupAccount(cardId, { reason: "usage_limit", renewsAt: RENEWS_AT + 1 }, BEFORE_RENEWAL);

    expect(second).toMatchObject({ outcome: "switched", from: "cesar", to: "mussa" });
    expect((await reg.getCard(cardId))?.accountLoan).toMatchObject({ originalEffectiveAccount: "albert", renewsAt: RENEWS_AT });
  });

  it("todas as contas da cadeia esgotadas: não troca e diz quais esgotaram", async () => {
    const { reg, cardId } = await cardOnChain({ cardAccount: "albert" });
    await reg.switchCardToBackupAccount(cardId, USAGE_LIMIT, BEFORE_RENEWAL);
    await reg.switchCardToBackupAccount(cardId, USAGE_LIMIT, BEFORE_RENEWAL);

    const last = await reg.switchCardToBackupAccount(cardId, USAGE_LIMIT, BEFORE_RENEWAL);

    expect(last).toMatchObject({ outcome: "exhausted", exhausted: ["albert", "cesar", "mussa"], unusableDefault: false });
    expect((await reg.getCard(cardId))?.accountSlug).toBe("mussa");
  });

  it("a cadeia não devolve o card à conta original antes de ela renovar", async () => {
    const { reg, cardId } = await cardOnChain({ backups: [["albert", "cesar"], ["cesar", "albert"]], cardAccount: "albert" });
    await reg.switchCardToBackupAccount(cardId, USAGE_LIMIT, BEFORE_RENEWAL);
    await reg.clearCardBackupChain(cardId);

    const outcome = await reg.switchCardToBackupAccount(cardId, { reason: "usage_limit" }, BEFORE_RENEWAL);

    expect(outcome).toMatchObject({ outcome: "exhausted" });
    expect((await reg.getCard(cardId))?.accountSlug).toBe("cesar");
  });

  it("a cadeia que chega à conta original já renovada devolve o card a ela e encerra o empréstimo", async () => {
    const { reg, cardId } = await cardOnChain({ backups: [["albert", "cesar"], ["cesar", "albert"]], projectAccount: "albert" });
    await reg.switchCardToBackupAccount(cardId, USAGE_LIMIT, BEFORE_RENEWAL);

    const outcome = await reg.switchCardToBackupAccount(cardId, { reason: "usage_limit" }, RENEWS_AT + 1);

    expect(outcome).toMatchObject({ outcome: "switched", from: "cesar", to: "albert", returnedToOriginal: true });
    const card = await reg.getCard(cardId);
    expect(card?.accountSlug).toBeUndefined();
    expect(card?.accountLoan).toBeUndefined();
  });

  it("conta sem reserva configurada não troca", async () => {
    const { reg, cardId } = await cardOnChain({ cardAccount: "mussa" });

    await expect(reg.switchCardToBackupAccount(cardId, USAGE_LIMIT)).resolves.toEqual({ outcome: "skipped" });
    expect((await reg.getCard(cardId))?.accountLoan).toBeUndefined();
  });

  it("login que falha fora de uma troca não troca a conta", async () => {
    const { reg, cardId } = await cardOnChain({ cardAccount: "albert" });

    await expect(reg.switchCardToBackupAccount(cardId, { reason: "login" })).resolves.toEqual({ outcome: "skipped" });
    expect((await reg.getCard(cardId))?.accountSlug).toBe("albert");
  });

  it("card que herdava a conta do projeto troca e volta a herdar", async () => {
    const { reg, cardId } = await cardOnChain({ projectAccount: "albert" });
    await reg.switchCardToBackupAccount(cardId, USAGE_LIMIT, BEFORE_RENEWAL);

    const { after } = await reg.returnCardAccount(cardId);

    expect(after.accountSlug).toBeUndefined();
    expect(after.accountLoan).toBeUndefined();
  });

  it("voltar devolve a conta original mesmo depois de várias trocas", async () => {
    const { reg, cardId } = await cardOnChain({ cardAccount: "albert" });
    await reg.switchCardToBackupAccount(cardId, USAGE_LIMIT, BEFORE_RENEWAL);
    await reg.switchCardToBackupAccount(cardId, USAGE_LIMIT, BEFORE_RENEWAL);

    const { before, after } = await reg.returnCardAccount(cardId);

    expect(before.accountSlug).toBe("mussa");
    expect(after.accountSlug).toBe("albert");
  });

  it("a conta padrão que o card não consegue usar é pulada e a cadeia segue", async () => {
    const { reg, cardId } = await cardOnChain({ backups: [["albert", "default"], ["default", "mussa"]], projectAccount: "albert" });

    const outcome = await reg.switchCardToBackupAccount(cardId, USAGE_LIMIT, BEFORE_RENEWAL);

    expect(outcome).toMatchObject({ outcome: "switched", from: "albert", to: "mussa" });
    expect((await reg.getCard(cardId))?.accountSlug).toBe("mussa");
  });

  it("só a conta padrão inutilizável na cadeia: não troca e diz que foi por ela", async () => {
    const { reg, cardId } = await cardOnChain({ backups: [["albert", "default"]], projectAccount: "albert" });

    const outcome = await reg.switchCardToBackupAccount(cardId, USAGE_LIMIT, BEFORE_RENEWAL);

    expect(outcome).toMatchObject({ outcome: "exhausted", exhausted: ["albert"], unusableDefault: true });
    expect((await reg.getCard(cardId))?.accountSlug).toBeUndefined();
  });

  it("card com conta própria troca para a conta padrão do runner", async () => {
    const { reg, cardId } = await cardOnChain({ backups: [["albert", "default"]], cardAccount: "albert" });

    const outcome = await reg.switchCardToBackupAccount(cardId, USAGE_LIMIT, BEFORE_RENEWAL);

    expect(outcome).toMatchObject({ outcome: "switched", from: "albert", to: "default" });
    expect((await reg.getCard(cardId))?.accountSlug).toBeUndefined();
  });

  it("voltar num card sem empréstimo é recusado", async () => {
    const { reg, cardId } = await cardOnChain({ cardAccount: "albert" });

    await expect(reg.returnCardAccount(cardId)).rejects.toThrow(/card has no borrowed account/);
  });

  it("primeira resposta boa zera a cadeia mas mantém o empréstimo", async () => {
    const { reg, cardId } = await cardOnChain({ cardAccount: "albert" });
    await reg.switchCardToBackupAccount(cardId, USAGE_LIMIT, BEFORE_RENEWAL);

    await reg.clearCardBackupChain(cardId);

    expect((await reg.getCard(cardId))?.accountLoan).toMatchObject({ originalEffectiveAccount: "albert", exhausted: [] });
  });

  it("troca manual de conta apaga o empréstimo do card", async () => {
    const { reg, cardId } = await cardOnChain({ cardAccount: "albert" });
    await reg.switchCardToBackupAccount(cardId, USAGE_LIMIT, BEFORE_RENEWAL);

    const card = await reg.updateCard(cardId, { accountSlug: "mussa" });

    expect(card.accountLoan).toBeUndefined();
  });

  it("recusa apagar a conta original de um empréstimo", async () => {
    const { reg, cardId } = await cardOnChain({ backups: [["albert", "cesar"]], cardAccount: "albert" });
    await reg.switchCardToBackupAccount(cardId, USAGE_LIMIT, BEFORE_RENEWAL);
    await reg.setAccountBackup("albert", null);

    await expect(reg.removeAccount("albert")).rejects.toThrow(/borrowed from account 'albert'/);
  });
});
