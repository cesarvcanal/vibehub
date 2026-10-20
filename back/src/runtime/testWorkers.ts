/**
 * Worker cap for test runners started inside the runner: every card session and the gate carry it.
 *
 * The runner's cores are shared by EVERY card. A bare `vitest run` sizes its pool to the CPU count,
 * so ten cards running their suites at once meant ~80 workers on 8 cores (load average 50 on
 * 2026-10-20) and every command — a typecheck, a git call, the gate — took ten times longer. Capped,
 * a lone run is a bit slower and a crowded runner stays usable.
 *
 * Vitest 2 reads these variables when resolving its pool (`VITEST_MAX_THREADS` / `VITEST_MAX_FORKS`,
 * plus the MIN ones so a min above the cap never fails the config). A repo's own explicit pool
 * config still wins.
 */
export const TEST_WORKER_CAP = 2;

export const TEST_WORKER_ENV: ReadonlyArray<readonly [string, string]> = [
  ["VITEST_MAX_THREADS", String(TEST_WORKER_CAP)],
  ["VITEST_MIN_THREADS", "1"],
  ["VITEST_MAX_FORKS", String(TEST_WORKER_CAP)],
  ["VITEST_MIN_FORKS", "1"],
];

/** `export K=V; ` for each variable — values are fixed digits, nothing to quote. PURE. */
export function testWorkerExports(): string {
  return TEST_WORKER_ENV.map(([k, v]) => `export ${k}=${v}; `).join("");
}

/** `-e K=V` pairs for `tmux new-session` (argv form). PURE. */
export function testWorkerTmuxArgs(): string[] {
  return TEST_WORKER_ENV.flatMap(([k, v]) => ["-e", `${k}=${v}`]);
}
