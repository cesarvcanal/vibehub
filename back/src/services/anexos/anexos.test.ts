import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildLerDocumentoScript, formatoDocumentoSuportado, interpretarSaidaDoConversor } from "./documento.js";
import { buildExtrairAudioScript, interpretarAudioExtraido } from "./audio.js";
import { extensaoDe, linhaGarantirPacotes, rodarNoRunner, scriptNoRunner, validarCaminhoNoRunner } from "./runner.js";

/**
 * Os scripts de anexo RODANDO de verdade: um `docker` falso executa o comando do container aqui
 * mesmo e um `dpkg` falso diz que os pacotes já estão instalados (o teste nunca chama apt-get).
 * Formatos que dependem de pacote apt (openpyxl, python-docx, ffmpeg) só rodam onde ele existe.
 */
const FONTE = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "ler-documento.py"), "utf8");
const temPython = spawnSync("python3", ["--version"]).status === 0;
const temModulo = (m: string) => temPython && spawnSync("python3", ["-c", `import ${m}`]).status === 0;
const temFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;

let dir = "";
let bin = "";

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "vh-anexos-"));
  bin = join(dir, "bin");
  mkdirSync(bin);
  // Sem `exec`: como o cliente `docker exec`, ele sobrevive ao comando e devolve 137 quando o
  // `timeout -s KILL` do container o mata (com `exec`, o próprio processo morreria por sinal).
  writeFileSync(join(bin, "docker"), "#!/bin/sh\nshift 3\n\"$@\"\n");
  writeFileSync(join(bin, "dpkg"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(bin, "docker"), 0o755);
  chmodSync(join(bin, "dpkg"), 0o755);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function rodar(script: string): { stdout: string; stderr: string; status: number | null } {
  const r = spawnSync("bash", ["-s"], {
    input: script,
    encoding: "utf8",
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
  });
  return { stdout: r.stdout, stderr: r.stderr, status: r.status };
}

function lerAqui(caminho: string, limite = 10_000) {
  const r = rodar(buildLerDocumentoScript(caminho, limite, FONTE));
  if (r.status !== 0) throw new Error(r.stderr.trim());
  return interpretarSaidaDoConversor(r.stdout);
}

/** Um zip montado pelo python da própria máquina — pptx e OpenDocument são zip + XML. */
function zipar(destino: string, arquivos: Record<string, string>): void {
  execFileSync("python3", ["-c", [
    "import sys, json, zipfile",
    "z = zipfile.ZipFile(sys.argv[1], 'w')",
    "[z.writestr(n, c) for n, c in json.loads(sys.argv[2]).items()]",
    "z.close()",
  ].join("\n"), destino, JSON.stringify(arquivos)]);
}

describe("conversor de documentos (ler-documento.py)", () => {
  it.skipIf(!temPython)("csv com espaço e acento no nome volta como veio", () => {
    const caminho = join(dir, "Relatório final.csv");
    writeFileSync(caminho, "filial;valor\n5;10,50\n");
    expect(lerAqui(caminho)).toEqual({ formato: "csv", texto: "filial;valor\n5;10,50", truncado: false });
  });

  it.skipIf(!temPython)("texto acima do limite volta cortado e marcado como truncado", () => {
    const caminho = join(dir, "grande.txt");
    writeFileSync(caminho, "x".repeat(500));
    const lido = lerAqui(caminho, 100);
    expect(lido.texto).toHaveLength(100);
    expect(lido.truncado).toBe(true);
  });

  it.skipIf(!temPython)("pptx vira texto por slide, na ordem numérica (slide10 depois de slide2)", () => {
    const caminho = join(dir, "apresentacao.pptx");
    const slide = (t: string) =>
      `<p:sld xmlns:p="x" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:p><a:r><a:t>${t}</a:t></a:r></a:p></p:sld>`;
    zipar(caminho, { "ppt/slides/slide10.xml": slide("Fim"), "ppt/slides/slide2.xml": slide("Meio"), "ppt/slides/slide1.xml": slide("Início") });
    expect(lerAqui(caminho).texto).toBe("## Slide 1\n\nInício\n\n## Slide 2\n\nMeio\n\n## Slide 3\n\nFim");
  });

  it.skipIf(!temPython)("ods vira uma tabela markdown por aba, com | escapado", () => {
    const caminho = join(dir, "planilha.ods");
    const conteudo =
      `<office:document-content xmlns:office="o" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"><office:body>` +
      `<table:table table:name="Vendas">` +
      `<table:table-row><table:table-cell><text:p>Filial</text:p></table:table-cell><table:table-cell><text:p>Obs</text:p></table:table-cell></table:table-row>` +
      `<table:table-row><table:table-cell><text:p>5</text:p></table:table-cell><table:table-cell><text:p>a|b</text:p></table:table-cell></table:table-row>` +
      `</table:table></office:body></office:document-content>`;
    zipar(caminho, { "content.xml": conteudo });
    expect(lerAqui(caminho).texto).toBe("## Vendas\n\n| Filial | Obs |\n| --- | --- |\n| 5 | a\\|b |");
  });

  it.skipIf(!temModulo("openpyxl"))("xlsx: cada aba vira tabela; aba vazia é dita vazia", () => {
    const caminho = join(dir, "vendas.xlsx");
    execFileSync("python3", ["-c", [
      "import sys, openpyxl",
      "wb = openpyxl.Workbook(); ws = wb.active; ws.title = 'Vendas'",
      "ws.append(['Filial', 'Valor']); ws.append([5, 1234.5]); ws.append([1, 10.0])",
      "wb.create_sheet('Vazia'); wb.save(sys.argv[1])",
    ].join("\n"), caminho]);
    expect(lerAqui(caminho).texto).toBe(
      "## Vendas\n\n| Filial | Valor |\n| --- | --- |\n| 5 | 1234.5 |\n| 1 | 10 |\n\n## Vazia\n\n_(vazia)_",
    );
  });

  it.skipIf(!temModulo("docx"))("docx: título vira heading e tabela vira tabela markdown, na ordem do documento", () => {
    const caminho = join(dir, "contrato.docx");
    execFileSync("python3", ["-c", [
      "import sys, docx",
      "d = docx.Document(); d.add_heading('Contrato', 1); d.add_paragraph('Cláusula primeira.')",
      "t = d.add_table(rows=2, cols=2); t.cell(0, 0).text = 'A'; t.cell(1, 1).text = 'B'; d.save(sys.argv[1])",
    ].join("\n"), caminho]);
    expect(lerAqui(caminho).texto).toBe("# Contrato\n\nCláusula primeira.\n\n| A |  |\n| --- | --- |\n|  | B |");
  });

  it.skipIf(!temPython)("arquivo que não existe falha com a mensagem, não com JSON vazio", () => {
    expect(() => lerAqui(join(dir, "sumiu.docx"))).toThrow("arquivo não encontrado");
  });

  it.skipIf(!temPython)("extensão fora da lista falha dizendo o formato", () => {
    const caminho = join(dir, "pacote.zip");
    writeFileSync(caminho, "x");
    expect(() => lerAqui(caminho)).toThrow("formato não suportado: .zip");
  });
});

describe("extração do áudio para o Whisper", () => {
  it("formato aceito pelo Whisper vai como veio, com a extensão original", () => {
    const caminho = join(dir, "voz.ogg");
    writeFileSync(caminho, "OggS-bytes");
    const r = rodar(buildExtrairAudioScript(caminho));
    expect(r.status).toBe(0);
    const extraido = interpretarAudioExtraido(r.stdout, caminho);
    expect(extraido).toMatchObject({ nomeArquivo: "audio.ogg", convertido: false });
    expect(extraido.audio.toString()).toBe("OggS-bytes");
  });

  it.skipIf(!temFfmpeg)(".opus (fora da lista do Whisper) é convertido para mp3", () => {
    const caminho = join(dir, "zap.opus");
    execFileSync("ffmpeg", ["-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-c:a", "libopus", "-y", caminho]);
    const extraido = interpretarAudioExtraido(rodar(buildExtrairAudioScript(caminho)).stdout, caminho);
    expect(extraido).toMatchObject({ nomeArquivo: "audio.mp3", convertido: true });
    expect(extraido.audio.length).toBeGreaterThan(100);
  });

  it.skipIf(!temFfmpeg)("áudio corrompido falha dizendo que o ffmpeg não leu, sem base64 vazio", () => {
    const caminho = join(dir, "ruim.amr");
    writeFileSync(caminho, "lixo");
    const r = rodar(buildExtrairAudioScript(caminho));
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("o ffmpeg não conseguiu ler este áudio");
  });

  it("arquivo que não existe falha antes de qualquer conversão", () => {
    const r = rodar(buildExtrairAudioScript(join(dir, "nada.mp3")));
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("arquivo não encontrado");
  });

  it("saída sem marca ou sem conteúdo é recusada", () => {
    expect(() => interpretarAudioExtraido("", "/x.ogg")).toThrow("vazio ou ilegível");
    expect(() => interpretarAudioExtraido("original\n", "/x.ogg")).toThrow("vazio ou ilegível");
    expect(() => interpretarAudioExtraido("outra\nAAAA", "/x.ogg")).toThrow("vazio ou ilegível");
  });
});

describe("prazo dentro do runner", () => {
  it("o comando roda sob `timeout -s KILL` com a margem do containerScriptCommand, nos dois chamadores", () => {
    const primeira = (script: string) => script.slice(0, script.indexOf("\n"));
    // 600 s de extração e 300 s de leitura, menos os 15 s de margem: o runner mata antes do Node desistir.
    expect(primeira(buildExtrairAudioScript("/work/a.opus"))).toMatch(/^exec docker exec -i '[^']+' timeout -s KILL 585 sh -c '/);
    expect(primeira(buildLerDocumentoScript("/work/a.pdf", 10, "print(1)"))).toMatch(/^exec docker exec -i '[^']+' timeout -s KILL 285 sh -c '/);
  });

  it("estourado o prazo, o comando e o que ele iniciou morrem no runner — não ficam órfãos", () => {
    const pidFile = join(dir, "orfao.pid");
    const inicio = Date.now();
    // 16 s de prazo no Node = 1 s dentro do runner. O `sleep` é o ffmpeg que seguia convertendo.
    const r = rodar(scriptNoRunner(`sleep 20 & echo $! > "$0"; wait`, [pidFile], 16_000));
    expect(r.status).not.toBe(0);
    expect(Date.now() - inicio).toBeLessThan(10_000);
    const pid = Number(readFileSync(pidFile, "utf8").trim());
    expect(spawnSync("kill", ["-0", String(pid)]).status).not.toBe(0); // o filho morreu junto
  });

  it("o agente lê que o prazo estourou, não um código de saída cru", async () => {
    const pathOriginal = process.env.PATH;
    process.env.PATH = `${bin}:${pathOriginal}`; // o executor local herda o PATH com o `docker` falso
    try {
      await expect(rodarNoRunner(scriptNoRunner("sleep 20", [], 16_000), 30_000)).rejects.toThrow("o runner não respondeu a tempo");
      // Outra falha continua chegando com a última linha do stderr.
      await expect(rodarNoRunner(scriptNoRunner(`echo "quebrou aqui" >&2; exit 3`, [], 30_000), 30_000)).rejects.toThrow("quebrou aqui");
    } finally {
      process.env.PATH = pathOriginal;
    }
  });

  it("o stdin continua chegando ao comando (é por ele que vai a fonte do conversor)", () => {
    const r = rodar(scriptNoRunner(`cat`, [], 60_000, "linha do payload\n"));
    expect(r).toMatchObject({ status: 0, stdout: "linha do payload\n" });
  });

  it("prazo curto demais para manter a margem é recusado antes de existir um comando", () => {
    expect(() => scriptNoRunner("true", [], 15_500)).toThrow(/curto/);
  });
});

describe("contratos puros", () => {
  it("caminho precisa ser absoluto e de uma linha só; espaço e acento passam", () => {
    expect(validarCaminhoNoRunner(" /work/Relatório final.xlsx ")).toBe("/work/Relatório final.xlsx");
    expect(() => validarCaminhoNoRunner("relativo.xlsx")).toThrow("absoluto");
    expect(() => validarCaminhoNoRunner("/work/a\nrm -rf /")).toThrow("inválidos");
  });

  it("extensão em minúsculas, sem confundir dotfile ou pasta com ponto", () => {
    expect(extensaoDe("/work/a/Planilha.XLSX")).toBe("xlsx");
    expect(extensaoDe("/work/.uploads/sem-extensao")).toBe("");
    expect(extensaoDe("/work/.bashrc")).toBe("");
    expect(formatoDocumentoSuportado("/work/x.docx")).toBe(true);
    expect(formatoDocumentoSuportado("/work/x.png")).toBe(false);
  });

  it("instalação de pacotes só roda quando o dpkg diz que falta algo, e espera o lock", () => {
    const linha = linhaGarantirPacotes(["ffmpeg"]);
    expect(linha).toMatch(/^dpkg -s ffmpeg >\/dev\/null 2>&1 \|\| /);
    expect(linha).toContain("DPkg::Lock::Timeout");
    expect(linha).toContain("</dev/null");
  });

  it("JSON do conversor fora do contrato é recusado", () => {
    expect(() => interpretarSaidaDoConversor('{"texto":"x"}')).toThrow("resposta inválida");
  });
});
