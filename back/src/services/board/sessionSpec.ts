import { createHash } from "node:crypto";
import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { config } from "../../config/env.js";
import { logger } from "../../utils/logger.js";
import { buildSdkDriverCommandLine } from "../sdk/driver.js";
import { terminalRemoteArgs, restartStaggered } from "./workspace.js";

/**
 * RESTART AFTER A DEPLOY THAT CHANGES WHAT A SESSION IS BORN WITH.
 *
 * A card's Claude session reads its environment and flags ONCE, when it starts. A deploy that changes
 * them (an env var like the test-worker cap, a CLI flag, the token guard) reaches only sessions born
 * after it — every card already open goes on with the old setup until somebody restarts it by hand
 * (2026-10-20: the worker cap merged, 19 live sessions, none of them with it, load still at 90).
 *
 * The fingerprint is the session's OWN command line, built for a fixed sample card by the same pure
 * builders the real open uses (terminal and native chat). Any change to what a session is born with
 * changes it — no version number to remember to bump. A deploy that does not touch it restarts
 * nothing. The sweep is the same staggered restart the brain/MCP save uses: idle cards now (they
 * resume the same conversation), working cards flagged and restarted the moment they go idle.
 */

const SAMPLE_CARD_ID = "00000000-0000-4000-8000-000000000000";
const SAMPLE_CWD = "/work/sample--repo-worktrees/sample-0000";

/** Hash of the commands a session starts with, for a fixed sample card. PURE. */
export function sessionSpecFingerprint(): string {
  const spec = {
    sdk: buildSdkDriverCommandLine({
      containerName: "runner",
      cwd: SAMPLE_CWD,
      profileDir: "/root/.claude",
      cdpEndpoint: "http://127.0.0.1:9222",
      cardId: SAMPLE_CARD_ID,
      statusUrl: "http://127.0.0.1/api/runner/status",
    }),
    terminal: terminalRemoteArgs("runner", "card-sample", SAMPLE_CWD, {
      cardId: SAMPLE_CARD_ID,
      statusUrl: "http://127.0.0.1/api/runner/status",
    }),
  };
  return createHash("sha256").update(JSON.stringify(spec)).digest("hex");
}

function specFile(): string {
  return join(config.dataDir, "session-spec.json");
}

async function readStoredFingerprint(): Promise<string | null> {
  try {
    const parsed = JSON.parse(await readFile(specFile(), "utf8")) as { fingerprint?: unknown };
    return typeof parsed.fingerprint === "string" ? parsed.fingerprint : null;
  } catch {
    return null;
  }
}

async function storeFingerprint(fingerprint: string): Promise<void> {
  await mkdir(config.dataDir, { recursive: true });
  const tmp = `${specFile()}.tmp`;
  await writeFile(tmp, JSON.stringify({ fingerprint, at: Date.now() }), { mode: 0o600 });
  await rename(tmp, specFile());
}

/**
 * Boot step: compares the current fingerprint with the one the last boot recorded and, when they
 * differ (or none was recorded — sessions from before this existed), restarts the board's sessions,
 * staggered. Records the new fingerprint only after the sweep, so a sweep that failed is retried on
 * the next boot. Never throws: a runner that is down must not stop the back from starting.
 */
export async function restartSessionsIfSpecChanged(): Promise<{ changed: boolean; restarted: number; pending: number }> {
  const current = sessionSpecFingerprint();
  const stored = await readStoredFingerprint();
  if (stored === current) return { changed: false, restarted: 0, pending: 0 };
  try {
    const { restarted, pending } = await restartStaggered("deploy");
    await storeFingerprint(current);
    logger.info(
      { audit: true, action: "card.restartAfterDeploy", restarted, pending, previous: stored?.slice(0, 12) ?? null, current: current.slice(0, 12) },
      "session setup changed in this deploy — idle cards restarted, working cards flagged",
    );
    return { changed: true, restarted, pending };
  } catch (err) {
    logger.warn({ detail: (err as Error).message }, "session setup changed but the restart sweep failed — retried on next boot");
    return { changed: true, restarted: 0, pending: 0 };
  }
}
