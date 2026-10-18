---
name: citations
description: Sourcing every claim - citing code as file:line, documents by page, and web pages by URL, plus BibTeX bibliographies. Load when a document makes factual claims.
---

# Citations

A claim that has no source doesn't go in the document. Either cut it, or write it as an open question ("Not yet measured: …").

## Inline sources (the default)

- **Code**: `apps/server/src/agent.ts:383`, read in this turn. Quote the behaviour, not your memory of it.
- **An attached document**: "(Q3 report, p. 4)". doc_read gives you the page numbers.
- **The web**: a Markdown link on the claim, `[Typst 0.13 release notes](https://…)`, fetched in this turn.

## Bibliography (reports and specs with 5 or more external sources)

Write `refs.bib` next to the Markdown, and add `bibliography: refs.bib` to the front matter. Cite with `[@key]` or `@key`. The template prints the list at the end.

```bibtex
@online{typst2025,
  title = {Typst 0.13 release notes},
  url = {https://typst.app/docs/changelog/},
  urldate = {2026-10-14}
}
```

## Numbers

Give every number its source and date: "p95 is 120 ms (Grafana, 2026-10-01 → 10-07)". If two sources disagree, give both and say which one you used.
