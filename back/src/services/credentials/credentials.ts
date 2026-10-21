import { randomInt, randomUUID } from "node:crypto";
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
 *
 * AGENT WRITES are the exception to "only the owner creates": an agent may GENERATE a credential
 * (vibehub makes the password, the agent never sees it) or save a login its own card's browser
 * captured — and only from a card whose PROJECT the owner opted in (`agentWriteProjects`, default
 * none). It can never overwrite an existing name, so it cannot clobber a credential a person made.
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
  /** Set when an AGENT wrote it: which card (and its project) — the audit trail the UI shows. */
  origin?: CredentialOrigin;
}

export interface CredentialOrigin {
  cardId: string;
  projectId: string;
  /** "generated" = vibehub made the password; "capture" = saved from the card browser's login. */
  via: "generated" | "capture";
}

interface CredentialsDoc {
  credentials: Credential[];
  /** Projects whose cards' agents may write to the Cofre. Owner-set; empty = no agent writes. */
  agentWriteProjects: string[];
}

const store = new JsonStore<CredentialsDoc>(
  dataPath("credentials.json"),
  () => ({ credentials: [], agentWriteProjects: [] }),
  (raw) => {
    const doc = raw as Partial<CredentialsDoc>;
    return {
      credentials: Array.isArray(doc.credentials) ? doc.credentials : [],
      agentWriteProjects: Array.isArray(doc.agentWriteProjects)
        ? doc.agentWriteProjects.filter((p): p is string => typeof p === "string")
        : [],
    };
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
export async function createCredential(
  input: CreateCredentialInput,
  by?: string,
  origin?: CredentialOrigin,
): Promise<Credential> {
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
    ...(origin ? { origin } : {}),
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
    {
      audit: true, action: "credential.create", credential: name, id: credential.id, type, by,
      ...(origin ? { card: origin.cardId, project: origin.projectId, via: origin.via } : {}),
    },
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

/* ------------------------------------------------------------ agent writes */

/** Which projects' agents may write to the Cofre. Owner-only data; safe to show (ids only). */
export async function agentWriteProjects(): Promise<string[]> {
  return [...(await store.load()).agentWriteProjects];
}

/** Replaces the opted-in project list (owner action from Settings → Cofre). Audited. */
export async function setAgentWriteProjects(projectIds: unknown, by?: string): Promise<string[]> {
  if (!Array.isArray(projectIds) || projectIds.some((p) => typeof p !== "string" || !p.trim())) {
    throw new Error("projectIds must be a list of project ids");
  }
  const next = [...new Set(projectIds.map((p: string) => p.trim()))].sort();
  await store.mutate((doc) => {
    doc.agentWriteProjects = next;
  });
  logger.info({ audit: true, action: "credential.agentWrite", projects: next, by }, "agent Cofre writes reconfigured");
  return next;
}

/**
 * The gate every agent write goes through: the card exists and its PROJECT is opted in. Returns the
 * origin to stamp on the credential. The refusal tells the agent what to ask the user for — never
 * a password.
 */
export async function authorizeAgentWrite(cardId: string, via: CredentialOrigin["via"]): Promise<CredentialOrigin> {
  const card = await getCard(cardId);
  if (!card) throw new Error("card not found");
  if (!(await agentWriteProjects()).includes(card.projectId)) {
    throw new Error(
      "agents of this card's project may not write to the Cofre — ask the owner to enable it in Settings → Cofre (never ask for a password in the chat)",
    );
  }
  return { cardId, projectId: card.projectId, via };
}

/** Password alphabet: no look-alikes (0/O, 1/l/I) and no quotes/backslash/space, which forms and shells mangle. */
const PASSWORD_CLASSES = [
  "ABCDEFGHJKLMNPQRSTUVWXYZ",
  "abcdefghijkmnopqrstuvwxyz",
  "23456789",
  "!#$%&()*+,-./:;<=>?@[]^_{|}~",
];
export const PASSWORD_MIN = 16;
export const PASSWORD_MAX = 128;
export const PASSWORD_DEFAULT = 32;

/**
 * A strong random password from the CSPRNG (`randomInt`, no modulo bias): `length` chars with at
 * least one of each class, positions shuffled (Fisher–Yates) so the guaranteed ones are not first.
 */
export function generatePassword(length: number = PASSWORD_DEFAULT): string {
  if (!Number.isInteger(length) || length < PASSWORD_MIN || length > PASSWORD_MAX) {
    throw new Error(`password length must be an integer between ${PASSWORD_MIN} and ${PASSWORD_MAX}`);
  }
  const all = PASSWORD_CLASSES.join("");
  const chars = PASSWORD_CLASSES.map((set) => set[randomInt(set.length)]!);
  while (chars.length < length) chars.push(all[randomInt(all.length)]!);
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j]!, chars[i]!];
  }
  return chars.join("");
}

export interface GenerateCredentialInput {
  name: string;
  /** With a username it is a userpass credential; without, a token (the password alone). */
  username?: string;
  length?: number;
}

/**
 * GENERATE-AND-STORE for an agent: vibehub makes the password and writes it to the vault in the
 * same call — it never leaves this function except into the vault. The caller gets the metadata
 * back; to use the password (set it on the target system, sign in) it fills it with the CDP fill
 * path by NAME.
 */
export async function generateCredential(cardId: string, input: GenerateCredentialInput, by?: string): Promise<Credential> {
  const origin = await authorizeAgentWrite(cardId, "generated");
  const name = assertCredentialName(input.name);
  const password = generatePassword(input.length ?? PASSWORD_DEFAULT);
  const username = String(input.username ?? "").trim();
  return username
    ? await createCredential({ name, type: "userpass", username, password }, by, origin)
    : await createCredential({ name, type: "token", value: password }, by, origin);
}
