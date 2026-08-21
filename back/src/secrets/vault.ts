import { randomBytes, createCipheriv, createDecipheriv, scryptSync } from "node:crypto";
import { readFile, writeFile, mkdir, chmod, rename } from "node:fs/promises";
import { dirname } from "node:path";
import { config, dataPath } from "../config/env.js";
import { logger } from "../utils/logger.js";

/**
 * LOCAL VAULT — every secret vibehub holds (Claude long-lived tokens, GitHub token, MCP env values,
 * the runner service token) lives here: one AES-256-GCM encrypted file, mode 600.
 *
 * The master key comes from VIBEHUB_SECRET_KEY when set; otherwise it is generated once into
 * <dataDir>/master.key so a fresh `docker compose up` just works. Losing that key means losing the
 * secrets — that is the point, and the wizard says so out loud.
 */

const VAULT_FILE = () => dataPath("secrets.enc");
const KEY_FILE = () => dataPath("master.key");

interface VaultDoc {
  /** key -> secret value, plaintext only in memory and inside the encrypted blob. */
  secrets: Record<string, string>;
  /** key -> ISO timestamp of last write, safe to show in the UI. */
  updatedAt: Record<string, string>;
}

let keyPromise: Promise<Buffer> | null = null;
let cache: VaultDoc | null = null;
let queue: Promise<unknown> = Promise.resolve();

/** Secret keys are uppercase identifiers — they become env var names in the runner. */
export function assertSecretKey(key: string): string {
  const v = String(key ?? "").trim();
  if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(v)) {
    throw new Error(`invalid secret key '${key}' (expected UPPER_SNAKE_CASE, max 64 chars)`);
  }
  return v;
}

async function masterKey(): Promise<Buffer> {
  if (!keyPromise) keyPromise = loadOrCreateKey();
  return await keyPromise;
}

async function loadOrCreateKey(): Promise<Buffer> {
  if (config.secretKey) return scryptSync(config.secretKey, "vibehub-vault", 32);
  const file = KEY_FILE();
  try {
    const stored = (await readFile(file, "utf8")).trim();
    if (stored) return Buffer.from(stored, "hex");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  const key = randomBytes(32);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, key.toString("hex"), { encoding: "utf8", mode: 0o600 });
  await chmod(file, 0o600);
  logger.warn({ file }, "generated a new vault master key — back this file up, secrets are lost without it");
  return key;
}

function encrypt(key: Buffer, plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return [iv.toString("base64"), cipher.getAuthTag().toString("base64"), body.toString("base64")].join(".");
}

function decrypt(key: Buffer, blob: string): string {
  const [ivB64, tagB64, bodyB64] = blob.split(".");
  if (!ivB64 || !tagB64 || !bodyB64) throw new Error("vault file is corrupt (bad envelope)");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(bodyB64, "base64")), decipher.final()]).toString("utf8");
}

async function load(): Promise<VaultDoc> {
  if (cache) return cache;
  try {
    const blob = await readFile(VAULT_FILE(), "utf8");
    const parsed = JSON.parse(decrypt(await masterKey(), blob.trim())) as Partial<VaultDoc>;
    cache = { secrets: parsed.secrets ?? {}, updatedAt: parsed.updatedAt ?? {} };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      if (code === undefined) throw new Error(`cannot open the vault: ${(err as Error).message}. Wrong VIBEHUB_SECRET_KEY?`);
      throw err;
    }
    cache = { secrets: {}, updatedAt: {} };
  }
  return cache;
}

async function persist(doc: VaultDoc): Promise<void> {
  const file = VAULT_FILE();
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await writeFile(tmp, encrypt(await masterKey(), JSON.stringify(doc)), { encoding: "utf8", mode: 0o600 });
  await chmod(tmp, 0o600);
  await rename(tmp, file);
  cache = doc;
}

function mutate<R>(fn: (doc: VaultDoc) => R): Promise<R> {
  const run = async (): Promise<R> => {
    const doc = await load();
    const result = fn(doc);
    await persist(doc);
    return result;
  };
  const next = queue.then(run, run);
  queue = next.catch(() => undefined);
  return next;
}

/** Reads a secret. Missing key = undefined (callers decide whether that is fatal). */
export async function secretGet(key: string): Promise<string | undefined> {
  const doc = await load();
  return doc.secrets[assertSecretKey(key)];
}

/** Writes (or overwrites) a secret. */
export async function secretSet(key: string, value: string): Promise<void> {
  const k = assertSecretKey(key);
  if (typeof value !== "string" || value === "") throw new Error(`secret '${k}' cannot be empty`);
  await mutate((doc) => {
    doc.secrets[k] = value;
    doc.updatedAt[k] = new Date().toISOString();
  });
}

/** Reads a secret, creating it from `make()` the first time. Used for service tokens. */
export async function secretEnsure(key: string, make: () => string): Promise<string> {
  const existing = await secretGet(key);
  if (existing) return existing;
  const value = make();
  await secretSet(key, value);
  return value;
}

export async function secretDelete(key: string): Promise<boolean> {
  const k = assertSecretKey(key);
  return await mutate((doc) => {
    const had = k in doc.secrets;
    delete doc.secrets[k];
    delete doc.updatedAt[k];
    return had;
  });
}

/** Lists keys and write times — NEVER values. This is what the UI renders. */
export async function secretList(): Promise<{ key: string; updatedAt: string | null }[]> {
  const doc = await load();
  return Object.keys(doc.secrets)
    .sort()
    .map((key) => ({ key, updatedAt: doc.updatedAt[key] ?? null }));
}

export function resetVaultForTesting(): void {
  cache = null;
  keyPromise = null;
  queue = Promise.resolve();
}
