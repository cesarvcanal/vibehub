import { describe, it, expect, onTestFinished, vi } from "vitest";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { accessSync, constants, existsSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathWithFakeDocker } from "../../testkit/fakeDocker.js";
import { buildCardPurgeScript, parsePurgeFreedBytes } from "./workspace.js";
import { cardTmpDir } from "./cardTmp.js";

const UPLOADS_ROOT = "/work/.uploads";

const tmuxInstalled = (() => {
  try {
    execFileSync("tmux", ["-V"]);
    return true;
  } catch {
    return false;
  }
})();

const uploadsWritable = (() => {
  try {
    accessSync(UPLOADS_ROOT, constants.W_OK);
    return true;
  } catch {
    return false;
  }
})();

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  await new Promise<void>((done) => server.close(() => done()));
  if (!address || typeof address === "string") throw new Error("no port");
  return address.port;
}

async function portIsFree(port: number): Promise<boolean> {
  const server = createServer();
  return new Promise((done) => {
    server.once("error", () => done(false));
    server.listen(port, "127.0.0.1", () => server.close(() => done(true)));
  });
}

function isAlive(child: ChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null;
}

async function liveCard(repoDir: string) {
  const cardId = randomUUID();
  const slug = `card-${cardId.slice(0, 8)}`;
  const cwd = `${repoDir}-worktrees/${slug}`;
  execFileSync("git", ["-C", repoDir, "worktree", "add", "-q", "-b", `card/${slug}`, cwd]);
  const tmp = cardTmpDir(cardId);
  await mkdir(join(tmp, "mongo-mem-123"), { recursive: true });
  await writeFile(join(tmp, "mongo-mem-123", "WiredTiger"), "x".repeat(4096));
  onTestFinished(() => rm(tmp, { recursive: true, force: true }));
  const port = await freePort();
  const server = spawn(
    process.execPath,
    ["-e", `require("net").createServer().listen(${port}, "127.0.0.1"); setInterval(() => {}, 1000)`],
    { env: { ...process.env, VIBEHUB_CARD_ID: cardId, TMPDIR: tmp }, detached: true, stdio: "ignore" },
  );
  onTestFinished(() => {
    if (isAlive(server)) server.kill("SIGKILL");
  });
  await vi.waitFor(async () => expect(await portIsFree(port)).toBe(false));
  const script = buildCardPurgeScript({
    containerName: "vibehub-runner",
    cardId,
    cwd,
    repoDir,
    branch: `card/${slug}`,
    browserDataDir: `/tmp/vh-purge-browser-${cardId}`,
    sessions: [`vh-purge-test-${cardId.slice(0, 8)}`],
  });
  return { cardId, slug, cwd, tmp, port, server, script };
}

async function gitRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "vh-purge-repo-"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const repoDir = join(root, "repo");
  execFileSync("git", ["init", "-q", "-b", "main", repoDir]);
  execFileSync("git", ["-C", repoDir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init"]);
  return repoDir;
}

function runPurge(script: string, path: string): string {
  return execFileSync("bash", ["-c", script], { env: { ...process.env, PATH: path }, encoding: "utf8" });
}

function localBranches(repoDir: string): string {
  return execFileSync("git", ["-C", repoDir, "branch", "--list"], { encoding: "utf8" });
}

describe("apagar o card no runner (script de purge executado de verdade)", { timeout: 30_000 }, () => {
  it("leva worktree, branch local, /tmp do card e processos, e libera a porta — sem tocar no card vizinho", async () => {
    const path = await pathWithFakeDocker();
    const repoDir = await gitRepo();
    const cardA = await liveCard(repoDir);
    const cardB = await liveCard(repoDir);

    const output = runPurge(cardA.script, path);

    expect(parsePurgeFreedBytes(output)).toBeGreaterThan(0);
    await vi.waitFor(() => expect(isAlive(cardA.server)).toBe(false));
    expect(await portIsFree(cardA.port)).toBe(true);
    expect(existsSync(cardA.cwd)).toBe(false);
    expect(existsSync(cardA.tmp)).toBe(false);
    expect(localBranches(repoDir)).not.toContain(`card/${cardA.slug}`);

    expect(isAlive(cardB.server)).toBe(true);
    expect(await portIsFree(cardB.port)).toBe(false);
    expect(existsSync(cardB.cwd)).toBe(true);
    expect(existsSync(join(cardB.tmp, "mongo-mem-123", "WiredTiger"))).toBe(true);
    expect(localBranches(repoDir)).toContain(`card/${cardB.slug}`);
  });

  it.skipIf(!tmuxInstalled)("nunca mata o servidor tmux, mesmo nascido com o VIBEHUB_CARD_ID do card apagado", async () => {
    const path = await pathWithFakeDocker();
    const repoDir = await gitRepo();
    const card = await liveCard(repoDir);
    const socket = `vh-purge-${card.cardId.slice(0, 8)}`;
    const otherCardId = randomUUID();
    execFileSync("tmux", ["-L", socket, "new-session", "-d", "-s", "outro-card", "-e", `VIBEHUB_CARD_ID=${otherCardId}`, "sleep 600"], {
      env: { ...process.env, VIBEHUB_CARD_ID: card.cardId },
    });
    onTestFinished(() => {
      execFileSync("tmux", ["-L", socket, "kill-server"], { stdio: "ignore" });
    });

    runPurge(card.script, path);

    expect(() => execFileSync("tmux", ["-L", socket, "has-session", "-t", "outro-card"])).not.toThrow();
    await vi.waitFor(() => expect(isAlive(card.server)).toBe(false));
  });

  it.skipIf(!uploadsWritable)("leva os uploads do card (fotos, áudios, prints) e deixa os do vizinho", async () => {
    const path = await pathWithFakeDocker();
    const repoDir = await gitRepo();
    const cardA = await liveCard(repoDir);
    const cardB = await liveCard(repoDir);
    for (const card of [cardA, cardB]) {
      const dir = join(UPLOADS_ROOT, card.cardId);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "print.png"), "png");
      onTestFinished(() => rm(dir, { recursive: true, force: true }));
    }

    runPurge(cardA.script, path);

    expect(existsSync(join(UPLOADS_ROOT, cardA.cardId))).toBe(false);
    expect(existsSync(join(UPLOADS_ROOT, cardB.cardId, "print.png"))).toBe(true);
  });

  it("é idempotente: rodar duas vezes, ou com a worktree já removida à mão, termina sem erro", async () => {
    const path = await pathWithFakeDocker();
    const repoDir = await gitRepo();
    const card = await liveCard(repoDir);
    await rm(card.cwd, { recursive: true, force: true });

    runPurge(card.script, path);
    const second = runPurge(card.script, path);

    expect(parsePurgeFreedBytes(second)).toBe(0);
    expect(existsSync(card.tmp)).toBe(false);
    expect(localBranches(repoDir)).not.toContain(`card/${card.slug}`);
    expect(execFileSync("git", ["-C", repoDir, "worktree", "list"], { encoding: "utf8" })).not.toContain(card.slug);
  });

  it.each(["", "../", "*", "..", "a/b", "$(id)"])("recusa o id de card %j antes de montar qualquer rm", (cardId) => {
    expect(() =>
      buildCardPurgeScript({
        containerName: "vibehub-runner",
        cardId,
        cwd: "/work/scratch/x",
        browserDataDir: "/work/.browser/card-x",
        sessions: ["card-x"],
      }),
    ).toThrow(/invalid card id/);
  });
});
