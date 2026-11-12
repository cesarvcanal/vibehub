import { transcreverArquivoDeAudio } from "../transcribe/transcribe.js";
import {
  AUDIO_CONVERTER_PACKAGES, extensionOf, ensurePackagesLine, runOnRunner, runnerScript, validateRunnerPath,
} from "./runner.js";

/** O que o Whisper aceita como veio. Qualquer outra extensão (.opus, .aac, .amr, .wma, vídeo) passa pelo ffmpeg. */
export const WHISPER_FORMATS = ["flac", "m4a", "mp3", "mp4", "mpeg", "mpga", "oga", "ogg", "wav", "webm"] as const;

/** Abaixo do teto do Whisper (25 MiB) com folga; acima disso o arquivo é convertido, não recusado. */
const DIRECT_UPLOAD_MAX_BYTES = 24_000_000;

/** Inclui a instalação do ffmpeg num runner antigo e a conversão de um áudio longo. */
const EXTRACT_TIMEOUT_MS = 600_000;

const ORIGINAL_MARK = "original";
const CONVERTED_MARK = "mp3";

/**
 * Script de host que devolve o áudio a transcrever: uma linha com a marca (original | mp3) e o base64.
 * Original quando o Whisper aceita o formato e o tamanho; senão o ffmpeg converte para mp3 mono 16 kHz
 * 32 kbps (fala, ~100 min cabem em 25 MB). Arquivo temporário em vez de pipe: o `sh` do runner não tem
 * pipefail, e um ffmpeg que falhou viraria um base64 vazio com saída 0. PURE.
 */
export function buildExtractAudioScript(path: string): string {
  const accepted = (WHISPER_FORMATS as readonly string[]).includes(extensionOf(path)) ? "1" : "0";
  const inner = [
    `test -f "$0" || { echo "arquivo não encontrado: $0" >&2; exit 1; }`,
    `if [ "$1" = 1 ] && [ "$(stat -c %s "$0")" -le ${DIRECT_UPLOAD_MAX_BYTES} ]; then echo ${ORIGINAL_MARK}; exec base64 -w0 "$0"; fi`,
    ensurePackagesLine(AUDIO_CONVERTER_PACKAGES),
    `t=$(mktemp --suffix=.mp3)`,
    `ffmpeg -nostdin -loglevel error -y -i "$0" -vn -ac 1 -ar 16000 -b:a 32k "$t" </dev/null || { rm -f "$t"; echo "o ffmpeg não conseguiu ler este áudio" >&2; exit 1; }`,
    `echo ${CONVERTED_MARK}; base64 -w0 "$t"; s=$?; rm -f "$t"; exit $s`,
  ].join("\n");
  return runnerScript(inner, [path, accepted], EXTRACT_TIMEOUT_MS);
}

/** Separa a marca do base64 e devolve o nome com que o Whisper deve receber o arquivo. PURE. */
export function parseExtractedAudio(
  stdout: string,
  path: string,
): { audio: Buffer; fileName: string; converted: boolean } {
  const newline = stdout.indexOf("\n");
  const mark = newline < 0 ? "" : stdout.slice(0, newline).trim();
  const base64 = stdout.slice(newline + 1).replace(/\s+/g, "");
  if ((mark !== ORIGINAL_MARK && mark !== CONVERTED_MARK) || !base64) {
    throw new Error("o runner devolveu um áudio vazio ou ilegível");
  }
  const converted = mark === CONVERTED_MARK;
  const fileName = converted ? "audio.mp3" : `audio.${extensionOf(path)}`;
  return { audio: Buffer.from(base64, "base64"), fileName, converted };
}

/** Transcreve um arquivo de áudio (ou vídeo) que está no runner. */
export async function transcribeRunnerAudio(givenPath: string): Promise<{ text: string; converted: boolean }> {
  const path = validateRunnerPath(givenPath);
  const stdout = await runOnRunner(buildExtractAudioScript(path), EXTRACT_TIMEOUT_MS);
  const { audio, fileName, converted } = parseExtractedAudio(stdout, path);
  const text = await transcreverArquivoDeAudio(audio, fileName);
  return { text, converted };
}
