"""Converts a document on the runner into text/markdown for the agent and for the chat preview.

Runs INSIDE the runner (`python3 - <caminho> <limite>`, the source arrives through stdin). Prints a JSON
`{"formato", "texto", "truncado"}`; an unsupported format or an unreadable file exits with code != 0 and
the message on stderr. Only the standard library + the apt packages of DOCUMENT_READER_PACKAGES.
"""
import json
import os
import re
import subprocess
import sys
import zipfile
import xml.etree.ElementTree as ET


def cell(value):
    if value is None:
        return ""
    text = str(value)
    if isinstance(value, float) and value.is_integer():
        text = str(int(value))
    return text.replace("|", "\\|").replace("\r", " ").replace("\n", " ").strip()


def markdown_table(rows):
    rows = [[cell(v) for v in row] for row in rows]
    rows = [row for row in rows if any(row)]
    if not rows:
        return "_(vazia)_"
    width = max(len(row) for row in rows)
    while width > 1 and not any(len(row) >= width and row[width - 1] for row in rows):
        width -= 1
    rows = [(row + [""] * width)[:width] for row in rows]
    out = ["| " + " | ".join(rows[0]) + " |", "|" + " --- |" * width]
    out += ["| " + " | ".join(row) + " |" for row in rows[1:]]
    return "\n".join(out)


def xlsx_sheets(path):
    import openpyxl

    workbook = openpyxl.load_workbook(path, read_only=True, data_only=True)
    return "\n\n".join(
        f"## {sheet.title}\n\n" + markdown_table(list(sheet.iter_rows(values_only=True))) for sheet in workbook.worksheets
    )


def xls_sheets(path):
    import xlrd

    workbook = xlrd.open_workbook(path)
    return "\n\n".join(
        f"## {sheet.name}\n\n" + markdown_table([sheet.row_values(i) for i in range(sheet.nrows)]) for sheet in workbook.sheets()
    )


def docx_document(path):
    import docx
    from docx.table import Table
    from docx.text.paragraph import Paragraph

    document = docx.Document(path)
    blocks = []
    for element in document.element.body.iterchildren():
        tag = element.tag.rsplit("}", 1)[-1]
        if tag == "p":
            paragraph = Paragraph(element, document)
            text = paragraph.text.strip()
            if not text:
                continue
            level = re.match(r"(?:Heading|Título)\s*(\d)", paragraph.style.name or "")
            blocks.append(("#" * int(level.group(1)) + " " + text) if level else text)
        elif tag == "tbl":
            table = Table(element, document)
            blocks.append(markdown_table([[c.text for c in row.cells] for row in table.rows]))
    return "\n\n".join(blocks)


def xml_paragraphs(xml, paragraph_tag, text_tag):
    root = ET.fromstring(xml)
    paragraphs = []
    for paragraph in root.iter(paragraph_tag):
        text = "".join(t.text or "" for t in paragraph.iter(text_tag)).strip()
        if text:
            paragraphs.append(text)
    return paragraphs


def pptx_slides(path):
    a = "{http://schemas.openxmlformats.org/drawingml/2006/main}"
    with zipfile.ZipFile(path) as package:
        slides = sorted(
            (n for n in package.namelist() if re.fullmatch(r"ppt/slides/slide\d+\.xml", n)),
            key=lambda n: int(re.search(r"(\d+)\.xml$", n).group(1)),
        )
        return "\n\n".join(
            f"## Slide {i}\n\n" + "\n".join(xml_paragraphs(package.read(n), a + "p", a + "t"))
            for i, n in enumerate(slides, 1)
        )


def odf_text(node):
    s = "{urn:oasis:names:tc:opendocument:xmlns:text:1.0}s"
    parts = [node.text or ""]
    for child in node:
        parts.append(" " if child.tag == s else odf_text(child))
        parts.append(child.tail or "")
    return "".join(parts)


def odf_document(path):
    text = "{urn:oasis:names:tc:opendocument:xmlns:text:1.0}"
    table = "{urn:oasis:names:tc:opendocument:xmlns:table:1.0}"
    with zipfile.ZipFile(path) as package:
        root = ET.fromstring(package.read("content.xml"))
    sheets = list(root.iter(table + "table"))
    if path.lower().endswith(".ods"):
        return "\n\n".join(
            f"## {sheet.get(table + 'name', '')}\n\n"
            + markdown_table(
                [[odf_text(c).strip() for c in row.iter(table + "table-cell")] for row in sheet.iter(table + "table-row")]
            )
            for sheet in sheets
        )
    blocks = []
    for node in root.iter():
        if node.tag in (text + "p", text + "h"):
            content = odf_text(node).strip()
            if content:
                blocks.append(content)
    return "\n\n".join(blocks)


def run_command(*argv):
    return subprocess.run(argv, check=True, capture_output=True, text=True, errors="replace").stdout


def plain_text(path):
    with open(path, encoding="utf-8", errors="replace") as file:
        return file.read()


CONVERTERS = {
    "pdf": lambda c: run_command("pdftotext", "-layout", c, "-"),
    "xlsx": xlsx_sheets,
    "xlsm": xlsx_sheets,
    "xls": xls_sheets,
    "docx": docx_document,
    "doc": lambda c: run_command("catdoc", "-w", "-d", "utf-8", c),
    "pptx": pptx_slides,
    "ppt": lambda c: run_command("catppt", "-d", "utf-8", c),
    "odt": odf_document,
    "ods": odf_document,
    "odp": odf_document,
    "csv": plain_text,
    "tsv": plain_text,
    "txt": plain_text,
    "md": plain_text,
    "json": plain_text,
    "xml": plain_text,
    "html": plain_text,
    "log": plain_text,
}


def main():
    path, limit = sys.argv[1], int(sys.argv[2])
    fmt = os.path.splitext(path)[1].lower().lstrip(".")
    converter = CONVERTERS.get(fmt)
    if converter is None:
        sys.exit(f"formato não suportado: .{fmt or '(sem extensão)'}")
    if not os.path.isfile(path):
        sys.exit(f"arquivo não encontrado: {path}")
    text = converter(path).strip()
    truncated = len(text) > limit
    print(json.dumps({"formato": fmt, "texto": text[:limit], "truncado": truncated}, ensure_ascii=False))


if __name__ == "__main__":
    main()
