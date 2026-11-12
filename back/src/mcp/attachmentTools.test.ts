import { describe, it, expect, vi, beforeEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const readDocument = vi.fn();
const transcribeRunnerAudio = vi.fn();
vi.mock("../services/attachments/document.js", async (original) => ({
  ...(await original<typeof import("../services/attachments/document.js")>()),
  readDocument,
}));
vi.mock("../services/attachments/audio.js", () => ({ transcribeRunnerAudio }));

/** As duas ferramentas de anexo pelo MCP: o que o agente manda e o texto que recebe de volta. */
async function conectar() {
  const { registerAttachmentTools } = await import("./attachmentTools.js");
  const server = new McpServer({ name: "t", version: "1" });
  registerAttachmentTools(server);
  const [lado1, lado2] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "agente", version: "1" });
  await Promise.all([server.connect(lado2), client.connect(lado1)]);
  return async (name: string, args: Record<string, unknown>) => {
    const res = await client.callTool({ name, arguments: args });
    return { texto: (res.content as { text: string }[])[0]!.text, erro: Boolean(res.isError) };
  };
}

beforeEach(() => {
  readDocument.mockReset();
  transcribeRunnerAudio.mockReset();
});

describe("vibehub_read_document", () => {
  it("devolve o markdown como texto puro, com o limite padrão", async () => {
    readDocument.mockResolvedValue({ formato: "xlsx", texto: "| a |\n| --- |", truncado: false });
    const chamar = await conectar();
    expect(await chamar("vibehub_read_document", { path: "/work/.uploads/c/1-x.xlsx" })).toEqual({ texto: "| a |\n| --- |", erro: false });
    expect(readDocument).toHaveBeenCalledWith("/work/.uploads/c/1-x.xlsx", 100_000);
  });

  it("avisa quando cortou, com o limite pedido", async () => {
    readDocument.mockResolvedValue({ formato: "pdf", texto: "abc", truncado: true });
    const chamar = await conectar();
    const r = await chamar("vibehub_read_document", { path: "/a.pdf", limit: 3 });
    expect(r.texto).toBe("abc\n\n[truncado em 3 caracteres]");
  });

  it("documento sem texto diz isso em vez de voltar vazio", async () => {
    readDocument.mockResolvedValue({ formato: "pdf", texto: "", truncado: false });
    const chamar = await conectar();
    expect((await chamar("vibehub_read_document", { path: "/a.pdf" })).texto).toBe("(o documento não tem texto)");
  });

  it("falha volta marcada como erro, com a mensagem", async () => {
    readDocument.mockRejectedValue(new Error("formato não suportado: .zip"));
    const chamar = await conectar();
    expect(await chamar("vibehub_read_document", { path: "/a.zip" })).toEqual({ texto: "erro: formato não suportado: .zip", erro: true });
  });
});

describe("vibehub_transcribe_audio", () => {
  it("devolve a transcrição", async () => {
    transcribeRunnerAudio.mockResolvedValue({ text: "manda o relatório de vendas", converted: false });
    const chamar = await conectar();
    expect(await chamar("vibehub_transcribe_audio", { path: "/work/.uploads/c/1-voz.ogg" })).toEqual({
      texto: "manda o relatório de vendas", erro: false,
    });
  });

  it("sem chave da OpenAI o agente recebe o motivo como erro", async () => {
    transcribeRunnerAudio.mockRejectedValue(new Error("transcrição não configurada: falta a chave da OpenAI em Configurações"));
    const chamar = await conectar();
    const r = await chamar("vibehub_transcribe_audio", { path: "/a.ogg" });
    expect(r.erro).toBe(true);
    expect(r.texto).toContain("falta a chave da OpenAI");
  });
});
