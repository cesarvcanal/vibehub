import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { FORMATOS_DOCUMENTO, LIMITE_TEXTO_MAXIMO, LIMITE_TEXTO_PADRAO, lerDocumento } from "../services/attachments/document.js";
import { transcreverAudioDoRunner } from "../services/attachments/audio.js";

/**
 * ANEXOS — o que o agente faz com um arquivo que a pessoa anexou (ou que ele mesmo baixou no runner).
 *
 * O Read do Claude Code abre imagem e PDF, mas não planilha, Word nem áudio. Estas duas ferramentas
 * fecham o buraco: a conversão roda dentro do runner (o arquivo já está lá) e o agente recebe texto.
 * Resposta em texto puro, não JSON: uma tabela markdown escapada dentro de JSON é ilegível.
 */
const texto = (conteudo: string) => ({ content: [{ type: "text" as const, text: conteudo }] });
const falha = (e: unknown) => ({ ...texto(`erro: ${(e as Error).message}`), isError: true });

export function registerAnexoTools(server: McpServer): void {
  server.registerTool(
    "vibehub_read_document",
    {
      description:
        "Read a document that is on the runner as markdown text: Excel (.xlsx .xlsm .xls → one markdown " +
        "table per sheet), Word (.docx .doc), PowerPoint (.pptx .ppt → text per slide), OpenDocument " +
        "(.odt .ods .odp), PDF (text layer) and plain text (.csv .txt .json …). Use it for every file the " +
        "user attaches under /work/.uploads/ that is not an image, instead of improvising a parser. A " +
        "scanned PDF has no text layer: open it with your Read tool to see the pages. `limit` caps the " +
        `characters returned (default ${LIMITE_TEXTO_PADRAO}); when the answer says it was truncated, ` +
        `raise it or process the file with python. Formats: ${FORMATOS_DOCUMENTO.join(", ")}.`,
      inputSchema: {
        path: z.string().min(1).max(1000).describe("absolute path of the file on the runner"),
        limit: z.number().int().min(1).max(LIMITE_TEXTO_MAXIMO).optional().describe("max characters to return"),
      },
    },
    async (a) => {
      try {
        const lido = await lerDocumento(a.path, a.limit ?? LIMITE_TEXTO_PADRAO);
        const aviso = lido.truncado ? `\n\n[truncado em ${a.limit ?? LIMITE_TEXTO_PADRAO} caracteres]` : "";
        return texto(`${lido.texto || "(o documento não tem texto)"}${aviso}`);
      } catch (e) {
        return falha(e);
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
        const { texto: transcricao } = await transcreverAudioDoRunner(a.path);
        return texto(transcricao || "(nenhuma fala reconhecida no áudio)");
      } catch (e) {
        return falha(e);
      }
    },
  );
}
