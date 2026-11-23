export interface ExhaustedAccount {
  accountSlug: string;
  renewsAt?: number;
}

export interface BackupChainInput {
  from: string;
  backupOf: (accountSlug: string) => string | undefined;
  exhausted: readonly ExhaustedAccount[];
  now: number;
}

function collectBackupChain(current: string, visited: readonly string[], backupOf: BackupChainInput["backupOf"]): string[] {
  const candidate = backupOf(current);
  if (candidate === undefined || visited.includes(candidate)) return visited.slice(1);
  return collectBackupChain(candidate, [...visited, candidate], backupOf);
}

export function backupChainOf(from: string, backupOf: BackupChainInput["backupOf"]): string[] {
  return collectBackupChain(from, [from], backupOf);
}

function isStillExhausted(accountSlug: string, exhausted: readonly ExhaustedAccount[], now: number): boolean {
  return exhausted.some((entry) => entry.accountSlug === accountSlug && (entry.renewsAt === undefined || entry.renewsAt > now));
}

export function nextBackupAccount(input: BackupChainInput): string | null {
  const available = backupChainOf(input.from, input.backupOf).find((accountSlug) => !isStillExhausted(accountSlug, input.exhausted, input.now));
  return available ?? null;
}
