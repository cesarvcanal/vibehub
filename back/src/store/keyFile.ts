import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * A 32-byte key kept as hex in its own file (mode 600) under the data dir: read when it exists,
 * generated and written once when it does not, so a fresh install just works. `created` tells the
 * caller this call minted it — losing that file means losing whatever the key protects.
 */
export async function loadOrCreateKeyFile(file: string): Promise<{ key: Buffer; created: boolean }> {
  try {
    const stored = (await readFile(file, "utf8")).trim();
    if (stored) return { key: Buffer.from(stored, "hex"), created: false };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  const key = randomBytes(32);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, key.toString("hex"), { encoding: "utf8", mode: 0o600 });
  await chmod(file, 0o600);
  return { key, created: true };
}
