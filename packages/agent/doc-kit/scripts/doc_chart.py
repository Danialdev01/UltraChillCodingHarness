"""Renders a data chart from a Vega-Lite spec and a data table.

    doc_chart.py <spec.json> --out <path.svg|png> [--data table.csv|json] [--workspace .]

The model writes a spec and the numbers, never drawing code. The house theme
(templates/vega-theme.json) is applied underneath the spec, so a chart
matches the document it sits in; anything the spec sets itself wins.
vl-convert renders without a browser.
"""

from __future__ import annotations

import argparse
import csv
import json
from pathlib import Path

from _common import TEMPLATES, cache_dir, cli, content_hash, emit, fail


def load_rows(path: Path) -> list[dict]:
    if path.suffix.lower() == ".json":
        rows = json.loads(path.read_text())
        if not isinstance(rows, list):
            fail("--data JSON must be an array of row objects.")
        return rows
    with path.open(newline="") as handle:
        rows = list(csv.DictReader(handle))

    def number(value: str):
        try:
            return int(value)
        except ValueError:
            try:
                return float(value)
            except ValueError:
                return value

    return [{k: number(v) for k, v in row.items()} for row in rows]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("spec")
    parser.add_argument("--out", required=True)
    parser.add_argument("--data")
    parser.add_argument("--workspace", default=".")
    args = parser.parse_args()

    try:
        import vl_convert as vlc
    except ImportError:
        fail("vl-convert-python is not installed on this server, so charts are not available.")

    try:
        spec = json.loads(Path(args.spec).read_text())
    except json.JSONDecodeError as error:
        fail(f"The spec is not valid JSON: {error}")
    if args.data:
        spec["data"] = {"values": load_rows(Path(args.data))}
    if "data" not in spec:
        fail("The spec has no data. Give rows in data.values or pass a data table.")
    spec.setdefault("$schema", "https://vega.github.io/schema/vega-lite/v5.json")
    spec.setdefault("width", 460)
    spec.setdefault("height", 260)

    theme = json.loads((TEMPLATES / "vega-theme.json").read_text())
    spec["config"] = {**theme, **spec.get("config", {})}

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    workspace = Path(args.workspace).resolve()
    key = content_hash(json.dumps(spec, sort_keys=True), out.suffix)
    cached = cache_dir(workspace) / "charts" / f"{key}{out.suffix.lower()}"
    cached.parent.mkdir(parents=True, exist_ok=True)

    if out.suffix.lower() not in (".svg", ".png"):
        fail("--out must end in .svg or .png.")
    if not cached.is_file():
        try:
            if out.suffix.lower() == ".png":
                cached.write_bytes(vlc.vegalite_to_png(spec, scale=2))
            else:
                cached.write_text(vlc.vegalite_to_svg(spec))
        except Exception as error:  # vl-convert raises plain ValueError with the Vega message
            fail(f"Vega-Lite could not render the chart: {error}")
    out.write_bytes(cached.read_bytes())
    emit({"path": str(out), "rows": len(spec["data"].get("values", []))})


if __name__ == "__main__":
    cli(main)
