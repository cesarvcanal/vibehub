import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "../config/env.js";
import {
  hostExecutor, resetHostExecutorForTesting, shQuote, assertSafeRemotePath, writeFileScript,
  isAccessError, sshArgs, HostExecError,
} from "./host.js";

let dir = "";
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "vibehub-host-"));
  config.runner.kind = "local";
  resetHostExecutorForTesting();
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe("shQuote", () => {
  it("wraps a plain value", () => expect(shQuote("abc")).toBe("'abc'"));
  it("neutralizes embedded quotes and shell metacharacters", () => {
    expect(shQuote("a'b; rm -rf /")).toBe(`'a'\\''b; rm -rf /'`);
  });
});

describe("assertSafeRemotePath", () => {
  it("accepts an absolute clean path", () => expect(() => assertSafeRemotePath("/opt/vibehub/x.json")).not.toThrow());
  it("rejects relative paths", () => expect(() => assertSafeRemotePath("opt/x")).toThrow(/absolute/));
  it("rejects traversal", () => expect(() => assertSafeRemotePath("/opt/../etc/passwd")).toThrow(/\.\./));
  it("rejects shell metacharacters", () => expect(() => assertSafeRemotePath("/opt/$(id)")).toThrow(/invalid characters/));
});

describe("writeFileScript", () => {
  it("is atomic: writes tmp, chmods, renames", () => {
    const script = writeFileScript("/opt/vibehub/token", "600");
    expect(script).toContain("/opt/vibehub/token.tmp");
    expect(script).toContain("chmod 600");
    expect(script).toContain("mv -f");
  });
  it("rejects a bogus mode", () => expect(() => writeFileScript("/opt/x", "rwx")).toThrow(/invalid file mode/));
});

describe("isAccessError", () => {
  it("flags credential problems", () => expect(isAccessError("Permission denied (publickey)")).toBe(true));
  it("does not flag an app-level failure", () => expect(isAccessError("docker: no such container")).toBe(false));
});

describe("sshArgs", () => {
  it("puts the host last and disables prompts", () => {
    config.runner.sshHost = "10.0.0.5";
    config.runner.sshUser = "root";
    config.runner.sshKeyPath = "/keys/id";
    const args = sshArgs();
    expect(args[args.length - 1]).toBe("root@10.0.0.5");
    expect(args).toContain("BatchMode=yes");
    expect(args.slice(0, 2)).toEqual(["-i", "/keys/id"]);
  });
  it("explains itself when the host is missing", () => {
    config.runner.sshHost = "";
    expect(() => sshArgs()).toThrow(/VIBEHUB_RUNNER_SSH_HOST/);
  });
});

describe("local executor", () => {
  it("runs a script and returns stdout", async () => {
    const { stdout } = await hostExecutor().runScript("echo hello-vibehub");
    expect(stdout.trim()).toBe("hello-vibehub");
  });

  it("streams chunks while running", async () => {
    const chunks: string[] = [];
    await hostExecutor().runScript("echo one; echo two", { onChunk: (c) => chunks.push(c) });
    expect(chunks.join("")).toContain("one");
  });

  it("rejects with the stderr detail and exit code on failure", async () => {
    await expect(hostExecutor().runScript("echo boom >&2; exit 3")).rejects.toMatchObject({
      message: expect.stringContaining("boom"),
      exitCode: 3,
    });
  });

  it("times out instead of hanging forever", async () => {
    await expect(hostExecutor().runScript("sleep 5", { timeoutMs: 100 })).rejects.toBeInstanceOf(HostExecError);
  });

  it("never puts the payload in argv — the script arrives over stdin", async () => {
    const { stdout } = await hostExecutor().runScript("cat <<'EOS'\nfrom-stdin\nEOS");
    expect(stdout).toContain("from-stdin");
  });

  it("writes files atomically with the requested mode", async () => {
    const file = join(dir, "secret.token");
    await hostExecutor().writeFile(file, "s3cret", { mode: "600" });
    expect(await readFile(file, "utf8")).toBe("s3cret");
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  it("refuses an unsafe write path", async () => {
    await expect(hostExecutor().writeFile("relative/path", "x")).rejects.toThrow(/absolute/);
  });

  it("builds a pty command for the local shell", () => {
    expect(hostExecutor().ptyCommand("docker exec -it c sh")).toEqual({ file: "bash", args: ["-lc", "docker exec -it c sh"] });
  });
});

describe("ssh executor", () => {
  it("forces a tty and appends the command after the host", () => {
    config.runner.kind = "ssh";
    config.runner.sshHost = "10.0.0.5";
    resetHostExecutorForTesting();
    const { file, args } = hostExecutor().ptyCommand("docker exec -it c sh");
    expect(file).toBe("ssh");
    expect(args).toContain("-tt");
    expect(args[args.length - 1]).toBe("docker exec -it c sh");
    expect(args[args.length - 2]).toBe("root@10.0.0.5");
  });
});
