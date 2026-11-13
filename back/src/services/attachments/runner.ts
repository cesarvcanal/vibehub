import { config } from "../../config/env.js";
import { hostExecutor, shQuote, HostExecError, CONTAINER_DEADLINE_MARGIN_MS } from "../../runtime/host.js";

/**
 * Apt packages the runner needs to open attachments: PDF (poppler), spreadsheets (openpyxl/xlrd), Word
 * (python-docx, catdoc for old .doc/.ppt) and audio beyond what Whisper accepts (ffmpeg). Provisioning
 * already installs them; each tool still checks before running, because a runner provisioned before this
 * list existed would only get the packages in a manual reprovisioning.
 */
export const DOCUMENT_READER_PACKAGES = ["poppler-utils", "python3-openpyxl", "python3-xlrd", "python3-docx", "catdoc"];
export const AUDIO_CONVERTER_PACKAGES = ["ffmpeg"];
export const ATTACHMENT_PACKAGES = [...DOCUMENT_READER_PACKAGES, ...AUDIO_CONVERTER_PACKAGES];

/**
 * Shell line (inside the runner) that installs the missing packages. `dpkg -s` costs milliseconds when
 * everything is already there; the lock timeout makes two simultaneous calls wait their turn instead of
 * failing on dpkg's lock. stdin closed: the rest of stdin is the next command's payload. PURE.
 */
export function ensurePackagesLine(packages: readonly string[]): string {
  const list = packages.join(" ");
  return (
    `dpkg -s ${list} >/dev/null 2>&1 || { export DEBIAN_FRONTEND=noninteractive; ` +
    `apt-get -o DPkg::Lock::Timeout=180 update -qq </dev/null >/dev/null && ` +
    `apt-get -o DPkg::Lock::Timeout=180 install -y -qq ${list} </dev/null >/dev/null; }`
  );
}

/**
 * A file path INSIDE the runner, as the agent gives it. The agent is already root on the runner, so this
 * is not an access boundary: it only refuses what would break the command (relative, line break, NUL).
 * Spaces and accents are legitimate ("Relatório final.xlsx") and go through shQuote. PURE.
 */
export function validateRunnerPath(path: string): string {
  const trimmed = String(path ?? "").trim();
  if (!trimmed.startsWith("/")) throw new Error(`o caminho precisa ser absoluto: ${trimmed || "(vazio)"}`);
  if (/[\n\r\0]/.test(trimmed)) throw new Error("o caminho tem caracteres inválidos");
  return trimmed;
}

/** Lowercase extension, without the dot; "" when there is none. PURE. */
export function extensionOf(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

/**
 * Host script that hands the rest of stdin to a command inside the runner. Same transport as the upload
 * (`buildUploadScript`): the host's bash reads only the first line and `exec` passes stdin along, so the
 * payload is never interpreted as shell. `args` reach `sh -c` as $0, $1…
 *
 * `timeoutMs` is the SAME deadline passed to `runOnRunner`. Node's timeout kills only the `docker exec`
 * client, not what it started in the container (docs/runner-processes.md): an ffmpeg that went past the
 * deadline kept on converting, and each new attempt stacked another one on the runner. The `timeout -s KILL`
 * inside the container kills the whole group (sh and children) with the margin of `containerScriptCommand`,
 * before Node gives up — which does not work here as it is because it reads the SCRIPT from stdin
 * (`bash -s`), and on this path stdin is the payload. PURE; a deadline too short for the margin THROWS.
 */
export function runnerScript(innerCommand: string, args: readonly string[], timeoutMs: number, payload = ""): string {
  const seconds = Math.floor((timeoutMs - CONTAINER_DEADLINE_MARGIN_MS) / 1000);
  if (seconds < 1) throw new Error(`prazo curto demais para o limite dentro do runner: ${timeoutMs}ms`);
  const argv = args.map(shQuote).join(" ");
  return (
    `exec docker exec -i ${shQuote(config.runner.container)} timeout -s KILL ${seconds} ` +
    `sh -c ${shQuote(innerCommand)} ${argv}\n${payload}`
  );
}

/** Runs a script on the runner and returns stdout; a failure becomes the last line of stderr, readable for the agent. */
export async function runOnRunner(script: string, timeoutMs: number): Promise<string> {
  try {
    const { stdout } = await hostExecutor().runScript(script, { timeoutMs });
    return stdout;
  } catch (err) {
    // 137 is how runnerScript's `timeout -s KILL` reports the deadline — and it arrives before Node's.
    if (err instanceof HostExecError && (err.timedOut || err.exitCode === 137)) throw new Error("o runner não respondeu a tempo");
    const lines = String((err as Error).message ?? err).split("\n").map((l) => l.trim()).filter(Boolean);
    throw new Error(lines.at(-1) ?? "falha ao rodar no runner", { cause: err });
  }
}
