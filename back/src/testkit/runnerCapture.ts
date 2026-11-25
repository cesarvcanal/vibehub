export interface CapturedProcess {
  pid: number;
  comm: string;
  ticksBefore?: number;
  ticksAfter?: number;
  startTicks: number;
  rssPages: number;
  cardId?: string;
  args?: string;
}

function procStatLine(pid: number, comm: string, cpuTicks: number, startTicks: number, rssPages: number): string {
  return `@pstat ${pid} (${comm}) R 1 1 1 0 -1 0 0 0 0 0 ${cpuTicks} 0 0 0 20 0 1 0 ${startTicks} 0 ${rssPages}`;
}

export function runnerCapture({ processes, secondSample = true }: { processes: CapturedProcess[]; secondSample?: boolean }): string {
  const header = ["@clk 100", "@pagesize 4096", "@ncpu 8", "@cpumax 800000 100000"];
  const sampleLines = (index: number, uptime: string, cpuLine: string, throttled: number, ticksOf: (process: CapturedProcess) => number | undefined) => [
    `@sample ${index}`,
    `@uptime ${uptime}`,
    `@cpu ${cpuLine}`,
    `@throttled ${throttled}`,
    ...processes.flatMap((process) => {
      const ticks = ticksOf(process);
      return ticks === undefined ? [] : [procStatLine(process.pid, process.comm, ticks, process.startTicks, process.rssPages)];
    }),
  ];
  const first = sampleLines(1, "1000.00", "cpu  1000 0 1000 1000 1000 0 1000 1000 0 0", 0, (process) => process.ticksBefore);
  const second = sampleLines(2, "1002.00", "cpu  1300 0 1080 1120 1040 0 1020 1440 0 0", 400_000, (process) => process.ticksAfter);
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
    ...processes.flatMap((process) => (process.cardId ? [`@card ${process.pid} ${process.cardId}`] : [])),
    ...processes.flatMap((process) => (process.args ? [`@args ${process.pid} ${process.args}`] : [])),
  ];
  return [...header, ...first, ...(secondSample ? second : []), ...tail].join("\n");
}
