"""Renders a document.

    doc_render.py <source> --format pdf|docx|html [--out <path>] [--workspace .]

From Markdown (with YAML front matter): fenced ```mermaid / ```dot /
```vega-lite blocks are rendered to images first, then

    pdf   pandoc -> Typst markup with the house template -> typst compile
    docx  pandoc with the house reference.docx
    html  pandoc, standalone, resources embedded

From .docx/.doc/.odt/.rtf to pdf: LibreOffice, which keeps the document's
own layout rather than re-typesetting it.

The template is chosen by `type:` in the front matter. The model never
writes page setup; templates/base.typ does.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import tempfile
from pathlib import Path

from _common import (
    TEMPLATES,
    DocError,
    cache_dir,
    cli,
    content_hash,
    emit,
    env_with_fonts,
    existing,
    fail,
    font_args,
    kind_of,
    need,
    run,
    soffice_convert,
)
from doc_diagram import LANGS as DIAGRAM_LANGS
from doc_diagram import render as render_diagram

CHART_LANGS = ("vega-lite", "vegalite", "vl")
TYPES = ("report", "spec", "api-reference", "proposal", "runbook", "memo")

FENCE = re.compile(
    r"^(?P<fence>`{3,}|~{3,})[ \t]*(?P<info>[^\n]*)\n(?P<body>.*?)\n(?P=fence)[ \t]*$",
    re.M | re.S,
)


def parse_info(info: str) -> tuple[str, dict[str, str], str | None]:
    """'mermaid {caption="Flow" #fig-flow}' or '{.mermaid caption="Flow"}' -> (lang, attrs, id)."""
    info = info.strip()
    lang = ""
    m = re.match(r"^([\w-]+)\s*(.*)$", info)
    if m and not info.startswith("{"):
        lang, info = m.group(1), m.group(2)
    attrs: dict[str, str] = {}
    ident = None
    inner = info.strip()
    if inner.startswith("{") and inner.endswith("}"):
        inner = inner[1:-1]
        for cls in re.findall(r"(?:^|\s)\.([\w-]+)", inner):
            lang = lang or cls
        found = re.search(r"(?:^|\s)#([\w:-]+)", inner)
        ident = found.group(1) if found else None
        for key, quoted, bare in re.findall(r'([\w-]+)=(?:"([^"]*)"|(\S+))', inner):
            attrs[key] = quoted or bare
    return lang.lower(), attrs, ident


def front_matter(text: str) -> dict[str, str]:
    m = re.match(r"^---\n(.*?)\n(?:---|\.\.\.)\s*\n", text, re.S)
    if not m:
        return {}
    fields = {}
    for line in m.group(1).splitlines():
        kv = re.match(r"^([\w-]+):\s*(.*)$", line)
        if kv:
            fields[kv.group(1)] = kv.group(2).strip().strip("'\"")
    return fields


def render_blocks(text: str, source_dir: Path, workspace: Path, image_ext: str, fallback: bool) -> tuple[str, list[str], list[dict]]:
    """Replaces each diagram/chart fence with an image of it.

    Without `fallback` the first figure that will not render stops the
    render, with the engine's error. With it, every broken figure is left as
    a code block and reported, so the document still comes out.
    """
    warnings: list[str] = []
    errors: list[dict] = []
    figures = 0
    out_parts: list[str] = []
    last = 0

    for m in FENCE.finditer(text):
        out_parts.append(text[last : m.start()])
        last = m.end()
        lang, attrs, ident = parse_info(m.group("info"))
        if lang not in DIAGRAM_LANGS and lang not in CHART_LANGS:
            out_parts.append(m.group(0))
            continue
        figures += 1
        body = m.group("body")
        try:
            if lang in CHART_LANGS:
                path = render_chart_inline(body, workspace, image_ext)
            else:
                path, notes = render_diagram(lang, body, workspace, image_ext)
                warnings.extend(f"figure {figures}: {n}" for n in notes)
        except DocError as error:
            if not fallback:
                fail(f"Figure {figures} ({lang}) did not render:\n{error}")
            errors.append({"figure": figures, "lang": lang, "error": str(error)})
            out_parts.append(m.group(0))
            continue

        caption = attrs.get("caption", "")
        alt = attrs.get("alt", caption)
        if not caption:
            warnings.append(f"figure {figures} ({lang}) has no caption")
        attr_parts = [f"#{ident}"] if ident else []
        if attrs.get("width"):
            attr_parts.append(f'width="{attrs["width"]}"')
        if alt:
            attr_parts.append(f'fig-alt="{alt}"')
        attr = "{" + " ".join(attr_parts) + "}" if attr_parts else ""
        out_parts.append(f"![{caption}]({os.path.relpath(path, source_dir)}){attr}")

    out_parts.append(text[last:])
    return "".join(out_parts), warnings, errors


def render_chart_inline(body: str, workspace: Path, ext: str) -> Path:
    import subprocess
    import sys

    with tempfile.TemporaryDirectory() as tmp:
        spec = Path(tmp) / "spec.json"
        spec.write_text(body)
        out = Path(tmp) / f"chart.{ext}"
        script = Path(__file__).with_name("doc_chart.py")
        result = subprocess.run(
            [sys.executable, str(script), str(spec), "--out", str(out), "--workspace", str(workspace)],
            capture_output=True,
            text=True,
            timeout=120,
        )
        if result.returncode != 0:
            fail(result.stderr.strip())
        data = out.read_bytes()
    final = cache_dir(workspace) / "charts" / f"inline-{content_hash(data)}.{ext}"
    final.parent.mkdir(parents=True, exist_ok=True)
    final.write_bytes(data)
    return final


def install_templates(workspace: Path) -> None:
    """Typst only reads inside --root, so the templates are placed in the workspace."""
    dest = cache_dir(workspace) / "templates"
    dest.mkdir(parents=True, exist_ok=True)
    for name in ("base.typ",):
        shutil.copyfile(TEMPLATES / name, dest / name)
    gitignore = cache_dir(workspace) / ".gitignore"
    if not gitignore.exists():
        gitignore.write_text("*\n")


def page_count(pdf: Path) -> int | None:
    try:
        from pypdf import PdfReader

        return len(PdfReader(str(pdf)).pages)
    except Exception:
        return None


def from_markdown(src: Path, fmt: str, out: Path, workspace: Path, fallback: bool) -> dict:
    need("pandoc", "document rendering")
    text = src.read_text()
    meta = front_matter(text)
    doctype = meta.get("type", "report")
    warnings: list[str] = []
    if doctype not in TYPES:
        warnings.append(f"type {doctype!r} is not a template; using report. Types: {', '.join(TYPES)}")
    if not meta.get("title"):
        warnings.append("no title in the front matter")

    image_ext = "svg" if fmt in ("pdf", "html") else "png"
    body, figure_warnings, figure_errors = render_blocks(text, src.parent, workspace, image_ext, fallback)
    warnings += figure_warnings

    images = re.findall(r"!\[([^\]]*)\]\(([^)\s]+)", body)
    for caption, path in images:
        if not caption.strip():
            warnings.append(f"image {path} has no caption/alt text")
        if not path.startswith(("http://", "https://", "data:")) and not (src.parent / path).exists():
            warnings.append(f"image {path} does not exist")

    filters = ["--lua-filter", str(TEMPLATES / "filters.lua")]
    out.parent.mkdir(parents=True, exist_ok=True)

    if fmt == "pdf":
        need("typst", "PDF rendering")
        install_templates(workspace)
        # Beside the source, so the relative image paths in it still resolve.
        typ = src.with_name(f".{src.stem}.ucch.typ")
        staged = src.with_name(f".{src.stem}.ucch.md")
        staged.write_text(body)
        try:
            result = run(
                ["pandoc", str(staged), "-f", "markdown", "-t", "typst", "--standalone",
                 "--template", str(TEMPLATES / "pandoc.typ"), *filters, "-o", str(typ)],
                cwd=str(src.parent),
            )
            if result.returncode != 0:
                fail(f"pandoc could not read the Markdown:\n{result.stderr.strip()}")
            warnings += [w for w in result.stderr.strip().splitlines() if w]
            import subprocess

            compiled = subprocess.run(
                ["typst", "compile", "--root", str(workspace), *font_args(), str(typ), str(out)],
                capture_output=True, text=True, timeout=180, env=env_with_fonts(),
            )
            if compiled.returncode != 0:
                fail(
                    "typst could not compile the document. The error names a line of the generated "
                    f"markup ({typ.relative_to(workspace)}), kept for reading:\n{compiled.stderr.strip()[-4000:]}"
                )
            # The template names a chain of fonts and uses the first one
            # installed; the ones further along being absent is the design.
            typst_warnings = [
                line for line in compiled.stderr.splitlines()
                if line.startswith("warning:")
                and "unknown font family" not in line
                # Raised inside cached packages (cetz on this Typst), not by the document.
                and "is deprecated" not in line
            ]
            warnings += typst_warnings
            typ.unlink(missing_ok=True)
        finally:
            staged.unlink(missing_ok=True)
        return {"path": str(out), "format": "pdf", "type": doctype, "pages": page_count(out), "warnings": warnings, "figure_errors": figure_errors}

    staged = src.with_name(f".{src.stem}.ucch.md")
    staged.write_text(body)
    try:
        if fmt == "docx":
            reference = TEMPLATES / "reference.docx"
            argv = ["pandoc", str(staged), "-o", str(out), *filters]
            if reference.is_file():
                argv += ["--reference-doc", str(reference)]
            if meta.get("toc") == "true":
                argv.append("--toc")
        else:
            argv = ["pandoc", str(staged), "-o", str(out), "--standalone", "--embed-resources", *filters]
        result = run(argv, cwd=str(src.parent))
    finally:
        staged.unlink(missing_ok=True)
    if result.returncode != 0:
        fail(f"pandoc could not render the document:\n{result.stderr.strip()}")
    return {"path": str(out), "format": fmt, "type": doctype, "warnings": warnings, "figure_errors": figure_errors}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("source")
    parser.add_argument("--format", choices=("pdf", "docx", "html"), default="pdf")
    parser.add_argument("--out")
    parser.add_argument("--workspace", default=".")
    parser.add_argument("--fallback", action="store_true", help="leave a figure that will not render as a code block")
    args = parser.parse_args()

    src = existing(args.source).resolve()
    workspace = Path(args.workspace).resolve()
    out = Path(args.out).resolve() if args.out else src.with_suffix(f".{args.format}")
    kind = kind_of(src)

    if kind == "text":
        emit(from_markdown(src, args.format, out, workspace, args.fallback))
    if kind == "pdf":
        fail("The source is already a PDF. Edit it with doc_edit, or render from its Markdown or .docx source.")
    if args.format != "pdf":
        fail(f"A {src.suffix} source can only be rendered to pdf here; to change its content use doc_edit.")
    with tempfile.TemporaryDirectory() as tmp:
        converted = soffice_convert(src, "pdf", Path(tmp))
        out.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(converted, out)
    emit({"path": str(out), "format": "pdf", "pages": page_count(out), "warnings": []})


if __name__ == "__main__":
    cli(main)
