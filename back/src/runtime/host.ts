import { spawn } from "node:child_process";
import { writeFile, mkdir, chmod, rename } from "node:fs/promises";
import { dirname } from "node:path";
import { config } from "../config/env.js";

/**
 * HOST EXECUTOR — the one place that knows HOW to run a command on the machine that hosts the
 * runner container. Two shapes, same contract:
 *
 *  - "local": vibehub runs on the box that has Docker (laptop, single VPS, docker-compose with the
 *    socket mounted). Scripts run through a local `bash -s`.
 *  - "ssh":   Docker lives on another machine. Same scripts, piped through ssh.
 *
 * Everything above this file writes plain bash and never learns which one it got. That is the whole
 * reason the product runs on a laptop and on a server with the same code.
 *
 * INVARIANT: scripts and file contents travel over STDIN, never argv — argv is world-readable in
 * `ps` and these payloads carry tokens.
 */

export const EXEC_TIMEOUT_MS = 120_000;

export interface ExecResult {
  stdout: string;
  stderr: string;
}

export interface ExecOpts {
  timeoutMs?: number;
  /** Receives stdout/stderr chunks as they arrive (live deploy/provision logs). */
  onChunk?: (chunk: string) => void;
}

export class HostExecError extends Error {
  readonly accessError: boolean;
  readonly timedOut: boolean;
  readonly exitCode: number | null;
  constructor(message: string, opts: { accessError?: boolean; timedOut?: boolean; exitCode?: number | null } = {}) {
    super(message);
    this.name = "HostExecError";
    this.accessError = opts.accessError ?? false;
    this.timedOut = opts.timedOut ?? false;
    this.exitCode = opts.exitCode ?? null;
  }
}

/** Tells "I never configured access" (key/permission) apart from "the host is really down". */
export function isAccessError(detail: string): boolean {
  return /permission denied|identity file|not accessible|host key|REMOTE HOST IDENTIFICATION|could not resolve hostname|connection refused|password/i.test(
    detail,
  );
}

/** Shell-proof single quoting: the value becomes exactly ONE argument, whatever is inside it. */
export function shQuote(value: string): string {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/**
 * Absolute remote path with no funny business. Everything vibehub writes on the host is derived
 * from validated state (container name, runner base dir) — this bars path traversal on top.
 */
export function assertSafeRemotePath(remotePath: string): void {
  if (!remotePath.startsWith("/")) throw new Error(`remote path must be absolute: ${remotePath}`);
  if (remotePath.includes("..")) throw new Error(`remote path cannot contain '..': ${remotePath}`);
  if (!/^[A-Za-z0-9/_.-]+$/.test(remotePath)) throw new Error(`remote path has invalid characters: ${remotePath}`);
}

export interface HostExecutor {
  readonly kind: "local" | "ssh";
  /** Human label for logs and the UI ("this machine" / "root@10.0.0.5"). */
  readonly label: string;
  /** Runs a bash script fed through STDIN. Rejects with HostExecError on non-zero exit. */
  runScript(script: string, opts?: ExecOpts): Promise<ExecResult>;
  /** Writes a file on the host atomically, mode-controlled, contents via STDIN. */
  writeFile(remotePath: string, content: string, opts?: { mode?: string; timeoutMs?: number }): Promise<void>;
  /**
   * argv for an INTERACTIVE command (node-pty spawns this). `remoteCommand` is a single shell line
   * because ssh concatenates argv and re-parses it remotely — quoting must already be inside.
   */
  ptyCommand(remoteCommand: string): { file: string; args: string[] };
}

function runProcess(file: string, args: string[], stdin: string, opts: ExecOpts): Promise<ExecResult> {
  return new Promise<ExecResult>((resolvePromise, reject) => {
    const child = spawn(file, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(new HostExecError("host command timed out", { timedOut: true }));
    }, opts.timeoutMs ?? EXEC_TIMEOUT_MS);
    const emit = (s: string) => {
      // A bad consumer must not take the command down with it.
      try { opts.onChunk?.(s); } catch { /* ignore */ }
    };
    child.stdout.on("data", (d: Buffer) => { const s = d.toString(); stdout += s; emit(s); });
    child.stderr.on("data", (d: Buffer) => { const s = d.toString(); stderr += s; emit(s); });
    child.on("error", (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new HostExecError(e.message, { accessError: isAccessError(e.message) }));
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) { resolvePromise({ stdout, stderr }); return; }
      const detail = (stderr || `command exited with code ${code}`).trim();
      reject(new HostExecError(detail, { accessError: isAccessError(detail), exitCode: code }));
    });
    child.stdin.write(stdin);
    child.stdin.end();
  });
}

/** Atomic write script: tmp file, chmod, rename. The path is validated; content comes from STDIN. */
export function writeFileScript(remotePath: string, mode: string): string {
  assertSafeRemotePath(remotePath);
  if (!/^[0-7]{3,4}$/.test(mode)) throw new Error(`invalid file mode: ${mode}`);
  const tmp = `${remotePath}.tmp`;
  return `set -e; mkdir -p "$(dirname ${shQuote(remotePath)})"; umask 077; cat > ${shQuote(tmp)}; chmod ${mode} ${shQuote(tmp)}; mv -f ${shQuote(tmp)} ${shQuote(remotePath)}`;
}

/** ssh flags shared by every connection: batch mode, no host-key prompts, quiet. */
export function sshArgs(extra: string[] = []): string[] {
  const { sshKeyPath, sshUser, sshHost } = config.runner;
  if (!sshHost) throw new Error("VIBEHUB_RUNNER_KIND=ssh requires VIBEHUB_RUNNER_SSH_HOST");
  return [
    ...(sshKeyPath ? ["-i", sshKeyPath] : []),
    "-o", "BatchMode=yes",
    "-o", "StrictHostKeyChecking=no",
    // A reinstalled host changes its key; /dev/null keeps a stale known_hosts from wedging us.
    "-o", "UserKnownHostsFile=/dev/null",
    // ...which makes ssh print "Permanently added" on every connect. ERROR silences that noise but
    // keeps real failures — otherwise the banner leaks into live logs and the web terminal.
    "-o", "LogLevel=ERROR",
    "-o", "ConnectTimeout=8",
    ...extra,
    `${sshUser}@${sshHost}`,
  ];
}

class LocalExecutor implements HostExecutor {
  readonly kind = "local" as const;
  readonly label = "this machine";
  async runScript(script: string, opts: ExecOpts = {}): Promise<ExecResult> {
    return await runProcess("bash", ["-s"], script, opts);
  }
  /**
   * Local writes go through fs directly (tmp + chmod + rename) — same atomicity as the remote path,
   * without paying for a shell. The path is still validated: callers derive it, but never trust it.
   */
  async writeFile(remotePath: string, content: string, opts: { mode?: string; timeoutMs?: number } = {}): Promise<void> {
    assertSafeRemotePath(remotePath);
    const mode = opts.mode ?? "600";
    if (!/^[0-7]{3,4}$/.test(mode)) throw new Error(`invalid file mode: ${mode}`);
    const tmp = `${remotePath}.tmp`;
    await mkdir(dirname(remotePath), { recursive: true });
    await writeFile(tmp, content, { encoding: "utf8", mode: Number.parseInt(mode, 8) });
    await chmod(tmp, Number.parseInt(mode, 8));
    await rename(tmp, remotePath);
  }
  ptyCommand(remoteCommand: string): { file: string; args: string[] } {
    return { file: "bash", args: ["-lc", remoteCommand] };
  }
}

class SshExecutor implements HostExecutor {
  readonly kind = "ssh" as const;
  get label(): string { return `${config.runner.sshUser}@${config.runner.sshHost}`; }
  async runScript(script: string, opts: ExecOpts = {}): Promise<ExecResult> {
    return await runProcess("ssh", [...sshArgs(), "bash -s"], script, opts);
  }
  async writeFile(remotePath: string, content: string, opts: { mode?: string; timeoutMs?: number } = {}): Promise<void> {
    await runProcess("ssh", [...sshArgs(), writeFileScript(remotePath, opts.mode ?? "600")], content, {
      timeoutMs: opts.timeoutMs,
    });
  }
  ptyCommand(remoteCommand: string): { file: string; args: string[] } {
    // -tt forces a tty even though stdin is a pipe; the command must come AFTER the hostname.
    return { file: "ssh", args: [...sshArgs(["-tt"]), remoteCommand] };
  }
}

let cached: HostExecutor | null = null;

/** The executor for the configured runner host. */
export function hostExecutor(): HostExecutor {
  if (!cached) cached = config.runner.kind === "ssh" ? new SshExecutor() : new LocalExecutor();
  return cached;
}

export function resetHostExecutorForTesting(): void {
  cached = null;
}
