import { describe, it, expect } from "vitest";
import { diagnoseSlowness, type DiagnosedCard } from "./slowness.js";
import type { RunnerProcess, RunnerSnapshot } from "./runnerSnapshot.js";

const WORKING: DiagnosedCard = { id: "card-working", title: "PDV 2.0", column: "working", status: "working" };
const WAITING: DiagnosedCard = { id: "card-waiting", title: "Conciliação", column: "working", status: "waiting" };
const DONE: DiagnosedCard = { id: "card-done", title: "Entregue", column: "done", status: null };
const HIDDEN: DiagnosedCard = { id: "card-hidden", title: "Segredo do dono", column: "working", status: "working" };
const ALL_CARDS = [WORKING, WAITING, DONE, HIDDEN];

function runnerProcess(pid: number, cpuPct: number, cardId?: string, rssMb = 100): RunnerProcess {
  return { pid, comm: `proc-${pid}`, ...(cardId ? { cardId } : {}), cpuPct, rssMb, ageSeconds: 60, args: `proc-${pid} --run` };
}

function snapshotWith(change: { cpu?: Partial<RunnerSnapshot["cpu"]>; pressure?: Partial<RunnerSnapshot["pressure"]>;
  memory?: Partial<RunnerSnapshot["memory"]>; processes?: RunnerProcess[] } = {}): RunnerSnapshot {
  return {
    intervalSeconds: 2,
    cpu: { cores: 8, limitCores: 8, userPct: 20, systemPct: 5, iowaitPct: 1, stealPct: 2, idlePct: 72, throttledPct: 0, ...change.cpu },
    load: [2, 2, 2],
    pressure: { cpuSome: 1, memorySome: 0, ioSome: 1, ioFull: 0, ...change.pressure },
    memory: { totalMb: 32_000, availableMb: 20_000, swapTotalMb: 8000, swapUsedMb: 100, ...change.memory },
    disk: { usedPct: 60 },
    processes: change.processes ?? [],
  };
}

const ownerView = (snapshot: RunnerSnapshot) =>
  diagnoseSlowness(snapshot, ALL_CARDS, new Set(ALL_CARDS.map((card) => card.id)), true);
const memberView = (snapshot: RunnerSnapshot) =>
  diagnoseSlowness(snapshot, ALL_CARDS, new Set([WORKING.id, DONE.id]), false);

describe("diagnoseSlowness — o veredito", () => {
  it.each([
    ["server_steal", snapshotWith({ cpu: { stealPct: 40 } })],
    ["cpu_limit", snapshotWith({ cpu: { throttledPct: 15 } })],
    ["cpu_saturated", snapshotWith({ cpu: { idlePct: 5 } })],
    ["disk_io", snapshotWith({ pressure: { ioFull: 12 } })],
    ["memory", snapshotWith({ memory: { availableMb: 2000 } })],
    ["heavy_card", snapshotWith({ processes: [runnerProcess(1, 150, WORKING.id)] })],
    ["idle_card_busy", snapshotWith({ processes: [runnerProcess(1, 40, WAITING.id)] })],
    ["orphan_processes", snapshotWith({ processes: [runnerProcess(1, 0, DONE.id)] })],
  ])("aponta %s quando a leitura mostra esse gargalo", (kind, snapshot) => {
    expect(ownerView(snapshot).findings.map((finding) => finding.kind)).toContain(kind);
  });

  it("máquina folgada e sem card pesado diz que o runner não explica a demora", () => {
    expect(ownerView(snapshotWith({ processes: [runnerProcess(1, 10, WORKING.id)] })).findings)
      .toEqual([{ kind: "no_runner_bottleneck", summary: expect.stringMatching(/model/) }]);
  });

  it("o servidor vem antes do card pesado na lista", () => {
    const kinds = ownerView(snapshotWith({ cpu: { stealPct: 40 }, processes: [runnerProcess(1, 150, WORKING.id)] }))
      .findings.map((finding) => finding.kind);
    expect(kinds).toEqual(["server_steal", "heavy_card"]);
  });

  it("card que trabalha um turno e gasta pouca CPU não é apontado", () => {
    expect(ownerView(snapshotWith({ processes: [runnerProcess(1, 40, WORKING.id)] })).findings.map((finding) => finding.kind))
      .toEqual(["no_runner_bottleneck"]);
  });
});

describe("diagnoseSlowness — o consumo por card", () => {
  it("soma os processos de cada card, mais pesado primeiro, com os processos que mais gastam", () => {
    const report = ownerView(snapshotWith({
      processes: [runnerProcess(1, 10, WAITING.id), runnerProcess(2, 90, WORKING.id), runnerProcess(3, 60, WORKING.id, 300)],
    }));
    expect(report.cards.map((card) => [card.title, card.cpuPct, card.rssMb, card.processCount])).toEqual([
      ["PDV 2.0", 150, 400, 2], ["Conciliação", 10, 100, 1],
    ]);
    expect(report.cards[0]?.topProcesses.map((process) => process.pid)).toEqual([2, 3]);
  });

  it("processo de card concluído ou apagado vai para os esquecidos; sem card, para o runner", () => {
    const report = ownerView(snapshotWith({
      processes: [runnerProcess(1, 5, DONE.id), runnerProcess(2, 5, "card-apagado"), runnerProcess(3, 5)],
    }));
    expect(report.orphans.processes.map((process) => process.pid)).toEqual([1, 2]);
    expect(report.runner?.processes.map((process) => process.pid)).toEqual([3]);
    expect(report.cards).toEqual([]);
  });

  it("membro só vê o detalhe dos cards que alcança; o resto vira uma soma sem nome", () => {
    const report = memberView(snapshotWith({
      processes: [
        runnerProcess(1, 20, WORKING.id), runnerProcess(2, 70, HIDDEN.id), runnerProcess(3, 5, "card-apagado"),
        runnerProcess(4, 5), runnerProcess(5, 1, DONE.id),
      ],
    }));
    expect(report.cards.map((card) => card.id)).toEqual([WORKING.id]);
    expect(report.orphans.processes.map((process) => process.pid)).toEqual([5]);
    expect(report.runner).toBeUndefined();
    expect(report.others).toEqual({ cpuPct: 80, rssMb: 300, processCount: 3 });
    expect(JSON.stringify(report)).not.toContain("Segredo do dono");
  });

  it("membro não recebe achado sobre card que não vê", () => {
    const report = memberView(snapshotWith({ processes: [runnerProcess(1, 300, HIDDEN.id)] }));
    expect(report.findings.map((finding) => finding.kind)).not.toContain("heavy_card");
    expect(report.findings).toContainEqual({ kind: "others_heavy", summary: expect.stringMatching(/3 cores/) });
  });
});
