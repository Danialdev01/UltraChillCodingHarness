---
name: docx-edit
description: Editing an existing .docx/.doc/.pdf without breaking its formatting - reading it first, anchoring edits, and what a PDF can and cannot take. Load before any doc_edit call.
---

# Editing existing documents

## Always read first

1. If the file was attached to the conversation, place it in the workspace with attach_upload.
2. `doc_read(path)` gives you the text with paragraph markers `<!-- p12 -->`, tables numbered from 1, figures, headings, and (for a PDF) form fields.
3. Plan all the edits, then send them in **one** doc_edit call. The ops apply in order.

## Writing the output

By default an edit overwrites the file. For anything the developer didn't ask to overwrite, write a copy instead: `out: "report.edited.docx"`. A `.doc`, `.odt` or `.rtf` file is converted and saved as `.docx`.

## .docx operations

Fields that an op doesn't use are null.

| op | fields | notes |
|---|---|---|
| `replace_text` | find, text, all | works across formatting runs and keeps the formatting at the start of the match; also searches tables, headers and footers |
| `insert_paragraph` | anchor, text, style, position | style is a style name that already exists in the document; null means Normal |
| `insert_heading` | anchor, text, level, position | uses the document's own Heading N style |
| `delete_paragraph` | anchor | |
| `insert_table` | anchor, rows, style, position | rows[0] is the header |
| `set_cell` | table, row, col, text | numbered from 1 |
| `add_row` | table, rows | copies the last row's formatting; rows[0] is the new row |
| `insert_image` | anchor, image, width_cm, text, position | text becomes the caption |
| `replace_image` | index, image | index is numbered from 1, in body order |
| `set_properties` | title, author, subject | |

**anchor** is either `p:<index>` from doc_read, or text that the paragraph contains (the first match wins). Indices shift after an insert or delete in the same call, so prefer text anchors when you send several ops.

## PDF operations

`fill_form` (fields: [{name, value}]), `merge` (files), `extract_pages` / `delete_pages` (pages "1-3,5"), `rotate` (pages, degrees), `set_properties`.

**A PDF's text can't be edited in place.** To change content:
- if the PDF was built here, edit its Markdown source and call doc_render;
- if a .docx came with it, edit that and render it to PDF;
- otherwise, doc_read it, rebuild it as Markdown, and render. Tell the developer that the layout will follow the house template, not the original's.

## Reading charts and figures

doc_read lists figures but can't see them. Use `doc_inspect(path, question)` with a specific question: "What does the chart on page 3 show? Give the values." For figures embedded in a .docx, pass `figures: true`.
