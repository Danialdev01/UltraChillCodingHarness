"""Renders a structural diagram to SVG.

    doc_diagram.py <lang> <source-file> --out <path.svg|png> [--workspace .]

lang is mermaid (mmdc, headless Chromium) or dot/graphviz. Renders are
cached by content hash under .ucch/doc-cache/diagrams, so re-rendering a
document does not re-launch a browser for every unchanged diagram. On a
syntax error the engine's own stderr is returned: it names the line, and the
model fixes the source from it.
"""

from __future__ import annotations

import argparse
import json
import re
import shutil
import tempfile
from pathlib import Path

from _common import cache_dir, cli, content_hash, emit, fail, need, run

LANGS = {"mermaid": "mermaid", "mmd": "mermaid", "dot": "dot", "graphviz": "dot", "gv": "dot"}
MAX_NODES = 15


def estimate_nodes(lang: str, source: str) -> int:
    if lang == "dot":
        ids = re.findall(r'^\s*"?([\w.]+)"?\s*(?:\[|->|--|;|$)', source, re.M)
        ids += re.findall(r'(?:->|--)\s*"?([\w.]+)"?', source)
    else:
        ids = re.findall(r"\b([A-Za-z][\w]*)\s*(?:[\[\(\{>]|-->|---|-\.|==>)", source)
        ids += re.findall(r"(?:-->|---|-\.->|==>)\s*(?:\|[^|]*\|\s*)?([A-Za-z][\w]*)", source)
    skip = {"graph", "flowchart", "subgraph", "end", "digraph", "node", "edge", "TD", "LR", "TB", "RL", "BT", "style", "classDef"}
    return len({i for i in ids if i not in skip})


def render(lang: str, source: str, workspace: Path, ext: str = "svg") -> tuple[Path, list[str]]:
    engine = LANGS.get(lang.lower())
    if not engine:
        fail(f"{lang} is not a supported diagram language. Use mermaid or dot.")
    out_dir = cache_dir(workspace) / "diagrams"
    out_dir.mkdir(parents=True, exist_ok=True)
    if ext not in ("svg", "png"):
        fail("A diagram renders to .svg or .png.")
    out = out_dir / f"{engine}-{content_hash(engine, source)}.{ext}"
    warnings: list[str] = []
    nodes = estimate_nodes(engine, source)
    if nodes > MAX_NODES:
        warnings.append(f"about {nodes} nodes: above {MAX_NODES} a diagram is unreadable on a page; split it")
    if out.is_file():
        return out, warnings

    with tempfile.TemporaryDirectory() as tmp:
        scratch = Path(tmp)
        if engine == "dot":
            need("dot", "Graphviz diagrams")
            src = scratch / "in.dot"
            src.write_text(source)
            result = run(["dot", f"-T{ext}", "-Gdpi=200" if ext == "png" else "-Gdpi=96", "-Gfontname=Inter", "-Nfontname=Inter", "-Efontname=Inter", str(src), "-o", str(out)])
        else:
            need("mmdc", "Mermaid diagrams")
            src = scratch / "in.mmd"
            src.write_text(source)
            puppeteer = {"args": ["--no-sandbox", "--disable-gpu"]}
            chromium = shutil.which("chromium") or shutil.which("chromium-browser") or shutil.which("google-chrome")
            if chromium:
                puppeteer["executablePath"] = chromium
            config = scratch / "puppeteer.json"
            config.write_text(json.dumps(puppeteer))
            theme = scratch / "mermaid.json"
            theme.write_text(json.dumps({"theme": "neutral", "fontFamily": "Inter, Noto Sans, DejaVu Sans, sans-serif"}))
            result = run(
                ["mmdc", "-i", str(src), "-o", str(out), "-b", "white" if ext == "png" else "transparent", "-s", "2", "-p", str(config), "-c", str(theme), "-q"],
                timeout=90,
            )
        if result.returncode != 0 or not out.is_file():
            out.unlink(missing_ok=True)
            fail(f"{engine} could not render the diagram:\n{(result.stderr or result.stdout).strip()[-3000:]}")
    return out, warnings


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("lang")
    parser.add_argument("source")
    parser.add_argument("--out", required=True)
    parser.add_argument("--workspace", default=".")
    args = parser.parse_args()

    source = Path(args.source).read_text()
    out = Path(args.out)
    cached, warnings = render(args.lang, source, Path(args.workspace).resolve(), out.suffix.lstrip(".").lower() or "svg")
    out.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(cached, out)
    emit({"path": str(out), "warnings": warnings})


if __name__ == "__main__":
    cli(main)
