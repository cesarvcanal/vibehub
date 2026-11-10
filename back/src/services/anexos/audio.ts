import { transcreverArquivoDeAudio } from "../transcribe/transcribe.js";
import {
  PACOTES_CONVERSAO_AUDIO, extensaoDe, linhaGarantirPacotes, rodarNoRunner, scriptNoRunner, validarCaminhoNoRunner,
} from "./runner.js";

/** O que o Whisper aceita como veio. Qualquer outra extensão (.opus, .aac, .amr, .wma, vídeo) passa pelo ffmpeg. */
export const FORMATOS_WHISPER = ["flac", "m4a", "mp3", "mp4", "mpeg", "mpga", "oga", "ogg", "wav", "webm"] as const;

/** Abaixo do teto do Whisper (25 MiB) com folga; acima disso o arquivo é convertido, não recusado. */
const TAMANHO_ENVIO_DIRETO = 24_000_000;

/** Inclui a instalação do ffmpeg num runner antigo e a conversão de um áudio longo. */
const TIMEOUT_EXTRACAO_MS = 600_000;

const MARCA_ORIGINAL = "original";
const MARCA_CONVERTIDO = "mp3";

/**
 * Script de host que devolve o áudio a transcrever: uma linha com a marca (original | mp3) e o base64.
 * Original quando o Whisper aceita o formato e o tamanho; senão o ffmpeg converte para mp3 mono 16 kHz
 * 32 kbps (fala, ~100 min cabem em 25 MB). Arquivo temporário em vez de pipe: o `sh` do runner não tem
 * pipefail, e um ffmpeg que falhou viraria um base64 vazio com saída 0. PURE.
 */
export function buildExtrairAudioScript(caminho: string): string {
  const aceito = (FORMATOS_WHISPER as readonly string[]).includes(extensaoDe(caminho)) ? "1" : "0";
  const interno = [
    `test -f "$0" || { echo "arquivo não encontrado: $0" >&2; exit 1; }`,
    `if [ "$1" = 1 ] && [ "$(stat -c %s "$0")" -le ${TAMANHO_ENVIO_DIRETO} ]; then echo ${MARCA_ORIGINAL}; exec base64 -w0 "$0"; fi`,
    linhaGarantirPacotes(PACOTES_CONVERSAO_AUDIO),
    `t=$(mktemp --suffix=.mp3)`,
    `ffmpeg -nostdin -loglevel error -y -i "$0" -vn -ac 1 -ar 16000 -b:a 32k "$t" </dev/null || { rm -f "$t"; echo "o ffmpeg não conseguiu ler este áudio" >&2; exit 1; }`,
    `echo ${MARCA_CONVERTIDO}; base64 -w0 "$t"; s=$?; rm -f "$t"; exit $s`,
  ].join("\n");
  return scriptNoRunner(interno, [caminho, aceito]);
}

/** Separa a marca do base64 e devolve o nome com que o Whisper deve receber o arquivo. PURE. */
export function interpretarAudioExtraido(
  stdout: string,
  caminho: string,
): { audio: Buffer; nomeArquivo: string; convertido: boolean } {
  const quebra = stdout.indexOf("\n");
  const marca = quebra < 0 ? "" : stdout.slice(0, quebra).trim();
  const base64 = stdout.slice(quebra + 1).replace(/\s+/g, "");
  if ((marca !== MARCA_ORIGINAL && marca !== MARCA_CONVERTIDO) || !base64) {
    throw new Error("o runner devolveu um áudio vazio ou ilegível");
  }
  const convertido = marca === MARCA_CONVERTIDO;
  const nomeArquivo = convertido ? "audio.mp3" : `audio.${extensaoDe(caminho)}`;
  return { audio: Buffer.from(base64, "base64"), nomeArquivo, convertido };
}

/** Transcreve um arquivo de áudio (ou vídeo) que está no runner. */
export async function transcreverAudioDoRunner(caminhoInformado: string): Promise<{ texto: string; convertido: boolean }> {
  const caminho = validarCaminhoNoRunner(caminhoInformado);
  const stdout = await rodarNoRunner(buildExtrairAudioScript(caminho), TIMEOUT_EXTRACAO_MS);
  const { audio, nomeArquivo, convertido } = interpretarAudioExtraido(stdout, caminho);
  const texto = await transcreverArquivoDeAudio(audio, nomeArquivo);
  return { texto, convertido };
}
