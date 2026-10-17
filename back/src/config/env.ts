import { isIP } from "node:net";
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

/** A docker container name — and nothing a shell could read as more than one word or a flag. */
const DOCKER_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

/**
 * A docker name from the environment, VALIDATED: it is interpolated into shell scripts all over the
 * runner code (`docker exec`, `docker ps -f name=^…$`), and a bad value must stop vibehub at boot
 * naming the variable rather than reach a shell.
 */
function dockerName(name: string, fallback: string): string {
  const v = str(name, fallback);
  if (!DOCKER_NAME_RE.test(v)) throw new Error(`${name} is not a valid docker container name: '${v}'`);
  return v;
}

/**
 * VIBEHUB_TRUST_PROXY -> Fastify's `trustProxy`: which peer may tell us, in X-Forwarded-For, who the
 * client really is. Empty = nobody, AND nothing declared: vibehub cannot tell a direct client from a
 * gateway it was not told about, so the per-address sign-in ceiling stays off (routes/auth.ts). A
 * whole number = that many proxy hops — `0` being "no gateway: the socket's peer IS the client", the
 * way a direct install turns that ceiling on. Anything else is passed as Fastify takes it:
 * comma-separated addresses/CIDRs, or proxy-addr's names (`loopback`, `uniquelocal`). Never "trust
 * everyone": a client reaching vibehub directly could then forge the header and buy itself fresh
 * sign-in counters.
 *
 * VALIDATED here, like the docker names: proxy-addr reads any word it does not know as an IP and
 * throws from inside Fastify's constructor, so a natural `true` would keep the back from booting
 * with a message that never names the variable. `false`/`no`/`off` mean what they say (= unset).
 */
function trustProxy(name: string): string | number | false {
  const v = str(name, "").trim();
  if (!v || /^(false|no|off)$/i.test(v)) return false;
  if (/^\d+$/.test(v)) return Number.parseInt(v, 10);
  const bad = v.split(",").map((entry) => entry.trim()).find((entry) => !isTrustEntry(entry));
  if (bad !== undefined) {
    throw new Error(
      `${name} must be a hop count, or comma-separated addresses/CIDRs/loopback/linklocal/uniquelocal — not '${bad}' (trusting every peer is not an option)`,
    );
  }
  return v;
}

/** The names proxy-addr predefines, besides literal addresses. */
const PROXY_ADDR_NAMES = new Set(["loopback", "linklocal", "uniquelocal"]);

/** One entry proxy-addr compiles: a name, an address, or address/prefix-length or /dotted-netmask. */
function isTrustEntry(entry: string): boolean {
  if (PROXY_ADDR_NAMES.has(entry)) return true;
  const [address, range, ...rest] = entry.split("/");
  const family = isIP(address ?? "");
  if (family === 0 || rest.length > 0) return false;
  if (range === undefined) return true;
  if (/^\d+$/.test(range)) return Number(range) <= (family === 4 ? 32 : 128);
  return family === 4 && isIP(range) === 4;
}

/**
 * {@link VibehubConfig.trustProxy} in the shape Fastify's TYPES accept. Fastify itself takes a hop
 * count at runtime, but its declarations stop at string/boolean/function — so a count becomes the
 * very predicate Fastify would build from it ("trust the first N hops"). `0` thereby trusts nobody:
 * `req.ip` stays the socket's peer, exactly as with `false`.
 */
export function fastifyTrustProxy(value: string | number | false): string | false | ((address: string, hop: number) => boolean) {
  return typeof value === "number" ? (_address, hop) => hop < value : value;
}

/**
 * What the operator must hear at boot when a gateway is trusted, null when none is. Trusting one is
 * only safe while it is the ONLY way in: whoever reaches vibehub's port directly from an address the
 * setting trusts — ANY peer for a hop count, and docker-proxy hands every direct connection over
 * from the bridge's 172.x (inside `uniquelocal`, and the very address a gateway on the host comes
 * from) — forges X-Forwarded-For and gets fresh sign-in counters on every try: an unlimited guess
 * at the owner's password. vibehub cannot see how its port is published, so it says what to check.
 */
export function trustProxyBootWarning(value: string | number | false): string | null {
  if (value === false || value === 0) return null;
  return (
    `VIBEHUB_TRUST_PROXY=${value}: X-Forwarded-For is believed, so the sign-in throttle is only as good as ` +
    "the gateway being the ONLY way to reach this port — publish it to the gateway alone (docker-compose: " +
    '"127.0.0.1:3010:3010" with the gateway on this host), never on every interface'
  );
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
  /**
   * The gateway in front of vibehub, if any (see `trustProxy`). It decides what `req.ip` is — and
   * `req.ip` is the key of the sign-in ceilings: behind an UNtrusted gateway every request shares
   * the gateway's address, and ten wrong passwords from anyone lock the real owner out. `false` =
   * unset (who the client is was never declared), which also switches the per-address ceiling off.
   */
  trustProxy: string | number | false;
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
    container: dockerName("VIBEHUB_RUNNER_CONTAINER", "vibehub-runner"),
    image: str("VIBEHUB_RUNNER_IMAGE", "node:24-bookworm"),
    baseDir: str("VIBEHUB_RUNNER_BASE_DIR", "/opt/vibehub/runner"),
    network: str("VIBEHUB_RUNNER_NETWORK", ""),
  },
  secretKey: str("VIBEHUB_SECRET_KEY", ""),
  sessionSecret: str("VIBEHUB_SESSION_SECRET", ""),
  insecureCookies: str("VIBEHUB_INSECURE_COOKIES", "") === "1",
  trustProxy: trustProxy("VIBEHUB_TRUST_PROXY"),
  logLevel: str("VIBEHUB_LOG_LEVEL", "info"),
};

/** Absolute path inside the data directory. */
export function dataPath(...parts: string[]): string {
  return resolve(config.dataDir, ...parts);
}
