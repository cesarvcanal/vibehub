import type { Card } from "../board/registry.js";
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

export type DiagnosedCard = Pick<Card, "id" | "title" | "column" | "status">;

export interface ProcessGroup {
  cpuPct: number;
  rssMb: number;
  processCount: number;
  processes: RunnerProcess[];
}

export interface CardUsage {
  id: string;
  title: string;
  column: Card["column"];
  status: Card["status"] | null;
  cpuPct: number;
  rssMb: number;
  processCount: number;
  topProcesses: RunnerProcess[];
}

type ProcessPlace = { kind: "card"; card: DiagnosedCard } | { kind: "orphan" | "runner" | "hidden" };

export type FindingKind =
  | "server_steal" | "cpu_limit" | "cpu_saturated" | "disk_io" | "memory"
  | "heavy_card" | "idle_card_busy" | "orphan_processes" | "others_heavy" | "no_runner_bottleneck";

export interface Finding {
  kind: FindingKind;
  summary: string;
}

export interface SlownessReport {
  findings: Finding[];
  machine: Omit<RunnerSnapshot, "processes">;
  cards: CardUsage[];
  orphans: ProcessGroup;
  runner?: ProcessGroup;
  others: Omit<ProcessGroup, "processes">;
}

function sumUsage(processes: readonly RunnerProcess[]): Omit<ProcessGroup, "processes"> {
  return {
    cpuPct: processes.reduce((total, process) => total + process.cpuPct, 0),
    rssMb: processes.reduce((total, process) => total + process.rssMb, 0),
    processCount: processes.length,
  };
}

function heaviestProcesses(processes: readonly RunnerProcess[]): RunnerProcess[] {
  return [...processes]
    .sort((left, right) => right.cpuPct - left.cpuPct || right.rssMb - left.rssMb)
    .slice(0, TOP_PROCESSES_PER_GROUP);
}

function groupOf(processes: readonly RunnerProcess[]): ProcessGroup {
  return { ...sumUsage(processes), processes: heaviestProcesses(processes) };
}

function cores(cpuPct: number): string {
  return `${Math.round(cpuPct) / 100} cores`;
}

function processNames(processes: readonly RunnerProcess[]): string {
  return processes.map((process) => process.comm).join(", ");
}

function machineFindings({ cpu, pressure, memory }: RunnerSnapshot): Finding[] {
  const memoryLow = memory.availableMb < memory.totalMb * MEMORY_AVAILABLE_LOW_RATIO || pressure.memorySome >= MEMORY_PRESSURE_SLOW_PCT;
  const candidates: [applies: boolean, finding: Finding][] = [
    [cpu.stealPct >= STEAL_SLOW_PCT, {
      kind: "server_steal",
      summary: `the hypervisor took ${cpu.stealPct}% of the CPU: the VPS shares its physical cores with other machines, so everything runs slower — nothing in vibehub fixes this, the hosting plan does`,
    }],
    [cpu.throttledPct >= THROTTLE_SLOW_PCT, {
      kind: "cpu_limit",
      summary: `the runner container hit its CPU limit (${cpu.limitCores ?? cpu.cores} cores) during ${cpu.throttledPct}% of the reading`,
    }],
    [cpu.idlePct < IDLE_SATURATED_PCT, {
      kind: "cpu_saturated",
      summary: `the machine's CPU is saturated (${cpu.idlePct}% idle): processes queue for a core`,
    }],
    [pressure.ioFull >= IO_FULL_SLOW_PCT, {
      kind: "disk_io",
      summary: `every process stalled on disk ${pressure.ioFull}% of the last 10 s`,
    }],
    [memoryLow, {
      kind: "memory",
      summary: `memory is short: ${memory.availableMb} MB available of ${memory.totalMb} MB, ${memory.swapUsedMb} MB in swap`,
    }],
  ];
  return candidates.filter(([applies]) => applies).map(([, finding]) => finding);
}

function cardFindings(cards: readonly CardUsage[]): Finding[] {
  return cards.flatMap((card): Finding[] => {
    const turnRunning = card.status === "working" && card.column !== "paused";
    const top = processNames(card.topProcesses);
    if (card.cpuPct >= HEAVY_CPU_PCT) {
      return [{ kind: "heavy_card", summary: `card '${card.title}' (${card.id}) uses ${cores(card.cpuPct)}: ${top}` }];
    }
    if (!turnRunning && card.cpuPct >= IDLE_CARD_BUSY_CPU_PCT) {
      return [{
        kind: "idle_card_busy",
        summary: `card '${card.title}' (${card.id}) is not running a turn but its processes use ${card.cpuPct}% CPU: ${top}`,
      }];
    }
    return [];
  });
}

export function diagnoseSlowness(
  snapshot: RunnerSnapshot,
  cards: readonly DiagnosedCard[],
  visibleCardIds: ReadonlySet<string>,
  seesEverything: boolean,
): SlownessReport {
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
    ...sumUsage(processes), topProcesses: heaviestProcesses(processes),
  })).sort((left, right) => right.cpuPct - left.cpuPct);

  const orphans = groupOf(processesIn("orphan"));
  const others = sumUsage(processesIn("hidden"));
  const findings = [
    ...machineFindings(snapshot),
    ...cardFindings(cardUsages),
    ...(orphans.processCount > 0 ? [{
      kind: "orphan_processes" as const,
      summary: `${orphans.processCount} processes of concluded or deleted cards are still alive, holding ${orphans.rssMb} MB and ${orphans.cpuPct}% CPU: ${processNames(orphans.processes)}`,
    }] : []),
    ...(others.cpuPct >= HEAVY_CPU_PCT ? [{
      kind: "others_heavy" as const,
      summary: `cards you cannot see use ${cores(others.cpuPct)} of the runner`,
    }] : []),
  ];
  const { processes: _processes, ...machine } = snapshot;
  return {
    findings: findings.length > 0 ? findings : [{
      kind: "no_runner_bottleneck",
      summary: "nothing on the runner explains the delay: the time is the model answering (API) or the turn's own work, not the machine",
    }],
    machine,
    cards: cardUsages,
    orphans,
    ...(seesEverything ? { runner: groupOf(processesIn("runner")) } : {}),
    others,
  };
}
