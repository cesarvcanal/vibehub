import { randomUUID } from "node:crypto";
import { dataPath } from "../../config/env.js";
import { JsonStore } from "../../store/jsonStore.js";
import { secretGet, secretSet, secretDelete } from "../../secrets/vault.js";
import { getCard } from "../board/registry.js";
import { logger } from "../../utils/logger.js";

/**
 * COFRE — named login credentials for the systems the cards' browsers sign in to.
 *
 * THE INVARIANT OF THIS WHOLE FEATURE: a credential's VALUE never travels through a model, a chat,
 * a transcript or a log. The agent only ever sees NAMES (via `vibehub_credential_list`); the value
 * goes from the vault straight into the card's Chromium over CDP (see `fill.ts`), outside any LLM
 * context. The UI is write-only, like every other secret in Settings.
 *
 * Credentials are INSTALL-WIDE — no per-project scope. It is one company's own systems; any card
 * may fill any credential. This module's JSON store holds the SHAPE of a credential (name, type),
 * never a value; the vault holds the values under the `CRED_<ID>_*` namespace.
 */

export type CredentialType = "userpass" | "token";

export interface Credential {
  /** 12 hex chars (a uuid without dashes, truncated) — it becomes part of a vault key, hence [0-9a-f]. */
  id: string;
  /** How the agent refers to it ("erp-prod", "space_admin"). Unique, never a value. */
  name: string;
  /** "userpass" = a username + password pair; "token" = a single secret value. */
  type: CredentialType;
  createdAt: number;
  /** Last time the credential was filled into a browser (ISO). Safe to show; drives no logic. */
  usedAt?: string;
}

interface CredentialsDoc {
  credentials: Credential[];
}

const store = new JsonStore<CredentialsDoc>(
  dataPath("credentials.json"),
  () => ({ credentials: [] }),
  (raw) => {
    const doc = raw as Partial<CredentialsDoc>;
    return { credentials: Array.isArray(doc.credentials) ? doc.credentials : [] };
  },
);

/** Credential ids are 12 hex chars — they become part of a vault key, so the charset is enforced. */
const CRED_ID_RE = /^[0-9a-f]{12}$/;

/** Names the agent can type without quoting games; also what shows in the UI list. */
const CRED_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{1,39}$/;

export function assertCredentialName(name: string): string {
  const v = String(name ?? "").trim();
  if (!CRED_NAME_RE.test(v)) {
    throw new Error(
      `invalid credential name '${name}' (2-40 chars: letters, digits, '_', '.', '-'; must start alphanumeric)`,
    );
  }
  return v;
}

/**
 * Turns a host (or any suggestion) into a valid credential name — used when a capture proposes a
 * default name from the login page's host. Falls back to a generated stub if nothing survives. PURE.
 */
export function suggestCredentialName(hint: string): string {
  const base = String(hint ?? "")
    .replace(/^https?:\/\//i, "")
    .replace(/[/:].*$/, "")
    .replace(/^www\./i, "")
    .replace(/[^A-Za-z0-9_.-]/g, "-")
    .replace(/^[^A-Za-z0-9]+/, "")
    .slice(0, 40);
  return CRED_NAME_RE.test(base) ? base : `login-${randomUUID().slice(0, 4)}`;
}

/** Vault key of one part of a credential: `CRED_<ID_UPPER>_<PART>`. PURE. */
export function credentialSecretKey(id: string, part: "USER" | "PASS" | "VALUE"): string {
  if (!CRED_ID_RE.test(String(id ?? ""))) throw new Error(`invalid credential id: '${id}'`);
  return `CRED_${id.toUpperCase()}_${part}`;
}

export interface CreateCredentialInput {
  name: string;
  type: CredentialType;
  /** userpass only. */
  username?: string;
  password?: string;
  /** token only. */
  value?: string;
}

/**
 * Creates a credential: metadata in the store, values in the vault. The values arrive here from the
 * HTTP route (the owner typed them in Settings, or accepted a capture), are written once, and are
 * NEVER returned, listed or logged — the only reader is the fill path.
 */
export async function createCredential(input: CreateCredentialInput, by?: string): Promise<Credential> {
  const name = assertCredentialName(input.name);
  const type = input.type;
  if (type !== "userpass" && type !== "token") throw new Error(`invalid credential type '${String(type)}'`);

  if (type === "userpass") {
    if (!String(input.username ?? "")) throw new Error("username is required for a user+password credential");
    if (!String(input.password ?? "")) throw new Error("password is required for a user+password credential");
  } else if (!String(input.value ?? "")) {
    throw new Error("value is required for a token credential");
  }

  const credential: Credential = {
    id: randomUUID().replace(/-/g, "").slice(0, 12),
    name,
    type,
    createdAt: Date.now(),
  };

  // Metadata first (name uniqueness is decided inside the store's mutation queue), then the vault.
  await store.mutate((doc) => {
    if (doc.credentials.some((c) => c.name.toLowerCase() === name.toLowerCase())) {
      throw new Error(`a credential named '${name}' already exists`);
    }
    doc.credentials.push(credential);
  });
  try {
    if (type === "userpass") {
      await secretSet(credentialSecretKey(credential.id, "USER"), String(input.username));
      await secretSet(credentialSecretKey(credential.id, "PASS"), String(input.password));
    } else {
      await secretSet(credentialSecretKey(credential.id, "VALUE"), String(input.value));
    }
  } catch (err) {
    // A vault write that failed must not leave a phantom entry the fill path can never resolve.
    await store.mutate((doc) => {
      doc.credentials = doc.credentials.filter((c) => c.id !== credential.id);
    });
    throw err;
  }

  logger.info(
    { audit: true, action: "credential.create", credential: name, id: credential.id, type, by },
    "credential stored in the vault",
  );
  return credential;
}

/** Removes a credential AND its vault values, so a secret never outlives its entry. */
export async function deleteCredential(id: string, by?: string): Promise<boolean> {
  if (!CRED_ID_RE.test(String(id ?? ""))) return false;
  const removed = await store.mutate((doc) => {
    const found = doc.credentials.find((c) => c.id === id);
    doc.credentials = doc.credentials.filter((c) => c.id !== id);
    return found;
  });
  if (!removed) return false;
  await secretDelete(credentialSecretKey(id, "USER"));
  await secretDelete(credentialSecretKey(id, "PASS"));
  await secretDelete(credentialSecretKey(id, "VALUE"));
  logger.info(
    { audit: true, action: "credential.delete", credential: removed.name, id, by },
    "credential removed from the vault",
  );
  return true;
}

/** Every credential's METADATA (never values), for Settings → Cofre and the fill tool's list. */
export async function listCredentials(): Promise<Credential[]> {
  const doc = await store.load();
  return [...doc.credentials].sort((a, b) => a.name.localeCompare(b.name));
}

export interface CardCredential {
  name: string;
  type: CredentialType;
}

/** The credentials a card may use (all of them — install-wide). Names and types only, no values. */
export async function credentialsForCard(cardId: string): Promise<CardCredential[]> {
  const card = await getCard(cardId);
  if (!card) throw new Error("card not found");
  return (await listCredentials()).map((c) => ({ name: c.name, type: c.type }));
}

export interface ResolvedCredential {
  credential: Credential;
  /** userpass only. */
  username?: string;
  /** The password (userpass) or the token value. NEVER return this to a tool response or a log. */
  secret: string;
}

/**
 * Resolves a credential BY NAME. This is the ONLY function that hands out values, and its only
 * caller is the CDP fill path. A missing name throws with guidance to add it in Settings — never a
 * request for the value in the chat.
 */
export async function resolveCredential(name: string): Promise<ResolvedCredential> {
  const wanted = String(name ?? "").trim();
  const credential = (await listCredentials()).find((c) => c.name.toLowerCase() === wanted.toLowerCase());
  if (!credential) {
    throw new Error(
      `credential '${wanted}' is not in the vault — ask the user to add it in Settings → Cofre (never ask for the value in the chat)`,
    );
  }
  if (credential.type === "userpass") {
    const username = await secretGet(credentialSecretKey(credential.id, "USER"));
    const secret = await secretGet(credentialSecretKey(credential.id, "PASS"));
    if (!username || !secret) throw new Error(`credential '${credential.name}' has no stored value — re-create it in Settings → Cofre`);
    return { credential, username, secret };
  }
  const secret = await secretGet(credentialSecretKey(credential.id, "VALUE"));
  if (!secret) throw new Error(`credential '${credential.name}' has no stored value — re-create it in Settings → Cofre`);
  return { credential, secret };
}

/** Stamps a credential as just used (fill succeeded). Best-effort; never carries a value. */
export async function markCredentialUsed(id: string): Promise<void> {
  await store.mutate((doc) => {
    const c = doc.credentials.find((x) => x.id === id);
    if (c) c.usedAt = new Date().toISOString();
  });
}

export function resetCredentialsForTesting(): void {
  store.resetForTesting();
}
