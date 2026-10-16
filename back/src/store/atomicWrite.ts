import { open, rename, rm } from "node:fs/promises";
import type { Stats } from "node:fs";
import { randomBytes } from "node:crypto";

/**
 * The tmp name a write in progress uses: `<file>.<pid>.<8 hex>.tmp`. A SIGKILL between the open and
 * the rename leaves one behind for good — with the whole new content inside — so the sweeps and the
 * card purge recognize it by this shape.
 */
const ATOMIC_TMP_RE = /\.\d+\.[0-9a-f]{8}\.tmp$/;

/** Is `name` a tmp that {@link writeFileAtomic} left behind for `target` (any target when omitted)? */
export function isAtomicWriteTmp(name: string, target?: string): boolean {
  if (!ATOMIC_TMP_RE.test(name)) return false;
  return target === undefined || name.startsWith(`${target}.`);
}

/**
 * Replaces `file` with `text` all at once: a reader (or a crash) sees the old content or the new,
 * never half of it. Returns the new file's stats — the inode survives the rename, so they identify
 * THIS write (see JsonStore's revalidation).
 *
 * The tmp name is unique per write, not `${file}.tmp`: in a blue/green deploy two backs write the
 * same /data at once, and a shared tmp let one truncate the other's half-written file or rename it
 * away underneath it (ENOENT). fsync before the rename, so a power cut cannot leave the renamed
 * file empty.
 */
export async function writeFileAtomic(file: string, text: string, mode = 0o600): Promise<Stats> {
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    const handle = await open(tmp, "w", mode);
    let stats: Stats;
    try {
      await handle.writeFile(text, "utf8");
      // An existing umask can strip bits from open()'s mode; chmod states it exactly.
      await handle.chmod(mode);
      await handle.sync();
      stats = await handle.stat();
    } finally {
      await handle.close();
    }
    await rename(tmp, file);
    return stats;
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
}
