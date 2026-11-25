import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { pathWithFakeDocker } from "../../testkit/fakeDocker.js";
import { buildUploadCommand } from "./workspace.js";

async function runUpload(input: Buffer, declaredBytes: number) {
  const dir = mkdtempSync(join(tmpdir(), "vh-upload-"));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  const destDir = join(dir, "up");
  const destPath = join(destDir, "1-pacote.zip");
  const line = buildUploadCommand({ containerName: "runner", destDir, destPath, bytes: declaredBytes });
  const run = spawnSync("bash", ["-c", line], { input, env: { ...process.env, PATH: await pathWithFakeDocker() } });
  return { status: run.status, destDir, destPath };
}

describe("buildUploadCommand — executado num bash de verdade", () => {
  it("os bytes chegam idênticos, inclusive os que parecem shell", async () => {
    const tricky = Buffer.from("VIBEHUB_B64\n$(reboot)\n`id`\n'\"\n\0\xff");
    const { status, destPath } = await runUpload(tricky, tricky.length);
    expect(status).toBe(0);
    expect(readFileSync(destPath).equals(tricky)).toBe(true);
  });

  it("um envio que para antes do tamanho declarado não deixa arquivo nenhum, nem o pedaço", async () => {
    const { status, destDir, destPath } = await runUpload(Buffer.from("metade"), 1_000);
    expect(status).not.toBe(0);
    expect(existsSync(destPath)).toBe(false);
    expect(readdirSync(destDir)).toEqual([]);
  });

  it("50 MB sobem em menos de 5 s, sem base64 no caminho", async () => {
    const big = Buffer.alloc(50 * 1024 * 1024, 7);
    const started = Date.now();
    const { status, destPath } = await runUpload(big, big.length);
    expect(status).toBe(0);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(execFileSync("stat", ["-c", "%s", destPath]).toString().trim()).toBe(String(big.length));
  });
});
