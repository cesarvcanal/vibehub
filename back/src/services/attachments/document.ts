import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getCard } from "../board/registry.js";
import { uploadContentType } from "../board/workspace.js";
import {
  DOCUMENT_READER_PACKAGES, extensionOf, ensurePackagesLine, runOnRunner, runnerScript, validateRunnerPath,
} from "./runner.js";

/** Formatos que `read-document.py` converte. Fonte única: a ferramenta MCP e o preview do chat leem daqui. */
export const DOCUMENT_FORMATS = [
  "pdf", "xlsx", "xlsm", "xls", "docx", "doc", "pptx", "ppt", "odt", "ods", "odp",
  "csv", "tsv", "txt", "md", "json", "xml", "html", "log",
] as const;

/** Teto padrão do texto devolvido: cabe no contexto do agente sem afogar a conversa. */
export const DEFAULT_TEXT_LIMIT = 100_000;
export const MAX_TEXT_LIMIT = 400_000;

/** Primeira vez num runner antigo inclui o apt-get dos pacotes. */
const READ_TIMEOUT_MS = 300_000;

const CONVERTER_SOURCE_PATH = join(dirname(fileURLToPath(import.meta.url)), "read-document.py");
let cachedConverterSource: string | null = null;

function converterSource(): string {
  cachedConverterSource ??= readFileSync(CONVERTER_SOURCE_PATH, "utf8");
  return cachedConverterSource;
}

export interface DocumentText {
  formato: string;
  texto: string;
  truncado: boolean;
}

export function isSupportedDocument(path: string): boolean {
  return (DOCUMENT_FORMATS as readonly string[]).includes(extensionOf(path));
}

/** Script de host: garante os pacotes e roda o conversor (fonte pelo stdin) sobre o arquivo. PURE. */
export function buildReadDocumentScript(path: string, limit: number, source: string): string {
  const inner = `${ensurePackagesLine(DOCUMENT_READER_PACKAGES)}; exec python3 - "$0" "$1"`;
  return runnerScript(inner, [path, String(limit)], READ_TIMEOUT_MS, source);
}

/** Converte o JSON do conversor, recusando qualquer coisa fora do contrato. PURE. */
export function parseConverterOutput(stdout: string): DocumentText {
  const parsed = JSON.parse(stdout) as Partial<DocumentText>;
  if (typeof parsed.formato !== "string" || typeof parsed.texto !== "string" || typeof parsed.truncado !== "boolean") {
    throw new Error("o conversor devolveu uma resposta inválida");
  }
  return { formato: parsed.formato, texto: parsed.texto, truncado: parsed.truncado };
}

/** Lê um documento que está no runner (PDF, Excel, Word, PowerPoint, OpenDocument, texto) como markdown. */
export async function readDocument(givenPath: string, limit = DEFAULT_TEXT_LIMIT): Promise<DocumentText> {
  const path = validateRunnerPath(givenPath);
  if (!isSupportedDocument(path)) {
    throw new Error(`formato não suportado: .${extensionOf(path) || "(sem extensão)"} — aceitos: ${DOCUMENT_FORMATS.join(", ")}`);
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_TEXT_LIMIT) throw new Error(`limite inválido: ${limit}`);
  const stdout = await runOnRunner(buildReadDocumentScript(path, limit, converterSource()), READ_TIMEOUT_MS);
  return parseConverterOutput(stdout);
}

/**
 * O documento que a pessoa anexou a um card, como texto, para o preview do chat (planilha e Word não
 * abrem no navegador). Mesmas garantias da rota que serve o arquivo: o nome precisa ter a forma que o
 * upload grava e o caminho só é montado a partir de um card que existe.
 */
export async function readCardAttachment(cardId: string, fileName: string): Promise<DocumentText> {
  if (!uploadContentType(fileName)) throw new Error("upload not found");
  const card = await getCard(cardId);
  if (!card) throw new Error("card not found");
  return await readDocument(`/work/.uploads/${card.id}/${fileName}`);
}
