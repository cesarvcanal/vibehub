import { describe, it, expect, onTestFinished } from "vitest";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import { listPortsScript, parseListeningPorts } from "./preview.js";
import { pathWithFakeDocker } from "../../testkit/fakeDocker.js";

const runFile = promisify(execFile);
const SCAN_TEST_TIMEOUT_MS = 120_000;
const COUNTED_COMMANDS = ["cat", "find", "readlink", "ls", "awk", "sed", "grep", "head"];

async function listenOnLoopback(): Promise<number> {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  onTestFinished(() => new Promise<void>((done) => server.close(() => done())));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("server has no TCP address");
  return address.port;
}

async function listenFromProcessNamed(processName: string): Promise<{ port: number; pid: number }> {
  const listenAndPrintPort = [
    `require("node:fs").writeFileSync("/proc/self/comm", ${JSON.stringify(processName)});`,
    'const server = require("node:net").createServer();',
    'server.listen(0, "127.0.0.1", () => console.log(server.address().port));',
  ].join("\n");
  const child = spawn(process.execPath, ["-e", listenAndPrintPort], { stdio: ["ignore", "pipe", "inherit"] });
  onTestFinished(() => {
    child.kill("SIGKILL");
  });
  const firstLine = await createInterface({ input: child.stdout })[Symbol.asyncIterator]().next();
  if (child.pid === undefined || typeof firstLine.value !== "string") throw new Error("named server did not start");
  return { port: Number(firstLine.value), pid: child.pid };
}

async function pathCountingCommands(basePath: string): Promise<{ path: string; launches: () => Promise<number> }> {
  const bin = await mkdtemp(join(tmpdir(), "vibehub-scan-count-"));
  onTestFinished(() => rm(bin, { recursive: true, force: true }));
  const log = join(bin, "launches.log");
  await writeFile(log, "");
  await Promise.all(
    COUNTED_COMMANDS.map((command) =>
      writeFile(
        join(bin, command),
        `#!/bin/sh\necho ${command} >> '${log}'\nPATH='${basePath}' exec ${command} "$@"\n`,
        { mode: 0o755 },
      ),
    ),
  );
  const launches = async (): Promise<number> => {
    const lines = await readFile(log, "utf8");
    return lines.split("\n").filter(Boolean).length;
  };
  return { path: `${bin}:${basePath}`, launches };
}

async function runPortScan(path: string): Promise<string> {
  const { stdout } = await runFile("bash", ["-c", listPortsScript("vibehub-runner")], {
    env: { ...process.env, PATH: path },
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout;
}

describe("listPortsScript contra o /proc de verdade", () => {
  it("acha a porta de um servidor de verdade com o processo e o pid dele", async () => {
    const port = await listenOnLoopback();
    const ports = parseListeningPorts(await runPortScan(await pathWithFakeDocker()));
    expect(ports.find((listening) => listening.port === port)).toEqual({
      port,
      address: "loopback",
      process: expect.any(String),
      pid: process.pid,
    });
  }, SCAN_TEST_TIMEOUT_MS);

  it("não lança cat, find, readlink e afins uma vez por descritor aberto no runner", async () => {
    const extraServers = 40;
    await Promise.all(Array.from({ length: extraServers }, () => listenOnLoopback()));
    const counting = await pathCountingCommands(await pathWithFakeDocker());
    await runPortScan(counting.path);
    expect(await counting.launches()).toBeLessThan(10);
  }, SCAN_TEST_TIMEOUT_MS);

  it("nome de processo com barra invertida sai literal e não corta a linha do socket seguinte", async () => {
    const processName = "srv\\cname";
    const server = await listenFromProcessNamed(processName);
    const ports = parseListeningPorts(await runPortScan(await pathWithFakeDocker()));
    expect(ports.find((listening) => listening.port === server.port)).toEqual({
      port: server.port,
      address: "loopback",
      process: processName,
      pid: server.pid,
    });
  }, SCAN_TEST_TIMEOUT_MS);
});
