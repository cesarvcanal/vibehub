"""Converte um documento do runner em texto/markdown para o agente e para o preview do chat.

Roda DENTRO do runner (`python3 - <caminho> <limite>`, o fonte chega pelo stdin). Imprime um JSON
`{"formato", "texto", "truncado"}`; formato não suportado ou arquivo ilegível sai com código != 0 e a
mensagem no stderr. Só biblioteca padrão + os pacotes apt de PACOTES_LEITURA_ANEXOS.
"""
import json
import os
import re
import subprocess
import sys
import zipfile
import xml.etree.ElementTree as ET


def celula(valor):
    if valor is None:
        return ""
    texto = str(valor)
    if isinstance(valor, float) and valor.is_integer():
        texto = str(int(valor))
    return texto.replace("|", "\\|").replace("\r", " ").replace("\n", " ").strip()


def tabela_markdown(linhas):
    linhas = [[celula(v) for v in linha] for linha in linhas]
    linhas = [linha for linha in linhas if any(linha)]
    if not linhas:
        return "_(vazia)_"
    largura = max(len(linha) for linha in linhas)
    while largura > 1 and not any(len(linha) >= largura and linha[largura - 1] for linha in linhas):
        largura -= 1
    linhas = [(linha + [""] * largura)[:largura] for linha in linhas]
    saida = ["| " + " | ".join(linhas[0]) + " |", "|" + " --- |" * largura]
    saida += ["| " + " | ".join(linha) + " |" for linha in linhas[1:]]
    return "\n".join(saida)


def planilha_xlsx(caminho):
    import openpyxl

    livro = openpyxl.load_workbook(caminho, read_only=True, data_only=True)
    return "\n\n".join(
        f"## {aba.title}\n\n" + tabela_markdown(list(aba.iter_rows(values_only=True))) for aba in livro.worksheets
    )


def planilha_xls(caminho):
    import xlrd

    livro = xlrd.open_workbook(caminho)
    return "\n\n".join(
        f"## {aba.name}\n\n" + tabela_markdown([aba.row_values(i) for i in range(aba.nrows)]) for aba in livro.sheets()
    )


def documento_docx(caminho):
    import docx
    from docx.table import Table
    from docx.text.paragraph import Paragraph

    documento = docx.Document(caminho)
    blocos = []
    for elemento in documento.element.body.iterchildren():
        tag = elemento.tag.rsplit("}", 1)[-1]
        if tag == "p":
            paragrafo = Paragraph(elemento, documento)
            texto = paragrafo.text.strip()
            if not texto:
                continue
            nivel = re.match(r"(?:Heading|Título)\s*(\d)", paragrafo.style.name or "")
            blocos.append(("#" * int(nivel.group(1)) + " " + texto) if nivel else texto)
        elif tag == "tbl":
            tabela = Table(elemento, documento)
            blocos.append(tabela_markdown([[c.text for c in linha.cells] for linha in tabela.rows]))
    return "\n\n".join(blocos)


def textos_xml(xml, tag_paragrafo, tag_texto):
    raiz = ET.fromstring(xml)
    paragrafos = []
    for paragrafo in raiz.iter(tag_paragrafo):
        texto = "".join(t.text or "" for t in paragrafo.iter(tag_texto)).strip()
        if texto:
            paragrafos.append(texto)
    return paragrafos


def apresentacao_pptx(caminho):
    a = "{http://schemas.openxmlformats.org/drawingml/2006/main}"
    with zipfile.ZipFile(caminho) as pacote:
        slides = sorted(
            (n for n in pacote.namelist() if re.fullmatch(r"ppt/slides/slide\d+\.xml", n)),
            key=lambda n: int(re.search(r"(\d+)\.xml$", n).group(1)),
        )
        return "\n\n".join(
            f"## Slide {i}\n\n" + "\n".join(textos_xml(pacote.read(n), a + "p", a + "t"))
            for i, n in enumerate(slides, 1)
        )


def texto_odf(no):
    s = "{urn:oasis:names:tc:opendocument:xmlns:text:1.0}s"
    partes = [no.text or ""]
    for filho in no:
        partes.append(" " if filho.tag == s else texto_odf(filho))
        partes.append(filho.tail or "")
    return "".join(partes)


def documento_odf(caminho):
    texto = "{urn:oasis:names:tc:opendocument:xmlns:text:1.0}"
    tabela = "{urn:oasis:names:tc:opendocument:xmlns:table:1.0}"
    with zipfile.ZipFile(caminho) as pacote:
        raiz = ET.fromstring(pacote.read("content.xml"))
    abas = list(raiz.iter(tabela + "table"))
    if caminho.lower().endswith(".ods"):
        return "\n\n".join(
            f"## {aba.get(tabela + 'name', '')}\n\n"
            + tabela_markdown(
                [[texto_odf(c).strip() for c in linha.iter(tabela + "table-cell")] for linha in aba.iter(tabela + "table-row")]
            )
            for aba in abas
        )
    blocos = []
    for no in raiz.iter():
        if no.tag in (texto + "p", texto + "h"):
            conteudo = texto_odf(no).strip()
            if conteudo:
                blocos.append(conteudo)
    return "\n\n".join(blocos)


def comando(*argv):
    return subprocess.run(argv, check=True, capture_output=True, text=True, errors="replace").stdout


def texto_puro(caminho):
    with open(caminho, encoding="utf-8", errors="replace") as arquivo:
        return arquivo.read()


CONVERSORES = {
    "pdf": lambda c: comando("pdftotext", "-layout", c, "-"),
    "xlsx": planilha_xlsx,
    "xlsm": planilha_xlsx,
    "xls": planilha_xls,
    "docx": documento_docx,
    "doc": lambda c: comando("catdoc", "-w", "-d", "utf-8", c),
    "pptx": apresentacao_pptx,
    "ppt": lambda c: comando("catppt", "-d", "utf-8", c),
    "odt": documento_odf,
    "ods": documento_odf,
    "odp": documento_odf,
    "csv": texto_puro,
    "tsv": texto_puro,
    "txt": texto_puro,
    "md": texto_puro,
    "json": texto_puro,
    "xml": texto_puro,
    "html": texto_puro,
    "log": texto_puro,
}


def main():
    caminho, limite = sys.argv[1], int(sys.argv[2])
    formato = os.path.splitext(caminho)[1].lower().lstrip(".")
    conversor = CONVERSORES.get(formato)
    if conversor is None:
        sys.exit(f"formato não suportado: .{formato or '(sem extensão)'}")
    if not os.path.isfile(caminho):
        sys.exit(f"arquivo não encontrado: {caminho}")
    texto = conversor(caminho).strip()
    truncado = len(texto) > limite
    print(json.dumps({"formato": formato, "texto": texto[:limite], "truncado": truncado}, ensure_ascii=False))


if __name__ == "__main__":
    main()
