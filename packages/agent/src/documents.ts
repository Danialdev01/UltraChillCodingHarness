import { fileURLToPath } from "node:url";
import type { Complete, UserContentPart } from "./completion.js";

/**
 * How a documentation turn reaches the document toolchain.
 *
 * The heavy lifting is the doc kit in `packages/agent/doc-kit`: Python
 * scripts over python-docx, pypdf, pdfplumber and LibreOffice, Typst
 * templates, and the skill files. The tools run those scripts through the
 * executor with argv arrays, so they run where every other tool runs.
 *
 * The one part that is a model call is looking: `look` sends page renders or
 * extracted figures to a vision model and returns what it saw as text.
 * `ToolResult` carries a string, and the coding model may not see images at
 * all, so the picture stops here and only the description travels on.
 *
 * Until the container executor lands, `kitDir` and `python` are host paths.
 * When it does, the kit has to be inside the image at the same path.
 */
export interface DocumentsBackends {
  /** Absolute path of the doc kit: `scripts/`, `templates/`, `skills/`. */
  kitDir: string;
  /** The interpreter that has the kit's packages. */
  python: string;
  /** A vision-capable OpenRouter model for `doc_inspect`. */
  visionModel: string;
}

export interface LookRequest {
  images: { mime: string; data: string; label: string }[];
  prompt: string;
  signal: AbortSignal;
}

export interface DocumentsProvider extends DocumentsBackends {
  look(request: LookRequest): Promise<string>;
}

export const DEFAULT_DOC_VISION_MODEL = "google/gemini-2.5-flash";

/** The kit beside this package's sources, which is where it ships. */
export function defaultKitDir(): string {
  return fileURLToPath(new URL("../doc-kit", import.meta.url));
}

/** Binds the vision call to this turn's key, as `bindResearch` does for search. */
export function bindDocuments(
  backends: DocumentsBackends,
  options: { apiKey: string; complete: Complete },
): DocumentsProvider {
  return {
    ...backends,
    async look(request) {
      const content: UserContentPart[] = [{ type: "text", text: request.prompt }];
      for (const image of request.images) {
        content.push({ type: "text", text: image.label });
        content.push({ type: "image_url", image_url: { url: `data:${image.mime};base64,${image.data}` } });
      }
      const completion = await options.complete(
        {
          apiKey: options.apiKey,
          model: backends.visionModel,
          messages: [
            { role: "system", content: VISION_SYSTEM },
            { role: "user", content },
          ],
          signal: request.signal,
        },
        () => {},
      );
      return completion.text.trim();
    },
  };
}

const VISION_SYSTEM =
  "You look at pages and figures from documents for an agent that cannot see them. " +
  "Be exact: read numbers, labels, axis titles and legends as printed, and say when " +
  "something is too small or blurred to read rather than guessing. Refer to pages by " +
  "the number in their label.";

/**
 * The fixed rubric a layout review uses. Fixed so two reviews of the same
 * pages ask the same thing, and so its issues read as patch instructions.
 */
export const LAYOUT_RUBRIC = `Review these rendered document pages for layout problems. Check each page for:
1. orphaned-heading: a heading in the last lines of a page with its text on the next.
2. overflow: a table, code block or figure cut off or past the margin.
3. unreadable-figure: diagram or chart text smaller than body text, or crammed.
4. large-gap: more than a third of a page empty, not at the end of the document.
5. spacing: uneven space around headings, figures or callouts.
6. broken-content: raw markup showing, a missing image, "??" or an unresolved reference.
7. near-empty-last-page: four lines or fewer on the last page.

Answer with one line per issue, nothing else:
page <n> | <check> | <high|medium|low> | <what is wrong, and where on the page>
If a page has no issues, write: page <n> | ok
Report only what you can see. Do not comment on wording or content.`;

/** The question asked of a figure when the caller gave none. */
export const DESCRIBE_FIGURES =
  "Describe each figure: what kind it is, what it shows, and every value, label and " +
  "legend entry you can read. For a chart, give the data as a table. For a diagram, " +
  "list the nodes and the connections between them.";

/**
 * The skills, with the descriptions the prompt lists. The bodies stay in
 * `doc-kit/skills/<name>/SKILL.md` and are read on demand by `doc_skill`.
 *
 * Duplicated here rather than read at startup so the prompt text is a
 * constant -- it sits in the cached prefix. A test holds the two in step.
 */
export const DOCUMENTATION_SKILLS = [
  {
    name: "doc-plan",
    description:
      "Pick the document type, audience and outline, and build a fact sheet with sources before writing any prose. Load first for any new document.",
  },
  {
    name: "doc-write",
    description:
      "House style for document prose - voice, headings, callouts, tables versus prose, length. Load before writing or rewriting document text.",
  },
  {
    name: "typst-render",
    description:
      "How doc_render turns Markdown into PDF through Pandoc and Typst, the front-matter fields, and what the common compile errors mean. Load when a render fails or before first use.",
  },
  {
    name: "diagram",
    description:
      "Which engine to use for which structural diagram (Mermaid, Graphviz, native Typst), the syntax, and readability limits. Load before drawing any flow, sequence, architecture or state diagram.",
  },
  {
    name: "chart",
    description:
      "Choosing a chart type and writing a themed Vega-Lite spec plus data table for doc_chart or a vega-lite fence. Load before putting any data chart in a document.",
  },
  {
    name: "layout-qa",
    description:
      "The review loop after rendering - deterministic doc_check, then a vision review of page images with doc_inspect against a fixed rubric, then patching the source. Load after the first successful render.",
  },
  {
    name: "citations",
    description:
      "Sourcing every claim - citing code as file:line, documents by page, and web pages by URL, plus BibTeX bibliographies. Load when a document makes factual claims.",
  },
  {
    name: "accessibility-export",
    description:
      "Making documents accessible - alt text, heading order, reading order, colour contrast, document metadata. Load when the document is for publication or the developer asks for accessibility.",
  },
  {
    name: "docx-edit",
    description:
      "Editing an existing .docx/.doc/.pdf without breaking its formatting - reading it first, anchoring edits, and what a PDF can and cannot take. Load before any doc_edit call.",
  },
] as const;

export type DocumentationSkill = (typeof DOCUMENTATION_SKILLS)[number]["name"];

export const DOCUMENTATION_SKILL_NAMES = DOCUMENTATION_SKILLS.map((skill) => skill.name) as [
  DocumentationSkill,
  ...DocumentationSkill[],
];

/** The document types the templates know, in the order the skill lists them. */
export const DOCUMENT_TYPES = ["report", "spec", "api-reference", "proposal", "runbook", "memo"] as const;

const SKILL_INDEX = DOCUMENTATION_SKILLS.map((skill) => `- ${skill.name}: ${skill.description}`).join("\n");

/**
 * What a documentation turn on the native loop is told on top of the
 * harness rules. Built once from constants, so it is the same bytes every
 * turn and stays in the cached prefix.
 */
export const DOCUMENTATION_RULES = `This is a documentation turn. The developer wants a document created, edited, or read -- mostly PDF, DOCX or DOC -- not code changes. It replaces the pandoc-through-bash instruction above: there is no shell here, and the document tools below do it properly.

The principle: you write content, the templates own layout. Never set margins, fonts, colours or spacing; pick a document type in the front matter and the house template does the rest.

Creating a document:
1. doc_skill("doc-plan"): choose the type (${DOCUMENT_TYPES.join(", ")}), audience, page budget, outline, and a fact sheet with a source for every claim -- read the code, the attachments, or the web first.
2. doc_skill("doc-write"), then write the source as Markdown with YAML front matter using write_file, e.g. docs/<name>.md. Diagrams are \`\`\`mermaid or \`\`\`dot fences and data charts \`\`\`vega-lite fences, each with {caption="..."}.
3. doc_render(source, "pdf"). On an error, fix the source from the message and render again; after 3 failures render with fallback: true and say what failed.
4. doc_check(pdf, source, page_budget). Fix every error.
5. doc_inspect(pdf, pages, null) for the visual review, then patch the source and re-render. At most 2 review rounds (doc_skill("layout-qa")).
6. Say where the file is, its page count, and anything left unresolved. Only produce .docx or .html when asked; doc_render does those too.

Editing a document: attach_upload it into the workspace if it came with the message, doc_read it, doc_skill("docx-edit"), then one doc_edit call with every change. Write to a new file unless asked to overwrite. A PDF's text cannot be edited in place; rebuild it from its source and say so.

Reading a document: doc_read for text, tables and structure; doc_inspect with a specific question for charts, diagrams, scans and anything visual -- doc_read cannot see images. Quote numbers exactly as the document gives them, with the page.

Skills -- load one with doc_skill before the step it covers:
${SKILL_INDEX}`;
