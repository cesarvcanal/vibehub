import { describe, it, expect, onTestFinished, vi } from "vitest";
import { spawn, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hostExecutor, CONTAINER_DEADLINE_MARGIN_MS } from "../../runtime/host.js";
import { pathWithFakeDocker } from "../../testkit/fakeDocker.js";
import { logger } from "../../utils/logger.js";
import {
  buildTmpSweepScript, parseTmpSweep, startTmpSweep, sweepRunnerTmp, tmpUsageAlert, TMP_ALERT_BYTES, DISK_ALERT_PERCENT, TMP_SWEEP_TIMEOUT_MS,
  TMP_SWEEP_FAILURES_BEFORE_ALERT,
} from "./tmpSweep.js";

vi.mock("../../runtime/host.js", async (orig) => ({
  ...(await orig<typeof import("../../runtime/host.js")>()),
  hostExecutor: vi.fn(),
}));

const THREE_DAYS_AGO = new Date(Date.now() - 3 * 24 * 60 * 60_000);

type PathUse = "fd" | "socket" | "argv" | "cwd" | "environ" | "environList" | "argvPunctuated";

const PATH_FROM_STDIN = 'require("fs").readFileSync(0, "utf8")';
const STAY_UP = 'console.log("up"); setInterval(() => {}, 1000)';
const PROGRAM_BY_USE: Record<PathUse, string> = {
  fd: `require("fs").openSync(${PATH_FROM_STDIN}, "r"); ${STAY_UP}`,
  socket: `require("net").createServer().listen(${PATH_FROM_STDIN}, () => console.log("up"))`,
  argv: STAY_UP,
  cwd: STAY_UP,
  environ: STAY_UP,
  environList: STAY_UP,
  argvPunctuated: STAY_UP,
};

const ARGV_BY_USE: Partial<Record<PathUse, (path: string) => string[]>> = {
  argv: (path) => [path],
  argvPunctuated: (path) => [`dirs="${path}";echo`],
};

const ENV_BY_USE: Partial<Record<PathUse, (path: string) => Record<string, string>>> = {
  environ: (path) => ({ VIBEHUB_DATA_DIR: path }),
  environList: (path) => ({ NODE_PATH: `/usr/lib:${path}:/usr/local/lib` }),
};

async function startProcessUsing(path: string, use: PathUse): Promise<void> {
  const child = spawn(process.execPath, ["-e", PROGRAM_BY_USE[use], ...(ARGV_BY_USE[use]?.(path) ?? [])], {
    cwd: use === "cwd" ? path : undefined,
    env: { ...process.env, ...ENV_BY_USE[use]?.(path) },
    stdio: ["pipe", "pipe", "ignore"],
  });
  onTestFinished(() => {
    child.kill("SIGKILL");
  });
  child.stdin.end(path);
  await new Promise((done) => child.stdout.once("data", done));
}

async function sweepRoot(): Promise<{ root: string; path: string }> {
  const root = await mkdtemp(join(tmpdir(), "vh-tmpsweep-root-"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  return { root, path: await pathWithFakeDocker() };
}

async function makeOld(path: string): Promise<void> {
  await utimes(path, THREE_DAYS_AGO, THREE_DAYS_AGO);
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
    await writeFile(join(root, "verify3-tests-split.log"), "y".repeat(8192));
    await mkdir(join(root, "mongo-mem-abc"));
    await makeOld(join(root, "verify3-tests-split.log"));
    await makeOld(join(root, "mongo-mem-abc"));

    const report = parseTmpSweep(runSweep(root, path));

    expect(existsSync(join(root, "verify3-tests-split.log"))).toBe(false);
    expect(existsSync(join(root, "mongo-mem-abc"))).toBe(false);
    expect(report.swept.map((entry) => entry.path).sort()).toEqual([
      join(root, "mongo-mem-abc"),
      join(root, "verify3-tests-split.log"),
    ]);
    expect(report.swept.find((entry) => entry.path.endsWith(".log"))!.bytes).toBeGreaterThanOrEqual(8192);
  });

  it.each<PathUse>(["fd", "socket", "argv", "cwd", "environ", "environList", "argvPunctuated"])(
    "não apaga entrada que um processo vivo usa por %s, mesmo parada há mais de 48 h",
    async (use) => {
      const { root, path } = await sweepRoot();
      const entry = join(root, `em-uso-${use}`);
      const usedPath = use === "socket" ? join(entry, "agent.sock") : entry;
      if (use === "fd") await writeFile(entry, "x");
      else await mkdir(entry);
      await startProcessUsing(usedPath, use);
      await makeOld(usedPath);
      await makeOld(entry);

      runSweep(root, path);

      expect(existsSync(entry)).toBe(true);
    },
  );

  it("entrada cujo nome foge dos caracteres de nome de arquivo fica: o uso por processo não seria reconhecido", async () => {
    const { root, path } = await sweepRoot();
    const entry = join(root, "nome com espaço");
    await mkdir(entry);
    await makeOld(entry);

    runSweep(root, path);

    expect(existsSync(entry)).toBe(true);
  });

  it("pasta antiga com arquivo modificado nas últimas 48 h fica — confere por dentro", async () => {
    const { root, path } = await sweepRoot();
    const copy = join(root, "pr547wt");
    await mkdir(join(copy, "src"), { recursive: true });
    await writeFile(join(copy, "src", "recente.ts"), "agora");
    await makeOld(join(copy, "src"));
    await makeOld(copy);

    runSweep(root, path);

    expect(existsSync(join(copy, "src", "recente.ts"))).toBe(true);
  });

  it("nunca toca no /tmp dos cards, nas sessões do Claude Code, no tmux nem no node-compile-cache", async () => {
    const { root, path } = await sweepRoot();
    const protectedNames = ["vibehub", "claude-0", "node-compile-cache", "tmux-0", "cc-socks", ".X11-unix"];
    for (const name of protectedNames) {
      await mkdir(join(root, name));
      await makeOld(join(root, name));
    }
    await writeFile(join(root, "recente-o-bastante"), "x");

    runSweep(root, path);

    for (const name of [...protectedNames, "recente-o-bastante"]) expect(existsSync(join(root, name))).toBe(true);
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

describe("buildTmpSweepScript", () => {
  it("o prazo vale dentro do container: o runner mata a faxina antes de o Node desistir dela", () => {
    const deadlineSeconds = (TMP_SWEEP_TIMEOUT_MS - CONTAINER_DEADLINE_MARGIN_MS) / 1000;
    expect(buildTmpSweepScript("vibehub-runner")).toContain(
      `docker exec -i 'vibehub-runner' timeout -s KILL ${deadlineSeconds} bash -s`,
    );
  });
});

describe("sweepRunnerTmp", () => {
  it("registra no log de auditoria o que apagou e alerta com o top quando o /tmp passa de 30 GB", async () => {
    const stdout = [
      "VIBEHUB_TMP_SWEPT\t8\t/tmp/verify3-tests-split.log",
      `VIBEHUB_TMP_SIZE\t${TMP_ALERT_BYTES / 1024 + 1}\t/tmp/vibehub/card-a`,
      "VIBEHUB_TMP_SIZE\t4\t/tmp/node-compile-cache",
      "VIBEHUB_TMP_DISK\t42",
    ].join("\n");
    const runScript = vi.fn(() => Promise.resolve({ stdout, stderr: "" }));
    vi.mocked(hostExecutor).mockReturnValue({ runScript } as unknown as ReturnType<typeof hostExecutor>);
    const infoSpy = vi.spyOn(logger, "info").mockImplementation(() => undefined);
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    onTestFinished(() => vi.restoreAllMocks());

    await sweepRunnerTmp();

    expect(infoSpy.mock.calls[0]![0]).toMatchObject({
      audit: true,
      action: "runner.tmp_sweep",
      entries: 1,
      freedBytes: 8 * 1024,
      swept: [{ path: "/tmp/verify3-tests-split.log", bytes: 8 * 1024 }],
    });
    expect(warnSpy.mock.calls[0]![0]).toMatchObject({
      audit: true,
      action: "runner.tmp_alert",
      diskPercent: 42,
      top: [{ path: "/tmp/vibehub/card-a" }, { path: "/tmp/node-compile-cache" }],
    });
  });

  it("passada que não apagou nada e está abaixo dos limites não escreve no log de auditoria", async () => {
    const runScript = vi.fn(() => Promise.resolve({ stdout: "VIBEHUB_TMP_SIZE\t4\t/tmp/x\nVIBEHUB_TMP_DISK\t10\n", stderr: "" }));
    vi.mocked(hostExecutor).mockReturnValue({ runScript } as unknown as ReturnType<typeof hostExecutor>);
    const infoSpy = vi.spyOn(logger, "info").mockImplementation(() => undefined);
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    onTestFinished(() => vi.restoreAllMocks());

    await sweepRunnerTmp();

    expect(infoSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
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
    const pendingRuns: Array<(run: { stdout: string; stderr: string }) => void> = [];
    const runScript = vi.fn(() => new Promise((done) => pendingRuns.push(done)));
    vi.mocked(hostExecutor).mockReturnValue({ runScript } as unknown as ReturnType<typeof hostExecutor>);
    const stop = startTmpSweep(1000);
    try {
      await vi.advanceTimersByTimeAsync(3500);
      expect(runScript).toHaveBeenCalledTimes(1);

      pendingRuns[0]!({ stdout: "VIBEHUB_TMP_DISK\t10\n", stderr: "" });
      await vi.advanceTimersByTimeAsync(1000);
      expect(runScript).toHaveBeenCalledTimes(2);
    } finally {
      stop();
      vi.useRealTimers();
    }
  });

  it("falhas seguidas viram alerta de erro, a trava solta a cada falha e um sucesso zera a contagem", async () => {
    vi.useFakeTimers();
    const outcomes = [
      ...Array.from({ length: TMP_SWEEP_FAILURES_BEFORE_ALERT }, () => "fail"),
      "ok",
      ...Array.from({ length: TMP_SWEEP_FAILURES_BEFORE_ALERT - 1 }, () => "fail"),
    ];
    const runScript = vi.fn(() =>
      outcomes[runScript.mock.calls.length - 1] === "ok"
        ? Promise.resolve({ stdout: "VIBEHUB_TMP_DISK\t10\n", stderr: "" })
        : Promise.reject(new Error("runner down")),
    );
    vi.mocked(hostExecutor).mockReturnValue({ runScript } as unknown as ReturnType<typeof hostExecutor>);
    const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => undefined);
    vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    onTestFinished(() => vi.restoreAllMocks());
    const stop = startTmpSweep(1000);
    try {
      await vi.advanceTimersByTimeAsync((outcomes.length - 1) * 1000);

      expect(runScript).toHaveBeenCalledTimes(outcomes.length);
      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(errorSpy.mock.calls[0]![0]).toMatchObject({
        audit: true,
        action: "runner.tmp_sweep_failing",
        failures: TMP_SWEEP_FAILURES_BEFORE_ALERT,
        detail: "runner down",
      });
    } finally {
      stop();
      vi.useRealTimers();
    }
  });
});
