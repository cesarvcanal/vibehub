import { describe, it, expect } from "vitest";
import { parseRunnerSnapshot, runnerSnapshotScript } from "./runnerSnapshot.js";

const CARD_A = "f9e7a907-d9e2-4b6b-8be6-d78c7fee0855";

function procStatLine(pid: number, comm: string, utime: number, stime: number, startTicks: number, rssPages: number): string {
  return `@pstat ${pid} (${comm}) R 1 1 1 0 -1 0 0 0 0 0 ${utime} ${stime} 0 0 20 0 1 0 ${startTicks} 0 ${rssPages}`;
}

function captureFrom({ secondSample = true } = {}): string {
  const header = ["@clk 100", "@pagesize 4096", "@ncpu 8", "@cpumax 800000 100000"];
  const first = [
    "@sample 1",
    "@uptime 1000.00",
    "@cpu cpu  1000 0 1000 1000 1000 0 1000 1000 0 0",
    "@throttled 0",
    procStatLine(101, "node (vitest 1)", 1000, 0, 90_000, 262_144),
    procStatLine(103, "sh", 5, 5, 99_000, 100),
  ];
  const second = [
    "@sample 2",
    "@uptime 1002.00",
    "@cpu cpu  1300 0 1080 1120 1040 0 1020 1440 0 0",
    "@throttled 400000",
    procStatLine(101, "node (vitest 1)", 1300, 100, 90_000, 262_144),
    procStatLine(102, "claude", 50, 50, 100_100, 25_600),
  ];
  const tail = [
    "@loadavg 10.26 10.27 9.02 9/2464 1554161",
    "@pressure cpu some avg10=16.05 avg60=26.04 avg300=24.17 total=191206616899",
    "@pressure cpu full avg10=0.00 avg60=0.00 avg300=0.00 total=0",
    "@pressure memory some avg10=0.00 avg60=0.26 avg300=0.22 total=2572292569",
    "@pressure memory full avg10=0.00 avg60=0.23 avg300=0.20 total=2069102658",
    "@pressure io some avg10=9.50 avg60=11.43 avg300=10.25 total=32606673497",
    "@pressure io full avg10=6.38 avg60=5.94 avg300=5.50 total=18776921219",
    "@mem MemTotal:       33554432 kB",
    "@mem MemAvailable:   16777216 kB",
    "@mem SwapTotal:       8388608 kB",
    "@mem SwapFree:        6291456 kB",
    "@disk 300 400",
    `@card 101 ${CARD_A}`,
    "@args 101 node vitest run src/x.test.ts GH_TOKEN=ghp_abc123 --api-key=sk-ant-xyz",
    "@args 102 claude --model opus",
  ];
  return [...header, ...first, ...(secondSample ? second : []), ...tail].join("\n");
}

describe("parseRunnerSnapshot", () => {
  it("separa a CPU da máquina entre uso, espera de disco e o tempo roubado pelo servidor no intervalo", () => {
    expect(parseRunnerSnapshot(captureFrom()).cpu).toEqual({
      cores: 8, limitCores: 8, userPct: 30, systemPct: 10, iowaitPct: 4, stealPct: 44, idlePct: 12, throttledPct: 20,
    });
  });

  it("lê carga, pressão, memória e disco", () => {
    const snapshot = parseRunnerSnapshot(captureFrom());
    expect(snapshot.intervalSeconds).toBe(2);
    expect(snapshot.load).toEqual([10.26, 10.27, 9.02]);
    expect(snapshot.pressure).toEqual({ cpuSome: 16.05, memorySome: 0, ioSome: 9.5, ioFull: 6.38 });
    expect(snapshot.memory).toEqual({ totalMb: 32768, availableMb: 16384, swapTotalMb: 8192, swapUsedMb: 2048 });
    expect(snapshot.disk).toEqual({ usedPct: 75 });
  });

  it("mede a CPU de cada processo no intervalo, com o card dono, a RAM e a idade", () => {
    const vitest = parseRunnerSnapshot(captureFrom()).processes.find((process) => process.pid === 101);
    expect(vitest).toMatchObject({ comm: "node (vitest 1)", cardId: CARD_A, cpuPct: 200, rssMb: 1024, ageSeconds: 102 });
  });

  it("processo que nasceu no intervalo conta a CPU inteira dele e fica sem card quando não carrega o id", () => {
    const claude = parseRunnerSnapshot(captureFrom()).processes.find((process) => process.pid === 102);
    expect(claude).toEqual({ pid: 102, comm: "claude", cpuPct: 50, rssMb: 100, ageSeconds: 1, args: "claude --model opus" });
  });

  it("processo que morreu no intervalo não aparece", () => {
    expect(parseRunnerSnapshot(captureFrom()).processes.map((process) => process.pid)).toEqual([101, 102]);
  });

  it("segredo na linha de comando sai redigido", () => {
    const vitest = parseRunnerSnapshot(captureFrom()).processes.find((process) => process.pid === 101);
    expect(vitest?.args).toBe("node vitest run src/x.test.ts GH_TOKEN=<redacted> --api-key=<redacted>");
  });

  it("linha de comando longa é recortada", () => {
    const longArgs = `@args 102 claude ${"x".repeat(500)}`;
    const claude = parseRunnerSnapshot(`${captureFrom()}\n${longArgs}`).processes.find((process) => process.pid === 102);
    expect(claude?.args).toHaveLength(160);
  });

  it("leitura sem a segunda amostra (cortada pelo prazo) falha à vista", () => {
    expect(() => parseRunnerSnapshot(captureFrom({ secondSample: false }))).toThrow(/runner snapshot incomplete/);
  });
});

describe("runnerSnapshotScript", () => {
  it("roda tudo numa entrada só no container, sob o prazo que mata o grupo lá dentro", () => {
    const script = runnerSnapshotScript("vibehub-runner");
    expect(script.match(/docker exec/g)).toHaveLength(1);
    expect(script).toMatch(/^docker exec -i 'vibehub-runner' timeout -s KILL \d+ bash -s <<'VIBEHUB_DIAGNOSTICS'\n/);
    expect(script.trimEnd().endsWith("VIBEHUB_DIAGNOSTICS")).toBe(true);
  });

  it("do ambiente dos processos só sai o id do card", () => {
    const script = runnerSnapshotScript("vibehub-runner");
    expect(script).toContain("grep -asoz '^VIBEHUB_CARD_ID=[0-9a-f-]*' /proc/[0-9]*/environ");
    expect(script.match(/environ/g)).toHaveLength(2);
  });
});
