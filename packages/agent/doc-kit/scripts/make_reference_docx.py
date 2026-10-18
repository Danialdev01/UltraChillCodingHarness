"""Builds templates/reference.docx: the house style for Word output.

    pandoc -o default.docx --print-default-data-file reference.docx
    python make_reference_docx.py default.docx ../templates/reference.docx

Pandoc copies every style from the reference document, so the fonts and
colours here are what a rendered .docx looks like. Kept as a script so the
reference can be rebuilt after a token changes in base.typ, rather than
being a binary nobody can review.
"""

from __future__ import annotations

import sys

from docx import Document
from docx.shared import Pt, RGBColor

INK = RGBColor(0x1F, 0x23, 0x28)
MUTED = RGBColor(0x59, 0x63, 0x6E)
ACCENT = RGBColor(0x0B, 0x5C, 0xAD)
BODY = "Inter"
MONO = "JetBrains Mono"


def main(src: str, out: str) -> None:
    doc = Document(src)
    styles = doc.styles

    def style(name: str, size: float | None = None, color: RGBColor | None = None, bold: bool | None = None, font: str = BODY):
        try:
            s = styles[name]
        except KeyError:
            return
        s.font.name = font
        if size:
            s.font.size = Pt(size)
        if color is not None:
            s.font.color.rgb = color
        if bold is not None:
            s.font.bold = bold

    for name in ("Normal", "Body Text", "First Paragraph", "Compact", "Block Text"):
        style(name, 10.5, INK)
    style("Title", 26, INK, True)
    style("Subtitle", 15, MUTED, False)
    style("Author", 10.5, MUTED)
    style("Date", 10.5, MUTED)
    style("Abstract", 10.5, INK)
    style("Heading 1", 18, ACCENT, True)
    style("Heading 2", 14, INK, True)
    style("Heading 3", 12, INK, True)
    style("Heading 4", 11, INK, True)
    style("Image Caption", 9.5, MUTED)
    style("Table Caption", 9.5, MUTED)
    style("Source Code", 9.5, INK, font=MONO)
    style("Verbatim Char", 9.5, INK, font=MONO)
    style("Hyperlink", None, ACCENT)
    doc.save(out)


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
