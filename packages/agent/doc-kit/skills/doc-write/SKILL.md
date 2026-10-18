---
name: doc-write
description: House style for document prose - voice, headings, callouts, tables versus prose, length. Load before writing or rewriting document text.
---

# Writing the document

## Source format

Write Markdown with YAML front matter. That file is the source of truth; the PDF is built from it.

```markdown
---
title: Database Failover
subtitle: Promoting the replica when the primary is lost   # optional
author: [Platform Team]
date: 2026-10-14
version: "1.2"            # optional
status: Draft             # optional
abstract: One paragraph shown on the cover or under the title.   # optional
type: runbook             # report | spec | api-reference | proposal | runbook | memo
toc: true                 # optional, forces contents on; toc-off: true forces it off
---
```

Never write page setup, fonts, colours or raw Typst layout. If something looks wrong, the template is the thing to fix, so tell the developer.

## Voice

- Write plain, direct sentences in the active voice. Lead with the point, and give the reason after it.
- Say "we" for the team and "you" for the reader of a runbook.
- Use no marketing words ("seamless", "robust", "leverage") and no filler intros ("This document aims to…").
- Numbers carry units, and dates are written as `2026-10-14`.

## Structure

- Use at most three heading levels. Title headings by their content ("Replication lag above 30 s"), not by a generic label ("Problem").
- Keep paragraphs to six lines or fewer. Use a list only for items that are truly parallel; never use a list for a single item.
- Steps in a runbook are a numbered list, with one action per step and the exact command in a code block.

## Tables or prose

Use a table when the reader compares items along two or more attributes. Use prose when the content is an argument. A table has a header row, at most six columns, and short cells. If a table needs a caption, put the caption above it.

## Callouts

Use these sparingly, at most one per page:

```markdown
::: warning
Never promote while the old primary still accepts writes.
:::
```

The kinds are `note`, `tip`, `important`, `warning` and `caution`.

## Cross-references

Label a figure with `{#fig-name}` on its fence or image, and refer to it as `@fig-name`. Do the same for headings: `# Rollback {#sec-rollback}`.

## Length

Stay within the page budget from `doc-plan`. When a draft runs over, cut whole sections before you trim sentences.
