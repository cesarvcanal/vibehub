import { resolve } from "node:path";
import "dotenv/config";

/**
 * Central configuration. Everything vibehub needs to run is an env var with a sane default, so a
 * bare `docker compose up` works and every knob is still overridable.
 */

function str(name: string, fallback: string): string {
  const v = process.env[name];
  return v === undefined || v === "" ? fallback : v;
}

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

/** Where the runner containers live: this machine's Docker, or a remote host over SSH. */
export type RunnerHostKind = "local" | "ssh";

export interface VibehubConfig {
  port: number;
  host: string;
  /** Directory for state: board.json, users.json, secrets.enc, master.key. */
  dataDir: string;
  /**
   * URL the runner uses to call back into vibehub (status hooks). Inside docker-compose the runner
   * reaches the app by service name; on a VPS it is the LAN/VPN address. Never a public URL you do
   * not control — it carries the runner service token.
   */
  publicUrl: string;
  runner: {
    kind: RunnerHostKind;
    /** ssh only: host to reach, user, and private key path. */
    sshHost: string;
    sshUser: string;
    sshKeyPath: string;
    /** Container name and image for the runner. */
    container: string;
    image: string;
    /** Host directory holding the runner's persistent volumes (/root and /work bind mounts). */
    baseDir: string;
    /**
     * Docker network to attach the runner to. Under docker-compose this is the compose network, so
     * the runner can reach vibehub by service name (`http://vibehub:3010`) for status hooks and
     * the built-in MCP. Empty = the daemon's default bridge (then publicUrl must be a host address).
     */
    network: string;
  };
  /** Master key for the local vault. Empty = generated once into <dataDir>/master.key (mode 600). */
  secretKey: string;
  /** Cookie/session signing secret. Empty = generated once into <dataDir>/session.key. */
  sessionSecret: string;
  /** Allow http cookies (dev / plain-http LAN deployments). */
  insecureCookies: boolean;
  logLevel: string;
}

export const config: VibehubConfig = {
  port: int("VIBEHUB_PORT", 3010),
  host: str("VIBEHUB_HOST", "0.0.0.0"),
  dataDir: resolve(str("VIBEHUB_DATA_DIR", "data")),
  publicUrl: str("VIBEHUB_PUBLIC_URL", `http://127.0.0.1:${int("VIBEHUB_PORT", 3010)}`),
  runner: {
    kind: (str("VIBEHUB_RUNNER_KIND", "local") === "ssh" ? "ssh" : "local") as RunnerHostKind,
    sshHost: str("VIBEHUB_RUNNER_SSH_HOST", ""),
    sshUser: str("VIBEHUB_RUNNER_SSH_USER", "root"),
    sshKeyPath: str("VIBEHUB_RUNNER_SSH_KEY", ""),
    container: str("VIBEHUB_RUNNER_CONTAINER", "vibehub-runner"),
    image: str("VIBEHUB_RUNNER_IMAGE", "node:24-bookworm"),
    baseDir: str("VIBEHUB_RUNNER_BASE_DIR", "/opt/vibehub/runner"),
    network: str("VIBEHUB_RUNNER_NETWORK", ""),
  },
  secretKey: str("VIBEHUB_SECRET_KEY", ""),
  sessionSecret: str("VIBEHUB_SESSION_SECRET", ""),
  insecureCookies: str("VIBEHUB_INSECURE_COOKIES", "") === "1",
  logLevel: str("VIBEHUB_LOG_LEVEL", "info"),
};

/** Absolute path inside the data directory. */
export function dataPath(...parts: string[]): string {
  return resolve(config.dataDir, ...parts);
}
