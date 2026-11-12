import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getCard } from "../board/registry.js";
import { uploadContentType } from "../board/workspace.js";
import {
  PACOTES_LEITURA_DOCUMENTO, extensaoDe, linhaGarantirPacotes, rodarNoRunner, scriptNoRunner, validarCaminhoNoRunner,
} from "./runner.js";

/** Formatos que `read-document.py` converte. Fonte única: a ferramenta MCP e o preview do chat leem daqui. */
export const FORMATOS_DOCUMENTO = [
  "pdf", "xlsx", "xlsm", "xls", "docx", "doc", "pptx", "ppt", "odt", "ods", "odp",
  "csv", "tsv", "txt", "md", "json", "xml", "html", "log",
] as const;

/** Teto padrão do texto devolvido: cabe no contexto do agente sem afogar a conversa. */
export const LIMITE_TEXTO_PADRAO = 100_000;
export const LIMITE_TEXTO_MAXIMO = 400_000;

/** Primeira vez num runner antigo inclui o apt-get dos pacotes. */
const TIMEOUT_LEITURA_MS = 300_000;

const FONTE_CONVERSOR = join(dirname(fileURLToPath(import.meta.url)), "read-document.py");
let conversorEmCache: string | null = null;

function fonteDoConversor(): string {
  conversorEmCache ??= readFileSync(FONTE_CONVERSOR, "utf8");
  return conversorEmCache;
}

export interface DocumentoLido {
  formato: string;
  texto: string;
  truncado: boolean;
}

export function formatoDocumentoSuportado(caminho: string): boolean {
  return (FORMATOS_DOCUMENTO as readonly string[]).includes(extensaoDe(caminho));
}

/** Script de host: garante os pacotes e roda o conversor (fonte pelo stdin) sobre o arquivo. PURE. */
export function buildLerDocumentoScript(caminho: string, limite: number, fonte: string): string {
  const interno = `${linhaGarantirPacotes(PACOTES_LEITURA_DOCUMENTO)}; exec python3 - "$0" "$1"`;
  return scriptNoRunner(interno, [caminho, String(limite)], TIMEOUT_LEITURA_MS, fonte);
}

/** Converte o JSON do conversor, recusando qualquer coisa fora do contrato. PURE. */
export function interpretarSaidaDoConversor(stdout: string): DocumentoLido {
  const dados = JSON.parse(stdout) as Partial<DocumentoLido>;
  if (typeof dados.formato !== "string" || typeof dados.texto !== "string" || typeof dados.truncado !== "boolean") {
    throw new Error("o conversor devolveu uma resposta inválida");
  }
  return { formato: dados.formato, texto: dados.texto, truncado: dados.truncado };
}

/** Lê um documento que está no runner (PDF, Excel, Word, PowerPoint, OpenDocument, texto) como markdown. */
export async function lerDocumento(caminhoInformado: string, limite = LIMITE_TEXTO_PADRAO): Promise<DocumentoLido> {
  const caminho = validarCaminhoNoRunner(caminhoInformado);
  if (!formatoDocumentoSuportado(caminho)) {
    throw new Error(`formato não suportado: .${extensaoDe(caminho) || "(sem extensão)"} — aceitos: ${FORMATOS_DOCUMENTO.join(", ")}`);
  }
  if (!Number.isInteger(limite) || limite < 1 || limite > LIMITE_TEXTO_MAXIMO) throw new Error(`limite inválido: ${limite}`);
  const stdout = await rodarNoRunner(buildLerDocumentoScript(caminho, limite, fonteDoConversor()), TIMEOUT_LEITURA_MS);
  return interpretarSaidaDoConversor(stdout);
}

/**
 * O documento que a pessoa anexou a um card, como texto, para o preview do chat (planilha e Word não
 * abrem no navegador). Mesmas garantias da rota que serve o arquivo: o nome precisa ter a forma que o
 * upload grava e o caminho só é montado a partir de um card que existe.
 */
export async function lerAnexoDoCard(cardId: string, arquivo: string): Promise<DocumentoLido> {
  if (!uploadContentType(arquivo)) throw new Error("upload not found");
  const card = await getCard(cardId);
  if (!card) throw new Error("card not found");
  return await lerDocumento(`/work/.uploads/${card.id}/${arquivo}`);
}
