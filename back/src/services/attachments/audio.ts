import { transcribeAudioFile } from "../transcribe/transcribe.js";
import {
  AUDIO_CONVERTER_PACKAGES, extensionOf, ensurePackagesLine, runOnRunner, runnerScript, validateRunnerPath,
} from "./runner.js";

/** What Whisper accepts as it came. Any other extension (.opus, .aac, .amr, .wma, video) goes through ffmpeg. */
export const WHISPER_FORMATS = ["flac", "m4a", "mp3", "mp4", "mpeg", "mpga", "oga", "ogg", "wav", "webm"] as const;

/** Comfortably below Whisper's cap (25 MiB); above it the file is converted, not refused. */
const DIRECT_UPLOAD_MAX_BYTES = 24_000_000;

/** Includes installing ffmpeg on an old runner and converting a long audio. */
const EXTRACT_TIMEOUT_MS = 600_000;

const ORIGINAL_MARK = "original";
const CONVERTED_MARK = "mp3";

/**
 * Host script that returns the audio to transcribe: one line with the mark (original | mp3) and the base64.
 * Original when Whisper accepts the format and the size; otherwise ffmpeg converts it to mono mp3 16 kHz
 * 32 kbps (speech, ~100 min fit in 25 MB). A temporary file instead of a pipe: the runner's `sh` has no
 * pipefail, and an ffmpeg that failed would become an empty base64 with exit 0. PURE.
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

/** Separates the mark from the base64 and returns the name Whisper must receive the file with. PURE. */
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

/** Transcribes an audio (or video) file that is on the runner. */
export async function transcribeRunnerAudio(givenPath: string): Promise<{ text: string; converted: boolean }> {
  const path = validateRunnerPath(givenPath);
  const stdout = await runOnRunner(buildExtractAudioScript(path), EXTRACT_TIMEOUT_MS);
  const { audio, fileName, converted } = parseExtractedAudio(stdout, path);
  const text = await transcribeAudioFile(audio, fileName);
  return { text, converted };
}
