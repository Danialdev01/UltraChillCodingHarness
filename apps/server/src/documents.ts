import { join } from "node:path";
import { defaultKitDir, DOCUMENTATION_SKILLS, type DocumentsBackends } from "@ucch/agent";
import type { Config } from "./config.js";

/** The document pipeline's backends, from configuration. Decided once, at boot. */
export function documentsBackends(config: Config): DocumentsBackends {
  return {
    kitDir: config.DOC_KIT_DIR?.trim() || defaultKitDir(),
    python: config.DOC_PYTHON,
    visionModel: config.DOC_VISION_MODEL,
  };
}

/**
 * What a CLI provider is handed for a documentation turn: the person's
 * message, then the pipeline as commands for its own shell.
 *
 * The CLI has its own tools and none of the native loop's, so instead of
 * typed tools it gets the same scripts by path and the same skills to read.
 * The message comes first and untouched, as with a research brief, so the
 * CLI answers what was asked.
 */
export function documentationPrompt(text: string, docs: DocumentsBackends): string {
  const script = (name: string) => `${docs.python} ${join(docs.kitDir, "scripts", name)}`;
  const skills = DOCUMENTATION_SKILLS.map(
    (skill) => `- ${join(docs.kitDir, "skills", skill.name, "SKILL.md")} -- ${skill.description}`,
  ).join("\n");
  return (
    `${text.trim()}\n\n---\n\n` +
    "This is a documentation turn: the developer wants a document created, edited or read -- " +
    "mostly PDF, DOCX or DOC. Use the harness's document kit rather than writing your own " +
    "converters. You write content; its templates own layout, so never set margins, fonts or " +
    "colours -- pick a `type:` (report, spec, api-reference, proposal, runbook, memo) in the " +
    "Markdown front matter.\n\n" +
    "Each script prints JSON on success and a message to act on on stderr. Run them from the " +
    "project root:\n" +
    `- read text, tables, figures: \`${script("doc_read.py")} <file> [--pages 1-3]\`\n` +
    `- edit a .docx/.pdf keeping its styles: \`${script("doc_edit.py")} <file> --ops '<json>' [--out <file>]\` (ops: see docx-edit)\n` +
    `- render Markdown to PDF/DOCX/HTML: \`${script("doc_render.py")} <file.md> --format pdf --workspace .\` (mermaid, dot and vega-lite fences become figures)\n` +
    `- check a PDF: \`${script("doc_check.py")} <file.pdf> --source <file.md> [--budget N]\`\n` +
    `- page images to look at: \`pdftoppm -png -r 80 -f 1 -l 3 <file.pdf> .ucch/doc-cache/pages/p\`, then view the PNGs\n\n` +
    "For a new document: plan (type, audience, page budget, outline, sourced facts), write the " +
    "Markdown, render, check, look at the pages against the layout-qa rubric, patch the source " +
    "and re-render -- at most two review rounds -- then say where the file is. A PDF's text " +
    "cannot be edited in place; rebuild it from its source.\n\n" +
    `Read the skill for a step before doing it:\n${skills}`
  );
}
