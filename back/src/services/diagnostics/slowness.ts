import type { Card } from "../board/registry.js";
import { terminalSituation } from "../maestro/maestro.js";
import type { RunnerProcess, RunnerSnapshot } from "./runnerSnapshot.js";

const STEAL_SLOW_PCT = 25;
const THROTTLE_SLOW_PCT = 10;
const IDLE_SATURATED_PCT = 10;
const IO_FULL_SLOW_PCT = 10;
const MEMORY_AVAILABLE_LOW_RATIO = 0.1;
const MEMORY_PRESSURE_SLOW_PCT = 10;
const HEAVY_CPU_PCT = 100;
const IDLE_CARD_BUSY_CPU_PCT = 25;
const TOP_PROCESSES_PER_GROUP = 5;

export type DiagnosedCard = Pick<Card, "id" | "title" | "column" | "status" | "openedAt" | "pausedAt">;

interface ProcessUsage {
  cpuPct: number;
  rssMb: number;
  processCount: number;
}

interface ProcessGroup extends ProcessUsage {
  topProcesses: RunnerProcess[];
}

interface CardUsage extends ProcessGroup {
  id: string;
  title: string;
  column: Card["column"];
  status: Card["status"] | null;
  turnRunning: boolean;
}

type ProcessPlace = { kind: "card"; card: DiagnosedCard } | { kind: "orphan" | "runner" | "hidden" };

interface Finding {
  kind:
    | "server_steal" | "cpu_limit" | "cpu_saturated" | "disk_io" | "memory"
    | "heavy_card" | "idle_card_busy" | "orphan_processes" | "runner_heavy" | "others_heavy"
    | "no_runner_bottleneck" | "not_measured";
  summary: string;
}

function sumUsage(processes: readonly RunnerProcess[]): ProcessUsage {
  return {
    cpuPct: processes.reduce((total, process) => total + process.cpuPct, 0),
    rssMb: processes.reduce((total, process) => total + process.rssMb, 0),
    processCount: processes.length,
  };
}

function pickHeaviestProcesses(processes: readonly RunnerProcess[]): RunnerProcess[] {
  return [...processes]
    .sort((left, right) => right.cpuPct - left.cpuPct || right.rssMb - left.rssMb)
    .slice(0, TOP_PROCESSES_PER_GROUP);
}

function summarizeGroup(processes: readonly RunnerProcess[]): ProcessGroup {
  return { ...sumUsage(processes), topProcesses: pickHeaviestProcesses(processes) };
}

function formatCores(cpuPct: number): string {
  return `${Math.round(cpuPct) / 100} cores`;
}

function joinProcessNames(processes: readonly RunnerProcess[]): string {
  return processes.map((process) => process.comm).join(", ");
}

function findMachineBottlenecks({ cpu, pressure, memory }: RunnerSnapshot): Finding[] {
  const memoryLow = memory.availableMb < memory.totalMb * MEMORY_AVAILABLE_LOW_RATIO
    || (pressure?.memorySome ?? 0) >= MEMORY_PRESSURE_SLOW_PCT;
  const candidates: [applies: boolean, finding: Finding][] = [
    [cpu.stealPct >= STEAL_SLOW_PCT, {
      kind: "server_steal",
      summary: `the hypervisor took ${cpu.stealPct}% of the CPU: the VPS shares its physical cores with other machines, so everything runs slower — nothing in vibehub fixes this, the hosting plan does`,
    }],
    [(cpu.throttledPct ?? 0) >= THROTTLE_SLOW_PCT, {
      kind: "cpu_limit",
      summary: `the runner container hit its CPU limit (${cpu.limitCores ?? cpu.cores} cores) during ${cpu.throttledPct}% of the reading`,
    }],
    [cpu.idlePct < IDLE_SATURATED_PCT, {
      kind: "cpu_saturated",
      summary: `the machine's CPU is saturated (${cpu.idlePct}% idle): processes queue for a core`,
    }],
    [(pressure?.ioFull ?? 0) >= IO_FULL_SLOW_PCT, {
      kind: "disk_io",
      summary: `every process stalled on disk ${pressure?.ioFull}% of the last 10 s`,
    }],
    [memoryLow, {
      kind: "memory",
      summary: `memory is short: ${memory.availableMb} MB available of ${memory.totalMb} MB, ${memory.swapUsedMb} MB in swap`,
    }],
  ];
  return candidates.filter(([applies]) => applies).map(([, finding]) => finding);
}

function findCardBottlenecks(cards: readonly CardUsage[]): Finding[] {
  return cards.flatMap((card): Finding[] => {
    const top = joinProcessNames(card.topProcesses);
    if (!card.turnRunning && card.cpuPct >= IDLE_CARD_BUSY_CPU_PCT) {
      return [{
        kind: "idle_card_busy",
        summary: `card '${card.title}' (${card.id}) is not running a turn but its processes use ${formatCores(card.cpuPct)}: ${top} — likely a dev server, watcher or test left behind`,
      }];
    }
    if (card.cpuPct >= HEAVY_CPU_PCT) {
      return [{ kind: "heavy_card", summary: `card '${card.title}' (${card.id}) uses ${formatCores(card.cpuPct)}: ${top}` }];
    }
    return [];
  });
}

function listUnmeasured({ cpu, pressure, disk }: RunnerSnapshot): string[] {
  const candidates: [measured: boolean, name: string][] = [
    [!!pressure, "pressure (disk and memory stalls)"],
    [cpu.throttledPct !== undefined, "CPU limit throttling"],
    [!!disk, "disk usage"],
  ];
  return candidates.filter(([measured]) => !measured).map(([, name]) => name);
}

export function diagnoseSlowness(
  snapshot: RunnerSnapshot,
  cards: readonly DiagnosedCard[],
  visibleCardIds: ReadonlySet<string>,
  seesEverything: boolean,
) {
  const cardById = new Map(cards.map((card) => [card.id, card]));
  const placeOf = (process: RunnerProcess): ProcessPlace => {
    if (!process.cardId) return seesEverything ? { kind: "runner" } : { kind: "hidden" };
    const card = cardById.get(process.cardId);
    if (!card) return seesEverything ? { kind: "orphan" } : { kind: "hidden" };
    if (!visibleCardIds.has(card.id)) return { kind: "hidden" };
    return card.column === "done" ? { kind: "orphan" } : { kind: "card", card };
  };
  const placedProcesses = snapshot.processes.map((process) => ({ process, place: placeOf(process) }));
  const processesIn = (kind: ProcessPlace["kind"]) =>
    placedProcesses.filter(({ place }) => place.kind === kind).map(({ process }) => process);

  const processesByCard = new Map<string, { card: DiagnosedCard; processes: RunnerProcess[] }>();
  for (const { process, place } of placedProcesses) {
    if (place.kind !== "card") continue;
    const entry = processesByCard.get(place.card.id) ?? { card: place.card, processes: [] };
    entry.processes.push(process);
    processesByCard.set(place.card.id, entry);
  }
  const cardUsages = [...processesByCard.values()].map(({ card, processes }): CardUsage => ({
    id: card.id, title: card.title, column: card.column, status: card.status ?? null,
    turnRunning: terminalSituation(card) === "working",
    ...summarizeGroup(processes),
  })).sort((left, right) => right.cpuPct - left.cpuPct);

  const orphans = summarizeGroup(processesIn("orphan"));
  const runner = seesEverything ? summarizeGroup(processesIn("runner")) : undefined;
  const others = sumUsage(processesIn("hidden"));
  const bottlenecks: Finding[] = [
    ...findMachineBottlenecks(snapshot),
    ...findCardBottlenecks(cardUsages),
    ...(orphans.processCount > 0 ? [{
      kind: "orphan_processes" as const,
      summary: `${orphans.processCount} processes of concluded or deleted cards are still alive, holding ${orphans.rssMb} MB and ${orphans.cpuPct}% CPU; the heaviest: ${joinProcessNames(orphans.topProcesses)}`,
    }] : []),
    ...(runner && runner.cpuPct >= HEAVY_CPU_PCT ? [{
      kind: "runner_heavy" as const,
      summary: `processes of no card use ${formatCores(runner.cpuPct)}: ${joinProcessNames(runner.topProcesses)}`,
    }] : []),
    ...(others.cpuPct >= HEAVY_CPU_PCT ? [{
      kind: "others_heavy" as const,
      summary: `processes you cannot see (other people's cards, deleted cards, the runner itself) use ${formatCores(others.cpuPct)}`,
    }] : []),
  ];
  const unmeasured = listUnmeasured(snapshot);
  const findings: Finding[] = [
    ...(bottlenecks.length > 0 ? bottlenecks : [{
      kind: "no_runner_bottleneck" as const,
      summary: "nothing on the runner explains the delay: the time is the model answering (API) or the turn's own work, not the machine",
    }]),
    ...(unmeasured.length > 0 ? [{
      kind: "not_measured" as const,
      summary: `this runner does not expose ${unmeasured.join(", ")}: those were not checked`,
    }] : []),
  ];
  const { processes: _processes, ...machine } = snapshot;
  return { findings, machine, cards: cardUsages, orphans, ...(runner ? { runner } : {}), others };
}
