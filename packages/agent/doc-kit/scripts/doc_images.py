"""Turns a document into pictures a vision model can look at.

    doc_images.py <path> [--pages 1-3] [--figures] [--dpi 80] [--max 6]

Default: rasterises pages (pdftoppm). A .docx/.doc is rendered to PDF with
LibreOffice first, so what is looked at is how the document actually lays
out. --figures instead pulls the embedded images -- charts, diagrams,
photos -- out of the file at their own resolution.

Prints base64 PNG/JPEG data; the tool hands it straight to the vision model
and never to the coding model, whose context it would flood.
"""

from __future__ import annotations

import argparse
import base64
import tempfile
import zipfile
from pathlib import Path

from _common import cli, emit, existing, fail, kind_of, need, parse_pages, run, soffice_convert

MIME = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp"}
MAX_IMAGE_BYTES = 4 * 1024 * 1024


def page_count(pdf: Path) -> int:
    from pypdf import PdfReader

    return len(PdfReader(str(pdf)).pages)


def rasterise(pdf: Path, spec: str | None, dpi: int, limit: int, scratch: Path) -> tuple[list[dict], int]:
    need("pdftoppm", "page rendering")
    total = page_count(pdf)
    pages = parse_pages(spec, total)[:limit]
    images = []
    for number in pages:
        prefix = scratch / f"p{number}"
        result = run(["pdftoppm", "-png", "-r", str(dpi), "-f", str(number), "-l", str(number), "-singlefile", str(pdf), str(prefix)])
        png = prefix.with_suffix(".png")
        if not png.is_file():
            fail(f"pdftoppm could not render page {number}: {result.stderr.strip()}")
        images.append({"page": number, "mime": "image/png", "data": base64.b64encode(png.read_bytes()).decode()})
    return images, total


def docx_figures(path: Path, limit: int) -> list[dict]:
    images = []
    with zipfile.ZipFile(path) as z:
        for name in sorted(n for n in z.namelist() if n.startswith("word/media/")):
            mime = MIME.get(Path(name).suffix.lower())
            if not mime:
                continue  # EMF/WMF: the vision model cannot read them
            data = z.read(name)
            if len(data) > MAX_IMAGE_BYTES:
                continue
            images.append({"name": Path(name).name, "mime": mime, "data": base64.b64encode(data).decode()})
            if len(images) >= limit:
                break
    return images


def pdf_figures(path: Path, spec: str | None, limit: int) -> list[dict]:
    from pypdf import PdfReader

    reader = PdfReader(str(path))
    images = []
    for number in parse_pages(spec, len(reader.pages)):
        for image in reader.pages[number - 1].images:
            suffix = Path(image.name).suffix.lower() or ".png"
            mime = MIME.get(suffix)
            if not mime or len(image.data) > MAX_IMAGE_BYTES:
                continue
            images.append({"page": number, "name": image.name, "mime": mime, "data": base64.b64encode(image.data).decode()})
            if len(images) >= limit:
                return images
    return images


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("path")
    parser.add_argument("--pages")
    parser.add_argument("--figures", action="store_true")
    parser.add_argument("--dpi", type=int, default=80)
    parser.add_argument("--max", type=int, default=6)
    args = parser.parse_args()

    path = existing(args.path)
    kind = kind_of(path)
    with tempfile.TemporaryDirectory() as tmp:
        scratch = Path(tmp)
        if args.figures:
            if kind == "pdf":
                images = pdf_figures(path, args.pages, args.max)
            elif kind == "docx":
                images = docx_figures(path, args.max)
            else:
                images = docx_figures(soffice_convert(path, "docx", scratch), args.max)
            emit({"mode": "figures", "images": images})

        pdf = path if kind == "pdf" else soffice_convert(path, "pdf", scratch)
        images, total = rasterise(pdf, args.pages, args.dpi, args.max, scratch)
        emit({"mode": "pages", "pages": total, "images": images})


if __name__ == "__main__":
    cli(main)
