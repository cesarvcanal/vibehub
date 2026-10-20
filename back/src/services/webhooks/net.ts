import { lookup } from "node:dns/promises";
import { request } from "node:https";
import { BlockList, isIP, isIPv4 } from "node:net";

/**
 * THE OUTBOUND POST of MCP Events webhooks — the one place vibehub sends a request to a URL that a
 * CLIENT chose (`events/subscribe` → `delivery.url`). Unguarded, that is an SSRF primitive: the
 * server could be pointed at its runner, the VPN, a cloud metadata endpoint. So, per the spec
 * (developers.openai.com/plugins/build/mcp-events and the MCP Events design sketch, "SSRF prevention"):
 *
 *  - https only, and no credentials in the URL;
 *  - the hostname is resolved AT CONNECT TIME, every answer must be a globally routable address
 *    (IANA special-purpose registries), and the socket connects to that validated address while TLS
 *    still verifies — and SNI still names — the original hostname: nothing can change in between
 *    (DNS rebinding);
 *  - redirects are never followed (the 3xx is the answer), the whole exchange has a deadline, and at
 *    most `maxResponseBytes` of the reply is read.
 *
 * The same path serves the verification challenge and every delivery.
 */

export const WEBHOOK_NET = {
  /** Lets a private/loopback destination through — tests and an explicitly configured install only. */
  allowPrivate: process.env.VIBEHUB_WEBHOOK_ALLOW_PRIVATE === "1",
  /** Every address a hostname resolves to. Swappable so a test can play the DNS. */
  resolve: async (host: string): Promise<string[]> => (await lookup(host, { all: true, verbatim: true })).map((a) => a.address),
  /** Extra CA to trust (tests' self-signed receiver). Undefined = the system's. */
  ca: undefined as string | undefined,
  /** Deadline of one POST, connect to last byte. The draft cites ~5s as common; OpenAI's sample uses 10s. */
  timeoutMs: 10_000,
  /** How much of a reply is read: a challenge echo is tiny; nothing else in it matters. */
  maxResponseBytes: 64 * 1024,
};

/** Why a POST did not get an answer — the draft's `lastError` categories, plus a refused address. */
export type CallbackReason = "connection_refused" | "timeout" | "tls_error" | "blocked_address";

export class CallbackError extends Error {
  constructor(readonly reason: CallbackReason, message: string = reason) {
    super(message);
  }
}

/** A callback URL that can never be valid, whatever the network says. */
export class CallbackUrlError extends Error {}

/* ------------------------------------------------------------------ addresses */

const blocked = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.31.196.0", 24], ["192.52.193.0", 24], ["192.88.99.0", 24],
  ["192.168.0.0", 16], ["192.175.48.0", 24], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24],
  ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) blocked.addSubnet(net, prefix, "ipv4");
// IPv6: only global unicast (2000::/3) is ever public; inside it, these special-purpose blocks are not
// (NAT64 and 6to4 are refused outright: they can embed a private IPv4).
const globalUnicast = new BlockList();
globalUnicast.addSubnet("2000::", 3, "ipv6");
for (const [net, prefix] of [
  ["2001::", 23], ["2001:db8::", 32], ["2002::", 16], ["3fff::", 20],
] as const) blocked.addSubnet(net, prefix, "ipv6");

/** The 8 groups of an IPv6 address (already known valid). */
function ipv6Groups(ip: string): number[] {
  let text = ip.toLowerCase().split("%")[0]!;
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (v4) {
    const [a, b, c, d] = v4[1]!.split(".").map(Number) as [number, number, number, number];
    text = text.slice(0, -v4[1]!.length) + `${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, tail] = text.split("::") as [string, string | undefined];
  const left = head ? head.split(":") : [];
  const right = tail !== undefined && tail ? tail.split(":") : [];
  const middle = tail !== undefined ? Array(8 - left.length - right.length).fill("0") : [];
  return [...left, ...middle, ...right].map((g) => parseInt(g, 16));
}

/** Whether `ip` is globally routable per the IANA IPv4/IPv6 special-purpose registries. */
export function isPublicAddress(ip: string): boolean {
  const literal = ip.replace(/^\[|\]$/g, "");
  if (isIPv4(literal)) return !blocked.check(literal, "ipv4");
  if (isIP(literal) !== 6) return false;
  const g = ipv6Groups(literal);
  // IPv4-mapped (::ffff:a.b.c.d): judged as the IPv4 it carries.
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) {
    return isPublicAddress(`${g[6]! >> 8}.${g[6]! & 0xff}.${g[7]! >> 8}.${g[7]! & 0xff}`);
  }
  return globalUnicast.check(literal, "ipv6") && !blocked.check(literal, "ipv6");
}

/**
 * The static checks of a callback URL — what a subscribe refuses with InvalidParams. Whatever a
 * hostname resolves to is checked again on EVERY connect (`postWebhook`); this is only the part
 * that never depends on DNS.
 */
export function assertCallbackUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new CallbackUrlError("delivery.url is not a valid URL");
  }
  if (url.protocol !== "https:") throw new CallbackUrlError("delivery.url must use https");
  if (url.username || url.password) throw new CallbackUrlError("delivery.url must not carry credentials");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const local = isIP(host) ? !isPublicAddress(host) : host === "localhost" || host.endsWith(".localhost") || !host.includes(".");
  if (local && !WEBHOOK_NET.allowPrivate) throw new CallbackUrlError("delivery.url must point at a public address");
  return url;
}

/* ------------------------------------------------------------------ the POST */

function reasonOf(err: NodeJS.ErrnoException): CallbackReason {
  const code = String(err.code ?? "");
  return /CERT|TLS|SSL|SELF_SIGNED|HOSTNAME|ALTNAME/.test(code) ? "tls_error" : "connection_refused";
}

/** The addresses to connect to: resolved now, every answer public (or the POST does not happen). */
async function pinnedAddresses(host: string): Promise<string[]> {
  let addresses: string[];
  try {
    addresses = isIP(host) ? [host] : await WEBHOOK_NET.resolve(host);
  } catch {
    throw new CallbackError("connection_refused", "the callback host does not resolve");
  }
  if (addresses.length === 0) throw new CallbackError("connection_refused", "the callback host does not resolve");
  if (!WEBHOOK_NET.allowPrivate && addresses.some((a) => !isPublicAddress(a))) {
    throw new CallbackError("blocked_address", "the callback host resolves to a non-public address");
  }
  return addresses;
}

/** Connect-level failures: nothing was sent, so the next validated address may be tried. */
const UNREACHED = new Set(["ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH", "EADDRNOTAVAIL"]);

class Unreached extends CallbackError {}

/**
 * POSTs `body` (sent byte for byte as given) to `url` over the hardened path above. Resolves with
 * the status and the first bytes of the reply, whatever the status; rejects with a CallbackError
 * when no answer came back.
 */
export async function postWebhook(url: string, headers: Record<string, string>, body: string): Promise<{ status: number; body: string }> {
  const target = assertCallbackUrl(url);
  const host = target.hostname.replace(/^\[|\]$/g, "");
  const addresses = await pinnedAddresses(host);
  const deadline = Date.now() + WEBHOOK_NET.timeoutMs;
  for (let i = 0; ; i++) {
    try {
      return await postTo(target, host, addresses[i]!, headers, Buffer.from(body, "utf8"), deadline - Date.now());
    } catch (err) {
      // A dual-stack host whose first address is unreachable from here: the next one was validated too.
      if (!(err instanceof Unreached) || i + 1 >= addresses.length || Date.now() >= deadline) throw err;
    }
  }
}

/** One POST to one already-validated address, within `budgetMs`. */
function postTo(target: URL, host: string, address: string, headers: Record<string, string>, payload: Buffer, budgetMs: number): Promise<{ status: number; body: string }> {
  const family = isIP(address);
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      fn();
    };
    const req = request({
      protocol: "https:", hostname: host, port: target.port || 443, path: `${target.pathname}${target.search}`, method: "POST",
      headers: { ...headers, "content-length": String(payload.length) },
      // The socket goes to the address validated above, never to a second lookup; TLS (and SNI)
      // still use `hostname`, so the certificate must be the real host's.
      lookup: ((_h: string, opts: { all?: boolean }, cb: (...args: unknown[]) => void) =>
        (opts?.all ? cb(null, [{ address, family }]) : cb(null, address, family))) as never,
      servername: isIP(host) ? undefined : host,
      ca: WEBHOOK_NET.ca,
      agent: false,
    }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on("data", (chunk: Buffer) => {
        if (size >= WEBHOOK_NET.maxResponseBytes) return;
        chunks.push(chunk.subarray(0, WEBHOOK_NET.maxResponseBytes - size));
        size += chunk.length;
        if (size >= WEBHOOK_NET.maxResponseBytes) {
          done(() => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
          res.destroy();
        }
      });
      res.on("end", () => done(() => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") })));
      res.on("error", (err) => done(() => reject(new CallbackError(reasonOf(err), "the callback reply broke off"))));
    });
    const deadline = setTimeout(() => {
      done(() => reject(new CallbackError("timeout", "the callback did not answer in time")));
      req.destroy();
    }, Math.max(budgetMs, 0));
    req.on("error", (err: NodeJS.ErrnoException) => done(() => reject(UNREACHED.has(String(err.code))
      ? new Unreached("connection_refused", "could not reach the callback")
      : new CallbackError(reasonOf(err), "could not reach the callback"))));
    req.end(payload);
  });
}
