import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The identity a person commits and pushes with. The point of most of these is the FALLBACK: a half
 * filled record must keep inheriting the rest, because the alternative is silently dropping half of
 * what the owner configured.
 */

let dir = "";

async function load() {
  vi.resetModules();
  const env = await import("../config/env.js");
  env.config.dataDir = dir;
  const mod = await import("./userGit.js");
  mod.resetUserGitForTesting();
  return mod;
}

beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "vibehub-usergit-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe("identidade git por usuário", () => {
  it("quem nunca foi configurado não tem identidade", async () => {
    const { getUserGit } = await load();
    expect(await getUserGit("u1")).toBeNull();
  });

  it("guarda e devolve os três campos", async () => {
    const { setUserGit, getUserGit } = await load();
    await setUserGit("u1", { githubConnectionId: "c1", gitName: "wellesley-mussolini", gitEmail: "xerif.off@gmail.com" });
    expect(await getUserGit("u1")).toEqual({
      userId: "u1", githubConnectionId: "c1", gitName: "wellesley-mussolini", gitEmail: "xerif.off@gmail.com",
    });
  });

  it("patch parcial não apaga o que não foi mandado", async () => {
    const { setUserGit, getUserGit } = await load();
    await setUserGit("u1", { githubConnectionId: "c1", gitName: "mussa", gitEmail: "m@x.com" });
    await setUserGit("u1", { gitName: "wellesley-mussolini" });
    const got = await getUserGit("u1");
    expect(got?.gitName).toBe("wellesley-mussolini");
    expect(got?.githubConnectionId).toBe("c1");
    expect(got?.gitEmail).toBe("m@x.com");
  });

  it("null limpa o campo (volta a herdar)", async () => {
    const { setUserGit, getUserGit } = await load();
    await setUserGit("u1", { githubConnectionId: "c1", gitName: "mussa" });
    await setUserGit("u1", { githubConnectionId: null });
    expect((await getUserGit("u1"))?.githubConnectionId).toBeUndefined();
  });

  it("um usuário não pisa no outro", async () => {
    const { setUserGit, getUserGit } = await load();
    await setUserGit("u-cesar", { githubConnectionId: "c-cesar" });
    await setUserGit("u-mussa", { githubConnectionId: "c-mussa" });
    expect((await getUserGit("u-cesar"))?.githubConnectionId).toBe("c-cesar");
    expect((await getUserGit("u-mussa"))?.githubConnectionId).toBe("c-mussa");
  });

  it("sobrevive a um restart: o que foi gravado é lido do disco", async () => {
    const first = await load();
    await first.setUserGit("u1", { gitEmail: "xerif.off@gmail.com" });
    const second = await load(); // módulo novo, cache novo, mesmo dataDir
    expect((await second.getUserGit("u1"))?.gitEmail).toBe("xerif.off@gmail.com");
  });

  it("remover o usuário remove a identidade dele", async () => {
    const { setUserGit, getUserGit, removeUserGit } = await load();
    await setUserGit("u1", { gitName: "mussa" });
    await removeUserGit("u1");
    expect(await getUserGit("u1")).toBeNull();
    await expect(removeUserGit("u1")).resolves.toBeUndefined(); // idempotente
  });

  it("e-mail e nome com caractere de shell são recusados", async () => {
    const { assertGitEmail, assertGitName } = await load();
    expect(() => assertGitEmail("a$(whoami)@x.com")).toThrow();
    expect(() => assertGitEmail("sem-arroba")).toThrow();
    expect(() => assertGitName("mussa'; rm -rf /")).toThrow();
    expect(() => assertGitName("linha\numa")).toThrow();
    expect(assertGitEmail(" xerif.off@gmail.com ")).toBe("xerif.off@gmail.com");
    expect(assertGitName(" Wellesley Mussolini ")).toBe("Wellesley Mussolini");
  });

  it("gravação inválida não deixa metade do patch aplicada", async () => {
    const { setUserGit, getUserGit } = await load();
    await setUserGit("u1", { githubConnectionId: "c1" });
    await expect(setUserGit("u1", { githubConnectionId: "c2", gitEmail: "nao-e-email" })).rejects.toThrow();
    expect((await getUserGit("u1"))?.githubConnectionId).toBe("c1");
  });
});
