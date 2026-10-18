---
name: typst-render
description: How doc_render turns Markdown into PDF through Pandoc and Typst, the front-matter fields, and what the common compile errors mean. Load when a render fails or before first use.
---

# Rendering

`doc_render(source, format)` with `format`:
- `pdf`: Markdown → Pandoc → Typst with the house template → PDF. This is the default for anything people will read.
- `docx`: Markdown → Pandoc with the house reference.docx. Use it when the developer wants an editable Word file.
- `html`: a single standalone file with its resources embedded.

A `.docx`/`.doc`/`.odt` source renders to `pdf` only, through LibreOffice. LibreOffice keeps that document's own layout.

Diagram and chart fences are rendered to images before Pandoc runs (see the `diagram` and `chart` skills). They are cached, so a re-render is cheap.

## Native Typst graphics

When a figure needs to match the document exactly, use a raw Typst block. It inherits the document's fonts and colours:

````markdown
```{=typst}
#import "@preview/fletcher:0.5.5" as fletcher: diagram, node, edge
#figure(diagram(node((0,0), [Client]), edge("-|>"), node((1,0), [API])), caption: [Request path])
```
````

Use only the package versions the server has cached: `@preview/fletcher:0.5.5` and `@preview/cetz:0.3.2`. If a package isn't cached, the compile fails with a download error. In that case, use a Mermaid or Graphviz fence instead.

## Reading errors

The tool returns Typst's own error. It points at a line of the generated `.<name>.ucch.typ` file, which sits next to the source. read_file that line to see which Markdown produced it.

| error | cause | fix |
|---|---|---|
| `unknown variable` / `expected expression` near a `#` | a `#` at the start of a word or line in prose | escape it as `\#` |
| `file not found` for an image | the path is relative to the wrong place | image paths are relative to the Markdown file |
| `failed to download package` | the package isn't cached | use a Mermaid or Graphviz fence |
| `unclosed delimiter` | a raw Typst block isn't balanced | fix the brackets in the block |
| `pandoc could not read the Markdown` | broken front matter | check the YAML; quote values that contain `:` |

After 3 failed attempts on the same file, render with the figures left as code blocks and tell the developer what failed.
