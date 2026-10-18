---
name: layout-qa
description: The review loop after rendering - deterministic doc_check, then a vision review of page images with doc_inspect against a fixed rubric, then patching the source. Load after the first successful render.
---

# Layout QA

```
render -> doc_check -> doc_inspect -> patch source -> render (at most 2 QA rounds)
```

## 1. doc_check (every render)

Pass `source` (the Markdown) and the page budget. Fix every `error` before you look at the pages. Fix `warning`s unless you have a reason not to, and state that reason.

## 2. doc_inspect (visual)

Call doc_inspect on the PDF with `question: null`. That uses this rubric, and it returns issues by page:

1. **Orphaned heading**: a heading in the last lines of a page, with its text on the next page.
2. **Overflow**: a table, code block or figure cut off or running past the margin.
3. **Unreadable figure**: diagram text smaller than the body text, or crammed.
4. **Large gap**: more than a third of a page empty, other than at the end of the document.
5. **Inconsistent spacing**: uneven space around headings, figures or callouts.
6. **Broken content**: raw Markup or Typst showing, missing images, a "??" reference.
7. **Near-empty last page**: 4 lines or fewer.

For a long document, inspect the pages where doc_check flagged problems, plus the first 3 pages and any page with a figure or table. Use `pages: "1-3,7"`.

## 3. Patch the source, not the output

| issue | patch |
|---|---|
| orphaned heading | usually fixed by the template; if it persists, shorten the preceding section |
| wide table | fewer columns, shorter cells, or split it into two tables |
| unreadable diagram | split it (15 nodes or fewer), or use `LR` → `TD` |
| large gap before a figure | move the figure reference earlier, or reduce the figure height |
| near-empty last page | cut a few lines |

Never add manual page breaks or spacing to fix a layout issue.

Stop after 2 rounds. Report anything that remains, by page.
