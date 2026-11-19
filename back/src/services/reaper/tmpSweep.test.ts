import { describe, it, expect, afterEach, vi } from "vitest";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile, utimes, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hostExecutor } from "../../runtime/host.js";
import {
  buildTmpSweepScript, parseTmpSweep, startTmpSweep, tmpUsageAlert, TMP_ALERT_BYTES, DISK_ALERT_PERCENT,
} from "./tmpSweep.js";

vi.mock("../../runtime/host.js", async (orig) => ({
  ...(await orig<typeof import("../../runtime/host.js")>()),
  hostExecutor: vi.fn(),
}));

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const THREE_DAYS_AGO = new Date(Date.now() - 3 * 24 * 60 * 60_000);

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

async function sweepRoot(): Promise<{ root: string; path: string }> {
  const bin = await mkdtemp(join(tmpdir(), "vh-tmpsweep-bin-"));
  const root = await mkdtemp(join(tmpdir(), "vh-tmpsweep-root-"));
  cleanups.push(() => rm(bin, { recursive: true, force: true }));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(bin, "docker"), '#!/bin/sh\nshift 3\nexec "$@"\n', { mode: 0o755 });
  return { root, path: `${bin}:${process.env.PATH}` };
}

async function oldFile(path: string, content = "x"): Promise<void> {
  await writeFile(path, content);
  await utimes(path, THREE_DAYS_AGO, THREE_DAYS_AGO);
}

async function oldDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
  await utimes(path, THREE_DAYS_AGO, THREE_DAYS_AGO);
}

function holdOpen(file: string): ChildProcess {
  const child = spawn(
    process.execPath,
    ["-e", `require("fs").openSync(${JSON.stringify(file)}, "r"); console.log("open"); setInterval(() => {}, 1000)`],
    { stdio: ["ignore", "pipe", "ignore"] },
  );
  cleanups.push(async () => {
    child.kill("SIGKILL");
  });
  return child;
}

function mentionInArgv(path: string): ChildProcess {
  const child = spawn(process.execPath, ["-e", 'console.log("up"); setInterval(() => {}, 1000)', path], {
    stdio: ["ignore", "pipe", "ignore"],
  });
  cleanups.push(async () => {
    child.kill("SIGKILL");
  });
  return child;
}

async function started(child: ChildProcess): Promise<void> {
  await new Promise<void>((done) => child.stdout!.once("data", () => done()));
}

function runSweep(root: string, path: string): string {
  return execFileSync("bash", ["-c", buildTmpSweepScript("vibehub-runner", { root })], {
    env: { ...process.env, PATH: path },
    encoding: "utf8",
  });
}

describe("faxina do /tmp solto (fora de /tmp/vibehub), executada de verdade", { timeout: 30_000 }, () => {
  it("apaga a entrada parada há mais de 48 h que ninguém usa e diz o tamanho", async () => {
    const { root, path } = await sweepRoot();
    await oldFile(join(root, "verify3-tests-split.log"), "y".repeat(8192));
    await oldDir(join(root, "mongo-mem-abc"));

    const report = parseTmpSweep(runSweep(root, path));

    expect(await exists(join(root, "verify3-tests-split.log"))).toBe(false);
    expect(await exists(join(root, "mongo-mem-abc"))).toBe(false);
    expect(report.swept.map((entry) => entry.path).sort()).toEqual([
      join(root, "mongo-mem-abc"),
      join(root, "verify3-tests-split.log"),
    ]);
    expect(report.swept.find((entry) => entry.path.endsWith(".log"))!.bytes).toBeGreaterThanOrEqual(8192);
  });

  it("não apaga entrada em uso: arquivo com fd aberto ou caminho no argv de processo vivo", async () => {
    const { root, path } = await sweepRoot();
    const held = join(root, "held.db");
    await oldFile(held);
    const mentioned = join(root, "repro");
    await oldDir(mentioned);
    const holder = holdOpen(held);
    const user = mentionInArgv(mentioned);
    await Promise.all([started(holder), started(user)]);

    runSweep(root, path);

    expect(await exists(held)).toBe(true);
    expect(await exists(mentioned)).toBe(true);
  });

  it("pasta antiga com arquivo modificado nas últimas 48 h fica — confere por dentro", async () => {
    const { root, path } = await sweepRoot();
    const copy = join(root, "pr547wt");
    await mkdir(join(copy, "src"), { recursive: true });
    await writeFile(join(copy, "src", "recente.ts"), "agora");
    await utimes(join(copy, "src"), THREE_DAYS_AGO, THREE_DAYS_AGO);
    await utimes(copy, THREE_DAYS_AGO, THREE_DAYS_AGO);

    runSweep(root, path);

    expect(await exists(join(copy, "src", "recente.ts"))).toBe(true);
  });

  it("nunca toca no /tmp dos cards, nas sessões do Claude Code, no tmux nem no node-compile-cache", async () => {
    const { root, path } = await sweepRoot();
    const protectedNames = ["vibehub", "claude-0", "node-compile-cache", "tmux-0", "cc-socks", ".X11-unix"];
    for (const name of protectedNames) await oldDir(join(root, name));
    await oldFile(join(root, "recente-o-bastante"));
    await utimes(join(root, "recente-o-bastante"), new Date(), new Date());

    runSweep(root, path);

    for (const name of [...protectedNames, "recente-o-bastante"]) expect(await exists(join(root, name))).toBe(true);
  });

  it("mede o que sobrou: tamanho de cada entrada (o /tmp de cada card à parte) e o uso do disco", async () => {
    const { root, path } = await sweepRoot();
    const cardDir = join(root, "vibehub", "aaaaaaaa-0000-0000-0000-000000000000");
    await mkdir(cardDir, { recursive: true });
    await writeFile(join(cardDir, "mongo"), "z".repeat(64 * 1024));

    const report = parseTmpSweep(runSweep(root, path));

    expect(report.sizes.find((entry) => entry.path === cardDir)!.bytes).toBeGreaterThanOrEqual(64 * 1024);
    expect(report.sizes.some((entry) => entry.path === join(root, "vibehub"))).toBe(false);
    expect(report.diskPercent).toBeGreaterThan(0);
    expect(report.diskPercent).toBeLessThanOrEqual(100);
  });
});

describe("tmpUsageAlert", () => {
  const sizes = (bytesPerEntry: number[]) =>
    bytesPerEntry.map((bytes, index) => ({ path: `/tmp/vibehub/card-${index}`, bytes }));

  it("fica quieto abaixo dos dois limites", () => {
    expect(tmpUsageAlert({ swept: [], sizes: sizes([1024]), diskPercent: DISK_ALERT_PERCENT })).toBeNull();
  });

  it("dispara com o /tmp acima de 30 GB e traz o top 5 do maior para o menor", () => {
    const alert = tmpUsageAlert({ swept: [], sizes: sizes([1, TMP_ALERT_BYTES, 5, 4, 3, 2]), diskPercent: 10 });
    expect(alert?.tmpBytes).toBe(TMP_ALERT_BYTES + 15);
    expect(alert?.top.map((entry) => entry.path)).toEqual([
      "/tmp/vibehub/card-1",
      "/tmp/vibehub/card-2",
      "/tmp/vibehub/card-3",
      "/tmp/vibehub/card-4",
      "/tmp/vibehub/card-5",
    ]);
  });

  it("dispara com o disco acima de 80%, mesmo com o /tmp pequeno", () => {
    expect(tmpUsageAlert({ swept: [], sizes: sizes([1]), diskPercent: DISK_ALERT_PERCENT + 1 })?.diskPercent).toBe(81);
  });

  it("a saída malformada não vira número: linha sem formato é ignorada e o disco ausente falha à vista", () => {
    expect(() => parseTmpSweep("lixo\n")).toThrow(/disk/);
    expect(parseTmpSweep("VIBEHUB_TMP_SIZE\tabc\t/tmp/x\nVIBEHUB_TMP_DISK\t42\n")).toEqual({ swept: [], sizes: [], diskPercent: 42 });
  });
});

describe("startTmpSweep", () => {
  it("duas passadas nunca rodam juntas: um runner lento não ganha uma segunda faxina por cima", async () => {
    vi.useFakeTimers();
    const pass = { finish: (_run: { stdout: string; stderr: string }) => {} };
    const runScript = vi.fn(
      () => new Promise<{ stdout: string; stderr: string }>((done) => {
        pass.finish = done;
      }),
    );
    vi.mocked(hostExecutor).mockReturnValue({ runScript } as unknown as ReturnType<typeof hostExecutor>);
    const stop = startTmpSweep(1000);
    try {
      await vi.advanceTimersByTimeAsync(3500);
      expect(runScript).toHaveBeenCalledTimes(1);

      pass.finish({ stdout: "VIBEHUB_TMP_DISK\t10\n", stderr: "" });
      await vi.advanceTimersByTimeAsync(1000);
      expect(runScript).toHaveBeenCalledTimes(2);
    } finally {
      stop();
      vi.useRealTimers();
    }
  });
});
