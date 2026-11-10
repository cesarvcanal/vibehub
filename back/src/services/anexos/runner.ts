import { config } from "../../config/env.js";
import { hostExecutor, shQuote, HostExecError } from "../../runtime/host.js";

/**
 * Pacotes apt que o runner precisa para abrir anexos: PDF (poppler), planilhas (openpyxl/xlrd), Word
 * (python-docx, catdoc para .doc/.ppt antigos) e áudio fora do que o Whisper aceita (ffmpeg). O
 * provisionamento já instala; cada ferramenta ainda confere antes de rodar, porque um runner
 * provisionado antes desta lista existir só ganharia os pacotes num reprovisionamento manual.
 */
export const PACOTES_LEITURA_DOCUMENTO = ["poppler-utils", "python3-openpyxl", "python3-xlrd", "python3-docx", "catdoc"];
export const PACOTES_CONVERSAO_AUDIO = ["ffmpeg"];
export const PACOTES_ANEXOS = [...PACOTES_LEITURA_DOCUMENTO, ...PACOTES_CONVERSAO_AUDIO];

/**
 * Linha de shell (dentro do runner) que instala os pacotes que faltarem. `dpkg -s` custa milissegundos
 * quando já está tudo lá; o lock timeout faz duas chamadas simultâneas esperarem a vez em vez de
 * falharem no lock do dpkg. stdin fechado: o resto do stdin é o payload do comando seguinte. PURE.
 */
export function linhaGarantirPacotes(pacotes: readonly string[]): string {
  const lista = pacotes.join(" ");
  return (
    `dpkg -s ${lista} >/dev/null 2>&1 || { export DEBIAN_FRONTEND=noninteractive; ` +
    `apt-get -o DPkg::Lock::Timeout=180 update -qq </dev/null >/dev/null && ` +
    `apt-get -o DPkg::Lock::Timeout=180 install -y -qq ${lista} </dev/null >/dev/null; }`
  );
}

/**
 * Caminho de arquivo DENTRO do runner, como o agente o informa. O agente já é root no runner, então
 * isto não é fronteira de acesso: só recusa o que quebraria o comando (relativo, quebra de linha, NUL).
 * Espaço e acento são legítimos ("Relatório final.xlsx") e seguem via shQuote. PURE.
 */
export function validarCaminhoNoRunner(caminho: string): string {
  const limpo = String(caminho ?? "").trim();
  if (!limpo.startsWith("/")) throw new Error(`o caminho precisa ser absoluto: ${limpo || "(vazio)"}`);
  if (/[\n\r\0]/.test(limpo)) throw new Error("o caminho tem caracteres inválidos");
  return limpo;
}

/** Extensão em minúsculas, sem o ponto; "" quando não há. PURE. */
export function extensaoDe(caminho: string): string {
  const nome = caminho.slice(caminho.lastIndexOf("/") + 1);
  const ponto = nome.lastIndexOf(".");
  return ponto > 0 ? nome.slice(ponto + 1).toLowerCase() : "";
}

/**
 * Script de host que entrega o resto do stdin a um comando dentro do runner. Mesmo transporte do
 * upload (`buildUploadScript`): o bash do host lê só a primeira linha e o `exec` passa o stdin adiante,
 * então o payload nunca é interpretado como shell. `argumentos` chegam ao `sh -c` como $0, $1… PURE.
 */
export function scriptNoRunner(comandoInterno: string, argumentos: readonly string[], payload = ""): string {
  const argv = argumentos.map(shQuote).join(" ");
  return `exec docker exec -i ${shQuote(config.runner.container)} sh -c ${shQuote(comandoInterno)} ${argv}\n${payload}`;
}

/** Roda um script no runner e devolve o stdout; a falha vira a última linha do stderr, legível pro agente. */
export async function rodarNoRunner(script: string, timeoutMs: number): Promise<string> {
  try {
    const { stdout } = await hostExecutor().runScript(script, { timeoutMs });
    return stdout;
  } catch (err) {
    if (err instanceof HostExecError && err.timedOut) throw new Error("o runner não respondeu a tempo");
    const linhas = String((err as Error).message ?? err).split("\n").map((l) => l.trim()).filter(Boolean);
    throw new Error(linhas.at(-1) ?? "falha ao rodar no runner", { cause: err });
  }
}
