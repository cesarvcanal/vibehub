import { config } from "../../config/env.js";
import { hostExecutor, shQuote, HostExecError, CONTAINER_DEADLINE_MARGIN_MS } from "../../runtime/host.js";

/**
 * Pacotes apt que o runner precisa para abrir anexos: PDF (poppler), planilhas (openpyxl/xlrd), Word
 * (python-docx, catdoc para .doc/.ppt antigos) e áudio fora do que o Whisper aceita (ffmpeg). O
 * provisionamento já instala; cada ferramenta ainda confere antes de rodar, porque um runner
 * provisionado antes desta lista existir só ganharia os pacotes num reprovisionamento manual.
 */
export const DOCUMENT_READER_PACKAGES = ["poppler-utils", "python3-openpyxl", "python3-xlrd", "python3-docx", "catdoc"];
export const AUDIO_CONVERTER_PACKAGES = ["ffmpeg"];
export const ATTACHMENT_PACKAGES = [...DOCUMENT_READER_PACKAGES, ...AUDIO_CONVERTER_PACKAGES];

/**
 * Linha de shell (dentro do runner) que instala os pacotes que faltarem. `dpkg -s` custa milissegundos
 * quando já está tudo lá; o lock timeout faz duas chamadas simultâneas esperarem a vez em vez de
 * falharem no lock do dpkg. stdin fechado: o resto do stdin é o payload do comando seguinte. PURE.
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
 * Caminho de arquivo DENTRO do runner, como o agente o informa. O agente já é root no runner, então
 * isto não é fronteira de acesso: só recusa o que quebraria o comando (relativo, quebra de linha, NUL).
 * Espaço e acento são legítimos ("Relatório final.xlsx") e seguem via shQuote. PURE.
 */
export function validateRunnerPath(path: string): string {
  const trimmed = String(path ?? "").trim();
  if (!trimmed.startsWith("/")) throw new Error(`o caminho precisa ser absoluto: ${trimmed || "(vazio)"}`);
  if (/[\n\r\0]/.test(trimmed)) throw new Error("o caminho tem caracteres inválidos");
  return trimmed;
}

/** Extensão em minúsculas, sem o ponto; "" quando não há. PURE. */
export function extensionOf(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

/**
 * Script de host que entrega o resto do stdin a um comando dentro do runner. Mesmo transporte do
 * upload (`buildUploadScript`): o bash do host lê só a primeira linha e o `exec` passa o stdin adiante,
 * então o payload nunca é interpretado como shell. `args` chegam ao `sh -c` como $0, $1…
 *
 * `timeoutMs` é o MESMO prazo passado ao `runOnRunner`. O timeout do Node mata só o cliente
 * `docker exec`, não o que ele iniciou no container (docs/runner-processes.md): um ffmpeg que estourou
 * o prazo seguia convertendo, e cada nova tentativa empilhava outro no runner. O `timeout -s KILL`
 * dentro do container mata o grupo inteiro (sh e filhos) com a margem do `containerScriptCommand`,
 * antes de o Node desistir — que aqui não serve como está porque lê o SCRIPT do stdin (`bash -s`), e
 * neste caminho o stdin é o payload. PURE; prazo curto demais para a margem LANÇA.
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

/** Roda um script no runner e devolve o stdout; a falha vira a última linha do stderr, legível pro agente. */
export async function runOnRunner(script: string, timeoutMs: number): Promise<string> {
  try {
    const { stdout } = await hostExecutor().runScript(script, { timeoutMs });
    return stdout;
  } catch (err) {
    // 137 é como o `timeout -s KILL` de runnerScript relata o prazo — e chega antes do do Node.
    if (err instanceof HostExecError && (err.timedOut || err.exitCode === 137)) throw new Error("o runner não respondeu a tempo");
    const lines = String((err as Error).message ?? err).split("\n").map((l) => l.trim()).filter(Boolean);
    throw new Error(lines.at(-1) ?? "falha ao rodar no runner", { cause: err });
  }
}
