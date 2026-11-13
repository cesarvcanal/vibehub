import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { DOCUMENT_FORMATS, MAX_TEXT_LIMIT, DEFAULT_TEXT_LIMIT, readDocument } from "../services/attachments/document.js";
import { transcribeRunnerAudio } from "../services/attachments/audio.js";

/**
 * ATTACHMENTS — what the agent does with a file the person attached (or that it downloaded itself on the runner).
 *
 * Claude Code's Read opens images and PDFs, but not spreadsheets, Word or audio. These two tools close the
 * gap: the conversion runs inside the runner (the file is already there) and the agent gets text.
 * The answer is plain text, not JSON: a markdown table escaped inside JSON is unreadable.
 */
const textResult = (content: string) => ({ content: [{ type: "text" as const, text: content }] });
const errorResult = (e: unknown) => ({ ...textResult(`erro: ${(e as Error).message}`), isError: true });

export function registerAttachmentTools(server: McpServer): void {
  server.registerTool(
    "vibehub_read_document",
    {
      description:
        "Read a document that is on the runner as markdown text: Excel (.xlsx .xlsm .xls → one markdown " +
        "table per sheet), Word (.docx .doc), PowerPoint (.pptx .ppt → text per slide), OpenDocument " +
        "(.odt .ods .odp), PDF (text layer) and plain text (.csv .txt .json …). Use it for every file the " +
        "user attaches under /work/.uploads/ that is not an image, instead of improvising a parser. A " +
        "scanned PDF has no text layer: open it with your Read tool to see the pages. `limit` caps the " +
        `characters returned (default ${DEFAULT_TEXT_LIMIT}); when the answer says it was truncated, ` +
        `raise it or process the file with python. Formats: ${DOCUMENT_FORMATS.join(", ")}.`,
      inputSchema: {
        path: z.string().min(1).max(1000).describe("absolute path of the file on the runner"),
        limit: z.number().int().min(1).max(MAX_TEXT_LIMIT).optional().describe("max characters to return"),
      },
    },
    async (a) => {
      try {
        const doc = await readDocument(a.path, a.limit ?? DEFAULT_TEXT_LIMIT);
        const notice = doc.truncado ? `\n\n[truncado em ${a.limit ?? DEFAULT_TEXT_LIMIT} caracteres]` : "";
        return textResult(`${doc.texto || "(o documento não tem texto)"}${notice}`);
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    "vibehub_transcribe_audio",
    {
      description:
        "Transcribe an audio (or video) file that is on the runner to text, with Whisper. Any format: " +
        ".ogg/.opus (WhatsApp voice notes), .mp3, .m4a, .wav, .webm, .aac, .amr, .flac, .mp4 … — what " +
        "Whisper does not take is converted with ffmpeg first. Use it whenever the user attaches an audio " +
        "file under /work/.uploads/ (you cannot listen to it yourself) and treat the transcription as what " +
        "the user said. Long files take a while (up to ~100 minutes of speech).",
      inputSchema: {
        path: z.string().min(1).max(1000).describe("absolute path of the audio file on the runner"),
      },
    },
    async (a) => {
      try {
        const { text: transcript } = await transcribeRunnerAudio(a.path);
        return textResult(transcript || "(nenhuma fala reconhecida no áudio)");
      } catch (e) {
        return errorResult(e);
      }
    },
  );
}
