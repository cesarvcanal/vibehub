export interface ExhaustedAccount {
  account: string;
  renewsAt?: number;
}

export interface BackupChainInput {
  from: string;
  backupOf: (account: string) => string | undefined;
  exhausted: readonly ExhaustedAccount[];
  now: number;
}

function isStillExhausted(account: string, exhausted: readonly ExhaustedAccount[], now: number): boolean {
  return exhausted.some((entry) => entry.account === account && (entry.renewsAt === undefined || entry.renewsAt > now));
}

function walkBackupChain(current: string, visited: ReadonlySet<string>, input: BackupChainInput): string | null {
  const candidate = input.backupOf(current);
  if (candidate === undefined || visited.has(candidate)) return null;
  if (!isStillExhausted(candidate, input.exhausted, input.now)) return candidate;
  return walkBackupChain(candidate, new Set([...visited, candidate]), input);
}

export function nextBackupAccount(input: BackupChainInput): string | null {
  return walkBackupChain(input.from, new Set([input.from]), input);
}
