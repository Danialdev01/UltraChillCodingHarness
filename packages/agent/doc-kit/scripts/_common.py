"""Shared plumbing for the doc-kit scripts.

Every script is a small CLI the agent's document tools call with an argv
array. The contract is the same for all of them: one JSON object on stdout
when it worked, a plain-language message on stderr and a non-zero exit when
it did not. The tool turns stderr into the model's error text, so messages
here are written for a model to act on.
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any, Callable, NoReturn

KIT = Path(__file__).resolve().parent.parent
TEMPLATES = KIT / "templates"
FONTS = KIT / "fonts"


def emit(payload: dict[str, Any]) -> NoReturn:
    json.dump(payload, sys.stdout, ensure_ascii=False)
    sys.stdout.write("\n")
    sys.exit(0)


class DocError(Exception):
    """A failure the model can act on. `cli` prints it to stderr and exits 1."""


def fail(message: str) -> NoReturn:
    raise DocError(message)


def cli(main: Callable[[], None]) -> None:
    try:
        main()
    except DocError as error:
        sys.stderr.write(str(error).rstrip() + "\n")
        sys.exit(1)
    except Exception as error:  # a damaged file, or a case no check caught
        sys.stderr.write(f"{type(error).__name__}: {error}\n")
        sys.exit(2)


def need(binary: str, why: str) -> str:
    found = shutil.which(binary)
    if not found:
        fail(f"{binary} is not installed on this server, so {why} is not available.")
    return found


def run(argv: list[str], *, timeout: int = 120, cwd: str | None = None) -> subprocess.CompletedProcess[str]:
    try:
        return subprocess.run(argv, capture_output=True, text=True, timeout=timeout, cwd=cwd)
    except subprocess.TimeoutExpired:
        fail(f"{Path(argv[0]).name} did not finish within {timeout} seconds.")


def existing(path: str) -> Path:
    p = Path(path)
    if not p.is_file():
        fail(f"{path} does not exist or is not a file.")
    return p


def kind_of(path: Path) -> str:
    suffix = path.suffix.lower()
    if suffix in (".docx", ".docm", ".dotx"):
        return "docx"
    if suffix == ".doc":
        return "doc"
    if suffix == ".pdf":
        return "pdf"
    if suffix in (".odt", ".rtf"):
        return "office"
    if suffix in (".md", ".markdown", ".txt"):
        return "text"
    fail(f"{path.name}: unsupported format {suffix or '(none)'}. Supported: .pdf, .docx, .doc, .odt, .rtf, .md.")


def soffice_convert(src: Path, fmt: str, out_dir: Path) -> Path:
    """Converts with LibreOffice headless. Used for .doc/.odt/.rtf and docx->pdf."""
    binary = shutil.which("soffice") or shutil.which("libreoffice")
    if not binary:
        fail(f"LibreOffice is not installed, so {src.suffix} files cannot be converted.")
    # A private profile per call: two conversions sharing the default profile
    # lock each other out, and the second fails with no message.
    with tempfile.TemporaryDirectory() as profile:
        result = run(
            [
                binary,
                f"-env:UserInstallation=file://{profile}",
                "--headless",
                "--convert-to",
                fmt,
                "--outdir",
                str(out_dir),
                str(src),
            ],
            timeout=180,
        )
    out = out_dir / f"{src.stem}.{fmt.split(':')[0]}"
    if not out.is_file():
        fail(f"LibreOffice could not convert {src.name} to {fmt}: {result.stderr.strip() or result.stdout.strip()}")
    return out


def as_docx(path: Path, scratch: Path) -> Path:
    """The file itself if it is a .docx, otherwise a converted copy."""
    if kind_of(path) == "docx":
        return path
    return soffice_convert(path, "docx", scratch)


def parse_pages(spec: str | None, total: int) -> list[int]:
    """'1-3,5' -> [1, 2, 3, 5], clipped to the document. None means every page."""
    if not spec:
        return list(range(1, total + 1))
    pages: list[int] = []
    for part in spec.split(","):
        part = part.strip()
        if not part:
            continue
        if "-" in part:
            a, b = part.split("-", 1)
            start, end = int(a or 1), int(b or total)
            pages.extend(range(start, end + 1))
        else:
            pages.append(int(part))
    return [p for p in dict.fromkeys(pages) if 1 <= p <= total]


def content_hash(*parts: str | bytes) -> str:
    h = hashlib.sha256()
    for part in parts:
        h.update(part.encode() if isinstance(part, str) else part)
        h.update(b"\0")
    return h.hexdigest()[:16]


def cache_dir(workspace: Path) -> Path:
    d = workspace / ".ucch" / "doc-cache"
    d.mkdir(parents=True, exist_ok=True)
    return d


def font_args() -> list[str]:
    return ["--font-path", str(FONTS)] if FONTS.is_dir() else []


def env_with_fonts() -> dict[str, str]:
    env = dict(os.environ)
    if FONTS.is_dir():
        env["TYPST_FONT_PATHS"] = str(FONTS)
    return env
