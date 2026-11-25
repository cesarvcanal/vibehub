import { config } from "../../config/env.js";
import { containerScriptCommand, hostExecutor } from "../../runtime/host.js";

export const SAMPLE_SECONDS = 2;
const SNAPSHOT_TIMEOUT_MS = 30_000;
const SCRIPT_DELIM = "VIBEHUB_DIAGNOSTICS";
const ARGS_MAX_CHARS = 160;
const SECRET_ASSIGNMENT_RE = /([\w.-]*(?:token|secret|key|pass|auth)[\w.-]*)=("[^"]*"|'[^']*'|\S+)/gi;
const SECRET_LITERAL_RE = /\b(?:sk-ant-|gh[pousr]_)[\w-]+/g;

export interface RunnerProcess {
  pid: number;
  comm: string;
  cardId?: string;
  cpuPct: number;
  rssMb: number;
  ageSeconds: number;
  args: string;
}

export interface RunnerSnapshot {
  intervalSeconds: number;
  cpu: {
    cores: number;
    limitCores?: number;
    userPct: number;
    systemPct: number;
    iowaitPct: number;
    stealPct: number;
    idlePct: number;
    throttledPct: number;
  };
  load: number[];
  pressure: { cpuSome: number; memorySome: number; ioSome: number; ioFull: number };
  memory: { totalMb: number; availableMb: number; swapTotalMb: number; swapUsedMb: number };
  disk: { usedPct: number };
  processes: RunnerProcess[];
}

interface ProcessSample {
  comm: string;
  cpuTicks: number;
  startTicks: number;
  rssPages: number;
}

interface Sample {
  uptimeSeconds: number;
  cpuTicks: number[];
  throttledUsec: number;
  processes: Map<number, ProcessSample>;
}

export function runnerSnapshotScript(container: string): string {
  return [
    `${containerScriptCommand(container, SNAPSHOT_TIMEOUT_MS)} <<'${SCRIPT_DELIM}'`,
    "sample() {",
    '  echo "@sample $1"',
    "  echo \"@uptime $(cut -d' ' -f1 /proc/uptime)\"",
    '  echo "@cpu $(head -n1 /proc/stat)"',
    "  echo \"@throttled $(sed -n 's/^throttled_usec //p' /sys/fs/cgroup/cpu.stat 2>/dev/null)\"",
    '  for stat in /proc/[0-9]*/stat; do read -r line < "$stat" 2>/dev/null && echo "@pstat $line"; done',
    "}",
    'echo "@clk $(getconf CLK_TCK)"',
    'echo "@pagesize $(getconf PAGESIZE)"',
    'echo "@ncpu $(nproc)"',
    'echo "@cpumax $(cat /sys/fs/cgroup/cpu.max 2>/dev/null)"',
    "sample 1",
    `sleep ${SAMPLE_SECONDS}`,
    "sample 2",
    'echo "@loadavg $(cat /proc/loadavg)"',
    'for kind in cpu memory io; do sed "s/^/@pressure $kind /" "/proc/pressure/$kind" 2>/dev/null; done',
    "grep -E '^(MemTotal|MemAvailable|SwapTotal|SwapFree):' /proc/meminfo | sed 's/^/@mem /'",
    "echo \"@disk $(df -P /work 2>/dev/null | awk 'NR==2 {print $3, $2}')\"",
    "grep -asoz '^VIBEHUB_CARD_ID=[0-9a-f-]*' /proc/[0-9]*/environ 2>/dev/null | tr '\\0' '\\n' |",
    "  sed -n 's#^/proc/\\([0-9]*\\)/environ:VIBEHUB_CARD_ID=#@card \\1 #p'",
    "ps -eo pid=,args= -ww 2>/dev/null | sed 's/^ */@args /'",
    SCRIPT_DELIM,
  ].join("\n");
}

export async function readRunnerSnapshot(): Promise<RunnerSnapshot> {
  const { stdout } = await hostExecutor().runScript(runnerSnapshotScript(config.runner.container), {
    timeoutMs: SNAPSHOT_TIMEOUT_MS,
  });
  return parseRunnerSnapshot(stdout);
}

function parseProcessStat(line: string): [number, ProcessSample] | undefined {
  const commStart = line.indexOf(" (");
  const commEnd = line.lastIndexOf(")");
  if (commStart < 0 || commEnd < commStart) return undefined;
  const fieldsAfterComm = line.slice(commEnd + 2).split(" ");
  const utime = Number(fieldsAfterComm[11]);
  const stime = Number(fieldsAfterComm[12]);
  return [
    Number(line.slice(0, commStart)),
    {
      comm: line.slice(commStart + 2, commEnd),
      cpuTicks: utime + stime,
      startTicks: Number(fieldsAfterComm[19]),
      rssPages: Number(fieldsAfterComm[21]),
    },
  ];
}

function splitTag(line: string): [string, string] {
  const space = line.indexOf(" ");
  return space < 0 ? [line, ""] : [line.slice(0, space), line.slice(space + 1)];
}

function redactArgs(args: string): string {
  return args
    .replace(SECRET_ASSIGNMENT_RE, "$1=<redacted>")
    .replace(SECRET_LITERAL_RE, "<redacted>")
    .slice(0, ARGS_MAX_CHARS);
}

function percentOf(part: number, total: number): number {
  return total > 0 ? Math.round((1000 * part) / total) / 10 : 0;
}

function avg10(pressureLine: string | undefined): number {
  return Number(/avg10=([\d.]+)/.exec(pressureLine ?? "")?.[1] ?? 0);
}

export function parseRunnerSnapshot(raw: string): RunnerSnapshot {
  const header = new Map<string, string>();
  const samples: Sample[] = [];
  const pressureLines = new Map<string, string>();
  const memoryKb = new Map<string, number>();
  const cardByPid = new Map<number, string>();
  const argsByPid = new Map<number, string>();

  for (const line of raw.split("\n")) {
    const [tag, value] = splitTag(line);
    const current = samples.at(-1);
    if (tag === "@sample") samples.push({ uptimeSeconds: 0, cpuTicks: [], throttledUsec: 0, processes: new Map() });
    else if (tag === "@uptime" && current) current.uptimeSeconds = Number(value);
    else if (tag === "@cpu" && current) current.cpuTicks = value.trim().split(/\s+/).slice(1).map(Number);
    else if (tag === "@throttled" && current) current.throttledUsec = Number(value) || 0;
    else if (tag === "@pstat" && current) {
      const parsed = parseProcessStat(value);
      if (parsed) current.processes.set(...parsed);
    } else if (tag === "@pressure") {
      const [kind, rest] = splitTag(value);
      const [scope] = splitTag(rest);
      pressureLines.set(`${kind} ${scope}`, rest);
    } else if (tag === "@mem") {
      const [name, kb] = value.split(/:\s+/);
      memoryKb.set(name!, Number.parseInt(kb ?? "", 10));
    } else if (tag === "@card") {
      const [pid, cardId] = splitTag(value);
      cardByPid.set(Number(pid), cardId);
    } else if (tag === "@args") {
      const [pid, args] = splitTag(value);
      argsByPid.set(Number(pid), args);
    } else if (tag.startsWith("@")) header.set(tag, value);
  }

  const [first, second] = samples;
  if (!first || !second || !header.has("@loadavg")) throw new Error("runner snapshot incomplete: the reading was cut before it finished");

  const clockTicks = Number(header.get("@clk"));
  const pageBytes = Number(header.get("@pagesize"));
  const intervalSeconds = second.uptimeSeconds - first.uptimeSeconds;
  const [user = 0, nice = 0, system = 0, idle = 0, iowait = 0, irq = 0, softirq = 0, steal = 0] =
    second.cpuTicks.map((ticks, index) => ticks - (first.cpuTicks[index] ?? 0));
  const totalTicks = user + nice + system + idle + iowait + irq + softirq + steal;
  const [quota, period] = (header.get("@cpumax") ?? "").split(" ");
  const limitCores = quota && quota !== "max" ? Number(quota) / Number(period) : undefined;

  const processes = [...second.processes].map(([pid, process]): RunnerProcess => {
    const ticksBefore = first.processes.get(pid)?.cpuTicks ?? 0;
    const cardId = cardByPid.get(pid);
    return {
      pid,
      comm: process.comm,
      ...(cardId ? { cardId } : {}),
      cpuPct: Math.round((100 * (process.cpuTicks - ticksBefore)) / clockTicks / intervalSeconds),
      rssMb: Math.round((process.rssPages * pageBytes) / 1024 / 1024),
      ageSeconds: Math.round(second.uptimeSeconds - process.startTicks / clockTicks),
      args: redactArgs(argsByPid.get(pid) ?? ""),
    };
  });

  const [diskUsed = 0, diskTotal = 0] = (header.get("@disk") ?? "").split(" ").map(Number);
  const kbToMb = (name: string) => Math.round((memoryKb.get(name) ?? 0) / 1024);
  return {
    intervalSeconds: Math.round(intervalSeconds * 100) / 100,
    cpu: {
      cores: Number(header.get("@ncpu")),
      ...(limitCores ? { limitCores } : {}),
      userPct: percentOf(user + nice, totalTicks),
      systemPct: percentOf(system + irq + softirq, totalTicks),
      iowaitPct: percentOf(iowait, totalTicks),
      stealPct: percentOf(steal, totalTicks),
      idlePct: percentOf(idle, totalTicks),
      throttledPct: percentOf((second.throttledUsec - first.throttledUsec) / 1e6, intervalSeconds),
    },
    load: (header.get("@loadavg") ?? "").split(" ").slice(0, 3).map(Number),
    pressure: {
      cpuSome: avg10(pressureLines.get("cpu some")),
      memorySome: avg10(pressureLines.get("memory some")),
      ioSome: avg10(pressureLines.get("io some")),
      ioFull: avg10(pressureLines.get("io full")),
    },
    memory: {
      totalMb: kbToMb("MemTotal"),
      availableMb: kbToMb("MemAvailable"),
      swapTotalMb: kbToMb("SwapTotal"),
      swapUsedMb: kbToMb("SwapTotal") - kbToMb("SwapFree"),
    },
    disk: { usedPct: percentOf(diskUsed, diskTotal) },
    processes,
  };
}
