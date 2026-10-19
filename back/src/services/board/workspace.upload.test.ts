import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildUploadScript } from "./workspace.js";

/**
 * O script de upload RODANDO de verdade num bash, com um `docker` falso que só executa o comando
 * do container aqui mesmo. É o que prova o conserto da lentidão: o payload não é mais lido pelo
 * bash (1 byte por read()), e os bytes chegam inteiros.
 */
describe("buildUploadScript — executado num bash de verdade", () => {
  let dir = "";
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  function run(bytes: Buffer): { out: Buffer; ms: number } {
    dir = mkdtempSync(join(tmpdir(), "vh-upload-"));
    const bin = join(dir, "bin");
    execFileSync("mkdir", ["-p", bin]);
    // docker exec -i <container> sh -c <cmd>  →  sh -c <cmd>
    writeFileSync(join(bin, "docker"), "#!/bin/sh\nshift 3\nexec \"$@\"\n");
    chmodSync(join(bin, "docker"), 0o755);
    const dest = join(dir, "up", "shot.png");
    const script = buildUploadScript({ containerName: "runner", destDir: join(dir, "up"), destPath: dest, base64: bytes.toString("base64") });
    const t0 = Date.now();
    execFileSync("bash", ["-s"], { input: script, env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
    return { out: readFileSync(dest), ms: Date.now() - t0 };
  }

  it("os bytes chegam idênticos, inclusive os que parecem shell", () => {
    const tricky = Buffer.from("VIBEHUB_B64\n$(reboot)\n`id`\n'\"\n\0\xff");
    expect(run(tricky).out.equals(tricky)).toBe(true);
  });

  it("uma imagem de 5 MB sobe em menos de 5 s (antes: ~19 s por nível de bash)", () => {
    const big = Buffer.alloc(5 * 1024 * 1024);
    for (let i = 0; i < big.length; i += 1) big[i] = (i * 2654435761) >>> 24;
    const { out, ms } = run(big);
    expect(out.equals(big)).toBe(true);
    expect(ms).toBeLessThan(5_000);
  });
});
