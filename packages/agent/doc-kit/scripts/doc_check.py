"""Deterministic checks on a rendered PDF. Cheap; run after every render.

    doc_check.py <pdf> [--source doc.md] [--budget N]

Returns issues as {check, severity, page, detail}. "error" means the
document is wrong (a font not embedded, text off the page); "warning" means
it probably looks wrong (a near-empty last page, an image wider than the
text). The layout a human sees is doc_inspect's job; this is what can be
measured.
"""

from __future__ import annotations

import argparse
import re
import shutil
from pathlib import Path

from _common import cli, emit, existing, run

FENCE = re.compile(r"^(`{3,}|~{3,}).*?^\1\s*$", re.M | re.S)


def issue(check: str, severity: str, detail: str, page: int | None = None) -> dict:
    return {"check": check, "severity": severity, "page": page, "detail": detail}


def check_fonts(pdf: Path) -> list[dict]:
    if not shutil.which("pdffonts"):
        return [issue("fonts", "info", "pdffonts is not installed; font embedding was not checked")]
    result = run(["pdffonts", str(pdf)])
    issues = []
    for line in result.stdout.splitlines()[2:]:
        cols = line.split()
        # name type [encoding...] emb sub uni object ID -- read from the right.
        if len(cols) >= 7 and cols[-5] == "no":
            issues.append(issue("fonts", "error", f"font {cols[0]} is not embedded; the PDF will look different elsewhere"))
    return issues


def source_headings(source: Path) -> list[tuple[int, str]]:
    text = FENCE.sub("", source.read_text())
    text = re.sub(r"^---\n.*?\n(?:---|\.\.\.)\s*\n", "", text, count=1, flags=re.S)
    found = []
    for m in re.finditer(r"^(#{1,3})\s+(.+?)\s*(?:\{[^}]*\})?\s*$", text, re.M):
        found.append((len(m.group(1)), m.group(2).strip()))
    return found


def check_source(source: Path) -> list[dict]:
    issues = []
    text = FENCE.sub("", source.read_text())
    for alt, path in re.findall(r"!\[([^\]]*)\]\(([^)\s]+)", text):
        if not alt.strip():
            issues.append(issue("figures", "warning", f"image {path} has no caption or alt text"))
    for m in FENCE.finditer(source.read_text()):
        info = m.group(0).split("\n", 1)[0]
        if re.search(r"mermaid|dot|graphviz|vega", info) and "caption=" not in info:
            issues.append(issue("figures", "warning", f"diagram fence `{info.strip()}` has no caption"))
    levels = [lvl for lvl, _ in source_headings(source)]
    for prev, cur in zip(levels, levels[1:]):
        if cur > prev + 1:
            issues.append(issue("headings", "warning", f"heading level jumps from {prev} to {cur}"))
            break
    return issues


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("pdf")
    parser.add_argument("--source")
    parser.add_argument("--budget", type=int)
    args = parser.parse_args()

    import pdfplumber
    from pypdf import PdfReader

    pdf = existing(args.pdf)
    issues: list[dict] = []
    reader = PdfReader(str(pdf))
    total = len(reader.pages)

    if args.budget and total > args.budget:
        issues.append(issue("pages", "error", f"{total} pages, over the budget of {args.budget}"))

    issues += check_fonts(pdf)

    # Links: an internal link to a destination that does not exist, or an empty URI.
    named = set((reader.named_destinations or {}).keys())
    for number, page in enumerate(reader.pages, 1):
        for annot in page.get("/Annots") or []:
            obj = annot.get_object()
            if obj.get("/Subtype") != "/Link":
                continue
            action = obj.get("/A")
            action = action.get_object() if action is not None else {}
            uri = action.get("/URI") if action else None
            dest = obj.get("/Dest")
            if uri is not None and str(uri).strip() in ("", "#"):
                issues.append(issue("links", "error", "a link with an empty target", number))
            if isinstance(dest, str) and dest not in named:
                issues.append(issue("links", "error", f"internal link to missing destination {dest}", number))

    with pdfplumber.open(str(pdf)) as doc:
        rights: list[float] = []
        for page in doc.pages:
            rights += [c["x1"] for c in page.chars]
        rights.sort()
        text_right = rights[int(len(rights) * 0.98)] if rights else None

        for number, page in enumerate(doc.pages, 1):
            words = page.extract_words()
            if not words and not page.images and not page.rects and not page.curves:
                issues.append(issue("blank", "error", "the page is empty", number))
            off = [c for c in page.chars if c["x1"] > page.width + 0.5 or c["x0"] < -0.5 or c["bottom"] > page.height + 0.5]
            if off:
                issues.append(issue("overflow", "error", f"{len(off)} characters run off the page", number))
            for image in page.images:
                if image["x1"] > page.width + 0.5 or image["x0"] < -0.5:
                    issues.append(issue("images", "error", "an image runs off the page", number))
                elif text_right and image["x1"] > text_right + 6:
                    issues.append(issue("images", "warning", "an image is wider than the text block", number))
            if number == total and total > 1:
                lines = {round(w["top"]) for w in words}
                if 0 < len(lines) <= 4:
                    issues.append(issue("layout", "warning", f"the last page holds only {len(lines)} line(s); tighten or cut", number))

    outline_titles: list[str] = []

    def walk(items):
        for item in items:
            if isinstance(item, list):
                walk(item)
            else:
                outline_titles.append(re.sub(r"^[\d.]+\s+", "", str(item.title)).strip())

    try:
        walk(reader.outline)
    except Exception:
        pass

    if args.source and Path(args.source).is_file():
        source = Path(args.source)
        issues += check_source(source)
        expected = [t for _, t in source_headings(source)]
        if outline_titles:
            plain = lambda s: re.sub(r"[^\w]+", " ", re.sub(r"[*_`]", "", s)).strip().lower()
            have = {plain(t) for t in outline_titles}
            missing = [t for t in expected if plain(t) not in have]
            if missing:
                issues.append(issue("toc", "warning", f"headings missing from the PDF outline: {', '.join(missing[:5])}"))

    errors = sum(1 for i in issues if i["severity"] == "error")
    emit({
        "pdf": str(pdf),
        "pages": total,
        "outline": outline_titles[:60],
        "passed": errors == 0,
        "errors": errors,
        "warnings": sum(1 for i in issues if i["severity"] == "warning"),
        "issues": issues,
    })


if __name__ == "__main__":
    cli(main)
