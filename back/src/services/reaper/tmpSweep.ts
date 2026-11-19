import { hostExecutor, shQuote, assertSafeRemotePath, containerScriptCommand } from "../../runtime/host.js";
import { config } from "../../config/env.js";
import { CARD_TMP_DIR_NAME } from "../board/cardTmp.js";
import { logger } from "../../utils/logger.js";

export const TMP_IDLE_MINUTES = 48 * 60;
export const TMP_ALERT_BYTES = 30 * 1024 ** 3;
export const DISK_ALERT_PERCENT = 80;
const TMP_ALERT_TOP = 5;
const TMP_SWEEP_INTERVAL_MS = 60 * 60_000;
export const TMP_SWEEP_TIMEOUT_MS = 10 * 60_000;
export const TMP_SWEEP_FAILURES_BEFORE_ALERT = 3;

const SWEEP_DELIM = "VIBEHUB_TMP_SWEEP";
const SWEPT_MARKER = "VIBEHUB_TMP_SWEPT";
const SIZE_MARKER = "VIBEHUB_TMP_SIZE";
const DISK_MARKER = "VIBEHUB_TMP_DISK";

const FILE_NAME_CHARS = "A-Za-z0-9._@+-";

const PROTECTED_NAMES = [CARD_TMP_DIR_NAME, "claude-*", "node-compile-cache", "tmux-*", "cc-socks", ".*-unix", ".X*-lock"];

export interface TmpEntrySize {
  path: string;
  bytes: number;
}

export interface TmpSweepReport {
  swept: TmpEntrySize[];
  sizes: TmpEntrySize[];
  diskPercent: number;
}

export interface TmpUsageAlert {
  tmpBytes: number;
  diskPercent: number;
  top: TmpEntrySize[];
}

function escapeExtendedRegex(text: string): string {
  return text.replace(/[.[\]{}()*+?^$|\\]/g, "\\$&");
}

export function buildTmpSweepScript(
  containerName: string,
  opts: { root?: string; idleMinutes?: number } = {},
): string {
  const root = opts.root ?? "/tmp";
  assertSafeRemotePath(root);
  if (root === "/") throw new Error("refusing to sweep the filesystem root");
  const idleMinutes = opts.idleMinutes ?? TMP_IDLE_MINUTES;
  if (!Number.isInteger(idleMinutes) || idleMinutes < 60) throw new Error(`idle window too short: ${idleMinutes} min`);
  const cardTmpRoot = `${root}/${CARD_TMP_DIR_NAME}`;
  const inUsePattern = shQuote(`${escapeExtendedRegex(root)}/[${FILE_NAME_CHARS}]+`);
  const protectedNames = PROTECTED_NAMES.map((name) => `! -name ${shQuote(name)}`).join(" ");
  return [
    "set -e",
    `${containerScriptCommand(containerName, TMP_SWEEP_TIMEOUT_MS)} <<'${SWEEP_DELIM}'`,
    `ROOT=${shQuote(root)}`,
    "renice -n 19 -p $$ >/dev/null 2>&1 || true",
    "ionice -c 3 -p $$ >/dev/null 2>&1 || true",
    "IN_USE=$( { awk 'NR > 1 {print $8}' /proc/net/unix; for PROC_DIR in /proc/[0-9]*; do readlink \"$PROC_DIR/cwd\"; " +
      "ls -l \"$PROC_DIR/fd\" 2>/dev/null | awk '{print $NF}'; " +
      `tr '\\0' '\\n' < "$PROC_DIR/cmdline"; tr '\\0' '\\n' < "$PROC_DIR/environ"; done; } 2>/dev/null | grep -oE ${inUsePattern} | sort -u || true)`,
    `find "$ROOT" -mindepth 1 -maxdepth 1 -mmin +${idleMinutes} ${protectedNames} -print0 2>/dev/null |`,
    "while IFS= read -r -d '' ENTRY; do",
    `  case "\${ENTRY##*/}" in *[!${FILE_NAME_CHARS}]*) continue ;; esac`,
    '  printf \'%s\\n\' "$IN_USE" | grep -qxF -- "$ENTRY" && continue',
    `  if [ -d "$ENTRY" ] && [ -n "$(find "$ENTRY" -mmin -${idleMinutes} -print -quit 2>/dev/null)" ]; then continue; fi`,
    '  ENTRY_KB=$(du -sxk -- "$ENTRY" 2>/dev/null | cut -f1)',
    `  rm -rf -- "$ENTRY" 2>/dev/null && printf '${SWEPT_MARKER}\\t%s\\t%s\\n' "\${ENTRY_KB:-0}" "$ENTRY" || true`,
    "done",
    ...[`"$ROOT" -mindepth 1 -maxdepth 1 ! -path ${shQuote(cardTmpRoot)}`, `${shQuote(cardTmpRoot)} -mindepth 1 -maxdepth 1`].map(
      (selection) =>
        `find ${selection} -exec du -sxk {} + 2>/dev/null |` +
        ` awk -F '\\t' '{print "${SIZE_MARKER}\\t" $1 "\\t" $2}' || true`,
    ),
    `printf '${DISK_MARKER}\\t%s\\n' "$(df -P "$ROOT" | awk 'NR == 2 {print $5 + 0}')"`,
    SWEEP_DELIM,
  ].join("\n");
}

function parseEntry(fields: string[]): TmpEntrySize | null {
  const kilobytes = Number.parseInt(fields[1] ?? "", 10);
  const path = fields[2];
  if (!Number.isFinite(kilobytes) || !path?.startsWith("/")) return null;
  return { path, bytes: kilobytes * 1024 };
}

export function parseTmpSweep(stdout: string): TmpSweepReport {
  const rows = stdout.split("\n").map((line) => line.split("\t"));
  const entriesMarked = (marker: string): TmpEntrySize[] =>
    rows.filter((fields) => fields[0] === marker).flatMap((fields) => parseEntry(fields) ?? []);
  const diskRow = rows.find((fields) => fields[0] === DISK_MARKER);
  const diskPercent = Number.parseInt(diskRow?.[1] ?? "", 10);
  if (!Number.isFinite(diskPercent)) throw new Error("the /tmp sweep did not report the disk usage");
  return { swept: entriesMarked(SWEPT_MARKER), sizes: entriesMarked(SIZE_MARKER), diskPercent };
}

export function tmpUsageAlert(report: TmpSweepReport): TmpUsageAlert | null {
  const tmpBytes = report.sizes.reduce((total, entry) => total + entry.bytes, 0);
  if (tmpBytes <= TMP_ALERT_BYTES && report.diskPercent <= DISK_ALERT_PERCENT) return null;
  const top = [...report.sizes].sort((left, right) => right.bytes - left.bytes).slice(0, TMP_ALERT_TOP);
  return { tmpBytes, diskPercent: report.diskPercent, top };
}

export async function sweepRunnerTmp(): Promise<TmpSweepReport> {
  const { stdout } = await hostExecutor().runScript(buildTmpSweepScript(config.runner.container), {
    timeoutMs: TMP_SWEEP_TIMEOUT_MS,
  });
  const report = parseTmpSweep(stdout);
  if (report.swept.length > 0) {
    logger.info(
      {
        audit: true,
        action: "runner.tmp_sweep",
        entries: report.swept.length,
        freedBytes: report.swept.reduce((total, entry) => total + entry.bytes, 0),
        swept: report.swept,
      },
      "loose /tmp entries idle for over 48h and unused by any process were removed from the runner",
    );
  }
  const alert = tmpUsageAlert(report);
  if (alert) {
    logger.warn(
      { audit: true, action: "runner.tmp_alert", ...alert },
      "the runner's /tmp or disk is above the alert threshold — the biggest entries are listed",
    );
  }
  return report;
}

export function startTmpSweep(intervalMs: number = TMP_SWEEP_INTERVAL_MS): () => void {
  const pass = { running: false, consecutiveFailures: 0 };
  const tick = (): void => {
    if (pass.running) return;
    pass.running = true;
    void sweepRunnerTmp()
      .then(() => {
        pass.consecutiveFailures = 0;
      })
      .catch((err: unknown) => {
        pass.consecutiveFailures += 1;
        const detail = (err as Error).message;
        if (pass.consecutiveFailures < TMP_SWEEP_FAILURES_BEFORE_ALERT) {
          logger.warn({ detail, failures: pass.consecutiveFailures }, "the /tmp sweep did not run this pass");
          return;
        }
        logger.error(
          { audit: true, action: "runner.tmp_sweep_failing", failures: pass.consecutiveFailures, detail },
          "the /tmp sweep keeps failing — the runner's /tmp is neither cleaned nor measured",
        );
      })
      .finally(() => {
        pass.running = false;
      });
  };
  tick();
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
