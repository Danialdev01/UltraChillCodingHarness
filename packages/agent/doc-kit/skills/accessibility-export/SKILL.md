---
name: accessibility-export
description: Making documents accessible - alt text, heading order, reading order, colour contrast, document metadata. Load when the document is for publication or the developer asks for accessibility.
---

# Accessible documents

The template already handles the document language, the title in the PDF metadata, bookmarks from headings, and text contrast. Your part:

- **Alt text on every figure.** A `caption=` is used as alt text. Add `alt="…"` when the caption doesn't describe what the image shows: "Bar chart: EU 120 ms, US 95 ms, AP 180 ms".
- **Headings in order.** Don't skip levels, and don't use bold text as a heading. doc_check warns when a level is skipped.
- **Tables have a header row**, and are used for data, never for layout.
- **Link text says where it goes.** Use "the Typst changelog", never "here".
- **Colour never carries meaning by itself** in charts or diagrams; label the series.
- **Set `lang:`** in the front matter when the document isn't in English.
- **Editing a .docx**: set the title with `doc_edit` `set_properties`, and give an inserted image a caption with `text`.

For a PDF/UA (tagged PDF) deliverable, say that it was asked for. The server's Typst version determines whether full tagging is available, so check with doc_check and report what the PDF includes.
