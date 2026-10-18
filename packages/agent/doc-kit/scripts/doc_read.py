"""Reads a document: text, headings, tables and the figures it contains.

    doc_read.py <path> [--pages 1-3,5]

.docx is read with python-docx in body order, so a table appears where it
sits between paragraphs. .pdf is read page by page with pdfplumber, tables
included. .doc, .odt and .rtf are converted to .docx first. Figures are
listed, not described -- doc_inspect is what looks at them.
"""

from __future__ import annotations

import argparse
import tempfile
from pathlib import Path

from _common import as_docx, cli, emit, existing, fail, kind_of, parse_pages

MAX_CHARS = 120_000


def table_markdown(rows: list[list[str]]) -> str:
    rows = [[(c or "").replace("\n", " ").replace("|", "\\|").strip() for c in r] for r in rows if r]
    if not rows:
        return ""
    width = max(len(r) for r in rows)
    rows = [r + [""] * (width - len(r)) for r in rows]
    lines = ["| " + " | ".join(rows[0]) + " |", "|" + " --- |" * width]
    lines += ["| " + " | ".join(r) + " |" for r in rows[1:]]
    return "\n".join(lines)


def read_docx(path: Path) -> dict:
    from docx import Document
    from docx.table import Table
    from docx.text.paragraph import Paragraph

    doc = Document(str(path))
    out: list[str] = []
    headings: list[dict] = []
    tables = 0
    figures: list[dict] = []
    index = 0

    for child in doc.element.body.iterchildren():
        tag = child.tag.rsplit("}", 1)[-1]
        if tag == "p":
            para = Paragraph(child, doc)
            style = para.style.name if para.style is not None else ""
            text = para.text
            if child.xpath(".//*[local-name()='drawing' or local-name()='pict']"):
                figures.append({"paragraph": index, "near": text[:80]})
                out.append(f"[figure {len(figures)}]")
            if style.lower().startswith("heading") or style == "Title":
                level = 0 if style == "Title" else int("".join(ch for ch in style if ch.isdigit()) or 1)
                headings.append({"level": level, "text": text, "paragraph": index})
                out.append(f"{'#' * max(level, 1)} {text}  <!-- p{index} -->")
            elif text.strip():
                prefix = "- " if "List" in style else ""
                out.append(f"{prefix}{text}  <!-- p{index} -->")
            index += 1
        elif tag == "tbl":
            tables += 1
            table = Table(child, doc)
            rows = [[cell.text for cell in row.cells] for row in table.rows]
            out.append(f"<!-- table {tables} -->\n{table_markdown(rows)}")

    props = doc.core_properties
    return {
        "format": "docx",
        "paragraphs": index,
        "tables": tables,
        "figures": figures,
        "headings": headings,
        "sections": len(doc.sections),
        "properties": {"title": props.title, "author": props.author, "subject": props.subject},
        "text": "\n\n".join(out),
    }


def read_pdf(path: Path, pages_spec: str | None) -> dict:
    import pdfplumber
    from pypdf import PdfReader

    reader = PdfReader(str(path))
    if reader.is_encrypted:
        try:
            reader.decrypt("")
        except Exception:
            fail(f"{path.name} is encrypted and needs a password.")
    meta = reader.metadata or {}
    outline: list[dict] = []

    def walk(items, level=1):
        for item in items:
            if isinstance(item, list):
                walk(item, level + 1)
            else:
                try:
                    outline.append({"level": level, "text": item.title, "page": reader.get_destination_page_number(item) + 1})
                except Exception:
                    pass

    try:
        walk(reader.outline)
    except Exception:
        pass

    out: list[str] = []
    figures: list[dict] = []
    table_count = 0
    with pdfplumber.open(str(path)) as pdf:
        total = len(pdf.pages)
        wanted = parse_pages(pages_spec, total)
        for number in wanted:
            page = pdf.pages[number - 1]
            text = page.extract_text() or ""
            # A "table" of one row is a ruled header the line strategy
            # mistook for a whole table; its text is in the page text anyway.
            found = [t for t in (page.extract_tables() or []) if len(t) > 1]
            table_count += len(found)
            parts = [f"<!-- page {number} -->", text.strip() or "(no extractable text -- scanned? use doc_inspect)"]
            for i, rows in enumerate(found, 1):
                parts.append(f"<!-- page {number} table {i} -->\n{table_markdown(rows)}")
            for image in page.images:
                figures.append({
                    "page": number,
                    "width_pt": round(image["x1"] - image["x0"]),
                    "height_pt": round(image["bottom"] - image["top"]),
                })
            out.append("\n\n".join(parts))

    return {
        "format": "pdf",
        "pages": total,
        "read_pages": wanted,
        "tables": table_count,
        "figures": figures,
        "figures_note": "raster images only; vector charts and diagrams show up in doc_inspect's page renders",
        "outline": outline,
        "form_fields": sorted((reader.get_fields() or {}).keys()),
        "properties": {"title": meta.get("/Title"), "author": meta.get("/Author"), "subject": meta.get("/Subject")},
        "text": "\n\n".join(out),
    }


def read_text(path: Path) -> dict:
    return {"format": "text", "text": path.read_text(errors="replace")}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("path")
    parser.add_argument("--pages")
    args = parser.parse_args()

    path = existing(args.path)
    kind = kind_of(path)
    with tempfile.TemporaryDirectory() as scratch:
        if kind == "pdf":
            result = read_pdf(path, args.pages)
        elif kind == "text":
            result = read_text(path)
        else:
            converted = as_docx(path, Path(scratch))
            result = read_docx(converted)
            if converted != path:
                result["converted_from"] = path.suffix.lower()

    text = result["text"]
    if len(text) > MAX_CHARS:
        result["text"] = text[:MAX_CHARS]
        result["truncated"] = f"{len(text) - MAX_CHARS} more characters; read a page range"
    emit(result)


if __name__ == "__main__":
    cli(main)
