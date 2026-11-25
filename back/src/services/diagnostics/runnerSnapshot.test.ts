import { describe, it, expect } from "vitest";
import { parseRunnerSnapshot, runnerSnapshotScript } from "./runnerSnapshot.js";
import { runnerCapture } from "../../testkit/runnerCapture.js";

const CARD_A = "f9e7a907-d9e2-4b6b-8be6-d78c7fee0855";

function captureFrom({ secondSample = true } = {}): string {
  return runnerCapture({
    secondSample,
    processes: [
      {
        pid: 101, comm: "node (vitest 1)", ticksBefore: 1000, ticksAfter: 1400, startTicks: 90_000, rssPages: 262_144, cardId: CARD_A,
        args: "node vitest run src/x.test.ts GH_TOKEN=ghp_abc123 --api-key=sk-ant-xyz",
      },
      { pid: 102, comm: "claude", ticksAfter: 100, startTicks: 100_100, rssPages: 25_600, args: "claude --model opus" },
      { pid: 103, comm: "sh", ticksBefore: 10, startTicks: 99_000, rssPages: 100 },
    ],
  });
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

  it.each([
    ['curl -H "Authorization: Bearer github_pat_11ABCDEF0123" x', 'curl -H "Authorization: Bearer <redacted>" x'],
    ["git clone https://user:hunter2@example.com/r.git", "git clone https://user:<redacted>@example.com/r.git"],
    ["claude --token abc123secret --model opus", "claude --token <redacted> --model opus"],
    ["node x --password hunter2", "node x --password <redacted>"],
    ["tool github_pat_11ABC", "tool <redacted>"],
  ])("segredo fora do formato NOME=valor também sai redigido: %s", (args, redacted) => {
    const claude = parseRunnerSnapshot(`${captureFrom()}\n@args 102 ${args}`).processes.find((process) => process.pid === 102);
    expect(claude?.args).toBe(redacted);
  });

  it("PID reaproveitado por outro processo no intervalo conta só a CPU do processo novo", () => {
    const capture = runnerCapture({
      processes: [{ pid: 104, comm: "git", ticksBefore: 5000, startTicksBefore: 90_000, ticksAfter: 30, startTicks: 100_050, rssPages: 100 }],
    });
    expect(parseRunnerSnapshot(capture).processes).toEqual([expect.objectContaining({ pid: 104, cpuPct: 15 })]);
  });

  it("runner sem medição de pressão nem de throttle deixa os campos ausentes, em vez de zero", () => {
    const withoutPressure = captureFrom().split("\n").filter((line) => !line.startsWith("@pressure") && !line.startsWith("@throttled")).join("\n");
    const snapshot = parseRunnerSnapshot(withoutPressure);
    expect(snapshot.pressure).toBeUndefined();
    expect(snapshot.cpu).not.toHaveProperty("throttledPct");
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
