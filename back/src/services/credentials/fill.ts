import { randomUUID } from "node:crypto";
import { config } from "../../config/env.js";
import { hostExecutor } from "../../runtime/host.js";
import { getCard } from "../board/registry.js";
import { cardBrowserPorts } from "../browser/ports.js";
import { agentMayDriveBrowser } from "../browser/activity.js";
import { logger } from "../../utils/logger.js";
import { resolveCredential, markCredentialUsed, type CredentialType } from "./credentials.js";
import { CDP_RUNNER_SOURCE } from "./cdpRunner.js";

/**
 * CDP FILL — types a named credential's value into the card's live Chromium.
 *
 * The value is read from the vault HERE, base64-embedded into a payload file that travels to the
 * runner over STDIN (never argv, never a log), and typed by the in-runner CDP program via
 * `Input.insertText`. The value NEVER appears in the tool's response, the model's context or a log
 * line — the response is only `{ filled, fields }`, where `fields` are the FIELD LABELS filled.
 */

export interface FillOptions {
  userSelector?: string;
  passSelector?: string;
  /** Navigate the card's browser here before filling (optional). */
  url?: string;
}

export interface FillField {
  /** Which vault value goes here. */
  ref: "USER" | "PASS" | "VALUE";
  /** CSS selector the user gave; absent = the in-page heuristic resolves the field. */
  selector?: string;
}

export interface FillPlan {
  fields: FillField[];
}

/**
 * The ordered fields to fill for a credential, WITHOUT any value — pure, and the unit under test:
 * a plan proves what will be typed and where, and that nothing secret rides along in it. A userpass
 * fills USER then PASS; a token fills a single VALUE (into the password field, or the given
 * selector). PURE.
 */
export function buildFillPlan(type: CredentialType, opts: FillOptions = {}): FillPlan {
  const userSelector = opts.userSelector?.trim() || undefined;
  const passSelector = opts.passSelector?.trim() || undefined;
  if (type === "userpass") {
    return {
      fields: [
        { ref: "USER", ...(userSelector ? { selector: userSelector } : {}) },
        { ref: "PASS", ...(passSelector ? { selector: passSelector } : {}) },
      ],
    };
  }
  const selector = passSelector || userSelector;
  return { fields: [{ ref: "VALUE", ...(selector ? { selector } : {}) }] };
}

/** Heredoc delimiters — reserved words, never derived from input. */
const SCRIPT_DELIM = "VIBEHUB_CDP_SCRIPT";
const PAYLOAD_DELIM = "VIBEHUB_CDP_PAYLOAD";

/**
 * Host script that writes the CDP program and its base64 payload into the runner (mode 600), runs
 * node against them and shreds both. The payload is base64 — its alphabet carries no shell or
 * heredoc metacharacters, so a value with any byte in it stays contained. `tag` is a random hex
 * name so concurrent fills never collide. PURE (only builds a string).
 */
export function buildCdpHostScript(containerName: string, tag: string, payloadB64: string, opts: { background?: boolean } = {}): string {
  if (!/^[0-9a-f]{8,40}$/.test(tag)) throw new Error("invalid cdp tag");
  if (!/^[A-Za-z0-9+/=]+$/.test(payloadB64)) throw new Error("invalid cdp payload encoding");
  const mjs = `/tmp/vh-cdp-${tag}.mjs`;
  const json = `/tmp/vh-cdp-${tag}.json`;
  const runNode = opts.background
    ? `node ${mjs} ${json}`
    : `node ${mjs} ${json}; rm -f ${mjs} ${json}`;
  const inner = [
    "umask 077",
    `cat > ${mjs} <<'${SCRIPT_DELIM}'`,
    CDP_RUNNER_SOURCE,
    SCRIPT_DELIM,
    `cat > ${json} <<'${PAYLOAD_DELIM}'`,
    payloadB64,
    PAYLOAD_DELIM,
    runNode,
  ].join("\n");
  // shQuote is unnecessary: containerName is validated config, everything else is a fixed literal or
  // the [0-9a-f] tag. Kept simple and single-quoted via the docker exec wrapper below.
  return [`docker exec -i ${JSON.stringify(containerName)} bash -s <<'VIBEHUB_CDP_OUTER'`, inner, "VIBEHUB_CDP_OUTER"].join("\n");
}

export interface FillResult {
  filled: boolean;
  /** Field labels filled ("USER", "PASS", "VALUE") — never values. */
  fields: string[];
}

/** Parses the one JSON line the CDP program prints. Throws on an error line. PURE. */
export function parseFillResult(stdout: string): FillResult {
  const line = stdout.split("\n").map((l) => l.trim()).filter(Boolean).pop() ?? "";
  let parsed: { filled?: boolean; fields?: string[]; error?: string };
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new Error("the browser did not answer the fill (is a page open in the card?)");
  }
  if (parsed.error) throw new Error(parsed.error);
  return { filled: Boolean(parsed.filled), fields: Array.isArray(parsed.fields) ? parsed.fields : [] };
}

/**
 * Fills `credentialName` into card `cardId`'s browser. Resolves the value from the vault, runs the
 * CDP program in the runner, and returns only the field labels. Audited (who / which credential /
 * which card / when) with NO value.
 */
export async function fillCredential(
  cardId: string,
  credentialName: string,
  opts: FillOptions & { by?: string } = {},
): Promise<FillResult> {
  const card = await getCard(cardId);
  if (!card) throw new Error("card not found");
  // A person has the wheel: typing into the page underneath them is exactly the two-pointers mess
  // that made co-piloting unusable. Say so plainly — the agent's move is to wait, not to retry.
  if (!agentMayDriveBrowser(cardId)) {
    throw new Error("someone has taken control of this card's browser — ask them to hand it back before driving it");
  }
  const resolved = await resolveCredential(credentialName);
  const { cdpPort } = cardBrowserPorts(cardId);
  const plan = buildFillPlan(resolved.credential.type, opts);

  const secrets: Record<string, string> = {};
  if (resolved.credential.type === "userpass") {
    secrets.USER = resolved.username ?? "";
    secrets.PASS = resolved.secret;
  } else {
    secrets.VALUE = resolved.secret;
  }

  const url = opts.url?.trim() && /^https?:\/\//i.test(opts.url.trim()) ? opts.url.trim() : undefined;
  const payload = { mode: "fill", cdpPort, plan, secrets, ...(url ? { url } : {}) };
  const payloadB64 = Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
  const tag = randomUUID().replace(/-/g, "");
  const script = buildCdpHostScript(config.runner.container, tag, payloadB64);

  // The script (which contains the base64 value) travels over STDIN. It is NEVER logged.
  const { stdout } = await hostExecutor().runScript(script, { timeoutMs: 30_000 });
  const result = parseFillResult(stdout);

  if (result.filled) await markCredentialUsed(resolved.credential.id);
  logger.info(
    { audit: true, action: "credential.fill", credential: resolved.credential.name, card: cardId, fields: result.fields, by: opts.by },
    "credential filled into a card browser",
  );
  return result;
}
