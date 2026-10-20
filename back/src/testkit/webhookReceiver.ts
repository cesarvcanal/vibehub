import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type IncomingHttpHeaders, type Server } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * TEST ONLY — a real HTTPS webhook receiver on 127.0.0.1, with a throwaway self-signed certificate
 * for the names a test uses (`localhost`, `receiver.test`). What it answers is up to the test
 * (`respond`); everything it received stays in `received`, raw body included (a signature is checked
 * over the exact bytes, never over a re-serialized object).
 */

export interface Received {
  headers: IncomingHttpHeaders;
  body: string;
  /** The TLS server name the client asked for (SNI): proves the hostname survived an IP-pinned connect. */
  servername: string | undefined;
}

export type Respond = (got: Received) => { status: number; body?: string; headers?: Record<string, string> } | Promise<{ status: number; body?: string; headers?: Record<string, string> }>;

export interface TestReceiver {
  port: number;
  /** The certificate, for the client to trust (`WEBHOOK_NET.ca`). */
  cert: string;
  received: Received[];
  respond: Respond;
  url: (host?: string, path?: string) => string;
  close: () => Promise<void>;
}

let cached: { key: string; cert: string } | null = null;

/** One self-signed certificate per test process: openssl takes a moment. */
function certificate(): { key: string; cert: string } {
  if (cached) return cached;
  const dir = mkdtempSync(join(tmpdir(), "vibehub-webhook-cert-"));
  try {
    execFileSync("openssl", [
      "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "2", "-subj", "/CN=receiver.test",
      "-addext", "subjectAltName=DNS:receiver.test,DNS:localhost,IP:127.0.0.1",
      "-keyout", join(dir, "key.pem"), "-out", join(dir, "cert.pem"),
    ], { stdio: "ignore" });
    cached = { key: readFileSync(join(dir, "key.pem"), "utf8"), cert: readFileSync(join(dir, "cert.pem"), "utf8") };
    return cached;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The default answer: echoes a verification challenge, acks everything else. */
export const echoChallenge: Respond = (got) => {
  try {
    const body = JSON.parse(got.body) as { type?: string; challenge?: string };
    if (body.type === "verification") return { status: 200, body: JSON.stringify({ challenge: body.challenge }) };
  } catch { /* not JSON: still an ack */ }
  return { status: 200, body: "{}" };
};

export async function startTestReceiver(respond: Respond = echoChallenge): Promise<TestReceiver> {
  const { key, cert } = certificate();
  const receiver = { received: [] as Received[], respond } as TestReceiver;
  const server: Server = createServer({ key, cert }, (req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const got: Received = {
        headers: req.headers, body: Buffer.concat(chunks).toString("utf8"),
        servername: (req.socket as unknown as { servername?: string }).servername,
      };
      receiver.received.push(got);
      void Promise.resolve(receiver.respond(got)).then((out) => {
        res.writeHead(out.status, { "content-type": "application/json", ...out.headers });
        res.end(out.body ?? "");
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  receiver.port = typeof address === "object" && address ? address.port : 0;
  receiver.cert = cert;
  receiver.url = (host = "receiver.test", path = "/hooks/vibehub") => `https://${host}:${receiver.port}${path}`;
  receiver.close = () => new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });
  return receiver;
}
