---
name: doc-plan
description: Pick the document type, audience and outline, and build a fact sheet with sources before writing any prose. Load first for any new document.
---

# Planning a document

Do this before writing a line of the document. A plan that is wrong is cheap; a 12-page draft built on it is not.

## 1. Type

Pick exactly one. It sets the template: cover, contents, numbering, accent colour. You never set those yourself.

| type | for | cover | contents | numbering |
|---|---|---|---|---|
| `report` | findings, analysis, status, post-mortems | yes | yes | 1.1 |
| `spec` | designs, RFCs, requirements | yes | yes | 1.1.1 |
| `api-reference` | endpoints, functions, config keys | no | yes | none |
| `proposal` | pitches, plans that ask for a decision | yes | no | none |
| `runbook` | step-by-step operations, incident procedures | no | yes | 1. |
| `memo` | one to three pages, a single point | no | no | none |

If two fit, pick the shorter one.

## 2. Audience and budget

Write one line for each:
- **Reader**: who they are and what they already know.
- **Decision or task**: what they should be able to decide or do after reading.
- **Page budget**: memo 1–3, proposal 3–8, runbook 2–10, report 5–20, spec 5–30. Pass it to `doc_check`.

## 3. Outline

Headings only, at most three levels, and no level-3 heading without a level-2 heading above it. Under each heading, write one line on what that section proves or explains. If you can't write that line, cut the section.

## 4. Fact sheet

List every claim the document will make that isn't common knowledge: numbers, dates, versions, names, behaviours of code. Give each one a source:
- code: `path/to/file.ts:42`, read with read_file in this turn;
- a document the user attached: doc_read with the page or paragraph;
- the web: the URL, fetched in this turn.

A claim with no source is cut, or written as an open question. See the `citations` skill.

## 5. Figures

Decide now which ideas need a picture, and which kind (see the `diagram` and `chart` skills). One figure per idea that a figure explains better than prose. A figure that would only decorate the page doesn't go in.
