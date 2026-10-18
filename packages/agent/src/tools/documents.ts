import { createHash } from "node:crypto";
import { readFile as readHostFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { z } from "zod/v4";
import {
  DESCRIBE_FIGURES,
  DOCUMENTATION_SKILL_NAMES,
  LAYOUT_RUBRIC,
  type DocumentsProvider,
} from "../documents.js";
import { ExecInterruptedError } from "../executor.js";
import { defineTool, type ToolContext, type ToolResult } from "../tool.js";
import { clamp, describe } from "./format.js";

/**
 * The document pipeline, as typed tools over the doc kit's scripts.
 *
 * Offered only on the `documentation` preset, which has no shell: the model
 * picks an action and its inputs, and the scripts own how it is done. Each
 * script prints one JSON object on success and a message on stderr on
 * failure, and the failure text is written for the model to act on --
 * Typst's and Mermaid's own errors name the line to fix.
 */

/** Page renders as base64 are large; this is the cap for one call's stdout. */
const MAX_SCRIPT_OUTPUT = 32 * 1024 * 1024;

/** LibreOffice on a cold start and a Chromium launch for Mermaid are both slow. */
const SCRIPT_TIMEOUT_MS = 5 * 60_000;

/** A render failing this many times on one file is a loop, not a fix. */
const MAX_RENDER_ATTEMPTS = 3;

/** Text returned by doc_read before the model is told to page. */
const MAX_READ_BYTES = 60_000;

/** Pages or figures sent to the vision model in one call. */
const MAX_INSPECT_IMAGES = 8;

type ScriptOutcome = { ok: true; value: Record<string, unknown> } | { ok: false; error: ToolResult };

function configured(ctx: ToolContext): { value: DocumentsProvider } | { error: ToolResult } {
  if (ctx.depth > 0) {
    return {
      error: { content: "Document tools cannot be called from inside another tool call.", isError: true },
    };
  }
  if (!ctx.documents) {
    return {
      error: {
        content: "Document tools are not available on this turn: it was not started in documentation mode.",
        isError: true,
      },
    };
  }
  return { value: ctx.documents };
}

/** A workspace path made absolute, or the reason it cannot be. */
function inWorkspace(ctx: ToolContext, path: string): { value: string } | { error: ToolResult } {
  try {
    return { value: ctx.executor.resolve(path) };
  } catch (error) {
    return { error: { content: `${path}: ${describe(error)}`, isError: true } };
  }
}

/** A script's absolute output path, back as the workspace path the model and the file tree use. */
function workspacePath(ctx: ToolContext, absolute: string): string {
  return relative(ctx.executor.root(), absolute);
}

async function script(
  ctx: ToolContext,
  docs: DocumentsProvider,
  name: string,
  args: string[],
): Promise<ScriptOutcome> {
  const argv = [docs.python, join(docs.kitDir, "scripts", name), ...args];
  try {
    const result = await ctx.executor.exec(argv, {
      timeoutMs: SCRIPT_TIMEOUT_MS,
      signal: ctx.signal,
      maxOutputBytes: MAX_SCRIPT_OUTPUT,
    });
    if (result.exitCode !== 0) {
      const message = result.stderr.trim() || result.stdout.trim() || `exited with ${result.exitCode}`;
      return { ok: false, error: { content: clamp(message), isError: true } };
    }
    if (result.truncated) {
      return {
        ok: false,
        error: { content: "The output was too large. Ask for fewer pages at a time.", isError: true },
      };
    }
    try {
      return { ok: true, value: JSON.parse(result.stdout) as Record<string, unknown> };
    } catch {
      return { ok: false, error: { content: `Unexpected output: ${clamp(result.stdout, 2_000)}`, isError: true } };
    }
  } catch (error) {
    if (error instanceof ExecInterruptedError) {
      return { ok: false, error: { content: error.message, isError: true } };
    }
    return { ok: false, error: { content: `Could not run ${name}: ${describe(error)}`, isError: true } };
  }
}

/** Writes text into the doc cache by content hash, so a script can be handed a file. */
async function stage(ctx: ToolContext, content: string, extension: string): Promise<string> {
  const hash = createHash("sha256").update(content).digest("hex").slice(0, 16);
  const path = `.ucch/doc-cache/sources/${hash}.${extension}`;
  await ctx.executor.writeFile(path, content);
  return path;
}

async function changed(ctx: ToolContext, path: string, existed: boolean): Promise<void> {
  await ctx.emit({ type: "file.changed", projectId: ctx.projectId, path, change: existed ? "modified" : "added" });
}

async function exists(ctx: ToolContext, path: string): Promise<boolean> {
  try {
    await ctx.executor.readFile(path, { maxBytes: 1 });
    return true;
  } catch {
    return false;
  }
}

function list(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => (typeof item === "string" ? item : JSON.stringify(item))) : [];
}

// -- doc_read ----------------------------------------------------------------

export const docRead = defineTool({
  name: "doc_read",
  description:
    "Read a document -- .pdf, .docx, .doc, .odt, .rtf -- as text: headings, paragraphs (marked " +
    "<!-- p12 --> for doc_edit anchors), tables as Markdown, the figures it contains, PDF form " +
    "fields and outline. It cannot see what a figure shows; use doc_inspect for that.",
  permission: "read",
  inputSchema: z.strictObject({
    path: z.string().describe("Path relative to the workspace root"),
    pages: z
      .string()
      .nullable()
      .describe('PDF pages to read, e.g. "1-3,7". Null reads every page.'),
  }),
  async run(input, ctx): Promise<ToolResult> {
    const docs = configured(ctx);
    if ("error" in docs) return docs.error;
    const path = inWorkspace(ctx, input.path);
    if ("error" in path) return path.error;

    const outcome = await script(ctx, docs.value, "doc_read.py", [
      path.value,
      ...(input.pages ? ["--pages", input.pages] : []),
    ]);
    if (!outcome.ok) return outcome.error;

    const { text, ...facts } = outcome.value;
    const body = typeof text === "string" ? text : "";
    const shown = clamp(body, MAX_READ_BYTES);
    const more = shown.length < body.length ? "\n\n(truncated: read a page range)" : "";
    return {
      content: `${JSON.stringify(facts, null, 1)}\n\n${shown}${more}`,
      display: { path: input.path },
    };
  },
});

// -- doc_inspect -------------------------------------------------------------

export const docInspect = defineTool({
  name: "doc_inspect",
  description:
    "Look at a document with a vision model. Renders pages (or, with figures: true, extracts the " +
    "embedded images) and returns what they show. With question null it reviews layout against " +
    "the fixed QA rubric and returns issues by page. With a question it answers it -- use this to " +
    "read charts, diagrams, scanned pages and anything doc_read cannot.",
  permission: "read",
  inputSchema: z.strictObject({
    path: z.string().describe("Path relative to the workspace root"),
    pages: z
      .string()
      .nullable()
      .describe(`Pages, e.g. "1-3,7". Null starts at page 1; at most ${MAX_INSPECT_IMAGES} are sent.`),
    question: z
      .string()
      .nullable()
      .describe("What to find out, e.g. 'What values does the chart on page 3 show?'. Null runs the layout review."),
    figures: z
      .boolean()
      .nullable()
      .describe("True looks at the embedded images themselves rather than whole pages. Null is false."),
  }),
  timeoutMs: SCRIPT_TIMEOUT_MS + 3 * 60_000,
  async run(input, ctx): Promise<ToolResult> {
    const docs = configured(ctx);
    if ("error" in docs) return docs.error;
    const path = inWorkspace(ctx, input.path);
    if ("error" in path) return path.error;

    const outcome = await script(ctx, docs.value, "doc_images.py", [
      path.value,
      ...(input.pages ? ["--pages", input.pages] : []),
      ...(input.figures ? ["--figures"] : []),
      // Layout is judged at thumbnail size; reading values needs more pixels.
      "--dpi",
      input.question ? "110" : "80",
      "--max",
      String(MAX_INSPECT_IMAGES),
    ]);
    if (!outcome.ok) return outcome.error;

    const images = (outcome.value.images as { page?: number; name?: string; mime: string; data: string }[]) ?? [];
    if (images.length === 0) {
      return {
        content: input.figures
          ? `${input.path} has no embedded raster images on those pages. Charts drawn as vectors are part of the page: inspect the page instead.`
          : `Nothing to look at on those pages of ${input.path}.`,
        isError: true,
      };
    }

    const prompt = input.question
      ? `${input.question}\n\nIf the answer is not visible in these images, say so.`
      : input.figures
        ? DESCRIBE_FIGURES
        : LAYOUT_RUBRIC;

    let seen: string;
    try {
      seen = await docs.value.look({
        images: images.map((image) => ({
          mime: image.mime,
          data: image.data,
          label: image.page ? `Page ${image.page}${image.name ? `, ${image.name}` : ""}:` : `${image.name ?? "Figure"}:`,
        })),
        prompt,
        signal: ctx.signal,
      });
    } catch (error) {
      return { content: `The vision model failed: ${describe(error)}`, isError: true };
    }

    const looked = images.map((image) => (image.page ? `p${image.page}` : (image.name ?? "figure"))).join(", ");
    const total = typeof outcome.value.pages === "number" ? ` of ${outcome.value.pages} pages` : "";
    return {
      content: clamp(`Looked at ${looked}${total}.\n\n${seen || "(the vision model returned nothing)"}`),
      display: { path: input.path, title: input.question ?? "layout review" },
    };
  },
});

// -- doc_edit ----------------------------------------------------------------

const EditOp = z.strictObject({
  op: z
    .enum([
      "replace_text",
      "insert_paragraph",
      "insert_heading",
      "delete_paragraph",
      "insert_table",
      "set_cell",
      "add_row",
      "insert_image",
      "replace_image",
      "set_properties",
      "fill_form",
      "merge",
      "extract_pages",
      "delete_pages",
      "rotate",
    ])
    .describe("The operation. See the docx-edit skill for which fields each one uses."),
  anchor: z.string().nullable().describe('"p:<index>" from doc_read, or text the paragraph contains'),
  position: z.enum(["before", "after"]).nullable().describe("Where to insert relative to the anchor. Null is after."),
  find: z.string().nullable().describe("replace_text: the exact text to find"),
  text: z.string().nullable().describe("New text; for insert_image, the caption"),
  all: z.boolean().nullable().describe("replace_text: every occurrence rather than the first"),
  style: z.string().nullable().describe("A style name the document already has"),
  level: z.number().int().min(1).max(6).nullable().describe("insert_heading: heading level"),
  rows: z.array(z.array(z.string())).nullable().describe("insert_table: rows, header first; add_row: [[cells]]"),
  table: z.number().int().min(1).nullable().describe("set_cell, add_row: table number from doc_read"),
  row: z.number().int().min(1).nullable().describe("set_cell: row, from 1"),
  col: z.number().int().min(1).nullable().describe("set_cell: column, from 1"),
  index: z.number().int().min(1).nullable().describe("replace_image: image number, from 1"),
  image: z.string().nullable().describe("insert_image, replace_image: image path in the workspace"),
  width_cm: z.number().positive().nullable().describe("insert_image: width in cm. Null is 15."),
  fields: z
    .array(z.strictObject({ name: z.string(), value: z.string() }))
    .nullable()
    .describe("fill_form: field names from doc_read and their values"),
  files: z.array(z.string()).nullable().describe("merge: PDFs to append, in order"),
  pages: z.string().nullable().describe('extract_pages, delete_pages, rotate: e.g. "1-3,5"'),
  degrees: z.number().int().nullable().describe("rotate: 90, 180 or 270"),
  title: z.string().nullable().describe("set_properties"),
  author: z.string().nullable().describe("set_properties"),
  subject: z.string().nullable().describe("set_properties"),
});

export const docEdit = defineTool({
  name: "doc_edit",
  description:
    "Edit an existing .docx/.doc/.odt/.rtf in place, keeping its own styles -- replace text across " +
    "formatting, insert or delete paragraphs, headings and tables, set cells, add rows, insert or " +
    "replace images, set properties -- or a PDF's forms, pages and metadata. Read the document " +
    "with doc_read first and send every edit in one call; ops apply in order.",
  permission: "write",
  inputSchema: z.strictObject({
    path: z.string().describe("Path relative to the workspace root"),
    operations: z.array(EditOp).min(1).max(100),
    out: z
      .string()
      .nullable()
      .describe("Where to write the result. Null overwrites the file (a .doc is saved as .docx)."),
  }),
  timeoutMs: SCRIPT_TIMEOUT_MS + 30_000,
  async run(input, ctx): Promise<ToolResult> {
    const docs = configured(ctx);
    if ("error" in docs) return docs.error;
    const path = inWorkspace(ctx, input.path);
    if ("error" in path) return path.error;
    const out = input.out ? inWorkspace(ctx, input.out) : null;
    if (out && "error" in out) return out.error;

    // Nulls are dropped so the script reads "field not given" one way.
    const ops = input.operations.map((op) =>
      Object.fromEntries(Object.entries(op).filter(([, value]) => value !== null)),
    );
    const before = out ? await exists(ctx, input.out!) : true;
    const outcome = await script(ctx, docs.value, "doc_edit.py", [
      path.value,
      "--ops",
      JSON.stringify(ops),
      "--workspace",
      ctx.executor.root(),
      ...(out ? ["--out", out.value] : []),
    ]);
    if (!outcome.ok) return outcome.error;

    const written = workspacePath(ctx, String(outcome.value.path));
    await changed(ctx, written, written === input.path ? true : before);
    return {
      content: `Wrote ${written}:\n- ${list(outcome.value.applied).join("\n- ")}`,
      display: { path: written },
    };
  },
});

// -- doc_render --------------------------------------------------------------

/** Failed renders per turn and source, for the repair budget. */
const renderFailures = new Map<string, number>();

export const docRender = defineTool({
  name: "doc_render",
  description:
    "Render a document. From Markdown with YAML front matter (type: report|spec|api-reference|" +
    "proposal|runbook|memo): pdf through Pandoc and Typst with the house template, or docx, or " +
    "html. mermaid, dot and vega-lite fences become figures. From .docx/.doc/.odt: pdf through " +
    "LibreOffice. Returns pages and warnings; run doc_check next.",
  permission: "write",
  inputSchema: z.strictObject({
    source: z.string().describe("The Markdown or Office file, relative to the workspace root"),
    format: z.enum(["pdf", "docx", "html"]).describe("What to produce"),
    out: z.string().nullable().describe("Output path. Null puts it beside the source with the new extension."),
    fallback: z
      .boolean()
      .nullable()
      .describe("True leaves a figure that will not render as a code block instead of failing. Null is false."),
  }),
  timeoutMs: SCRIPT_TIMEOUT_MS + 30_000,
  async run(input, ctx): Promise<ToolResult> {
    const docs = configured(ctx);
    if ("error" in docs) return docs.error;
    const source = inWorkspace(ctx, input.source);
    if ("error" in source) return source.error;
    const out = input.out ? inWorkspace(ctx, input.out) : null;
    if (out && "error" in out) return out.error;

    const key = `${ctx.turnId}:${input.source}`;
    const outcome = await script(ctx, docs.value, "doc_render.py", [
      source.value,
      "--format",
      input.format,
      "--workspace",
      ctx.executor.root(),
      ...(out ? ["--out", out.value] : []),
      ...(input.fallback ? ["--fallback"] : []),
    ]);
    if (!outcome.ok) {
      const failures = (renderFailures.get(key) ?? 0) + 1;
      renderFailures.set(key, failures);
      const advice =
        failures >= MAX_RENDER_ATTEMPTS
          ? `\n\nThis is failure ${failures} on ${input.source}. Stop repairing: render with fallback: true so the document comes out with the broken figures as code blocks, and tell the developer what failed.`
          : `\n\nAttempt ${failures} of ${MAX_RENDER_ATTEMPTS}. Fix the source and render again.`;
      return { content: `${outcome.error.content}${advice}`, isError: true };
    }
    renderFailures.delete(key);

    const written = workspacePath(ctx, String(outcome.value.path));
    await changed(ctx, written, true);
    const warnings = list(outcome.value.warnings);
    const figureErrors = list(outcome.value.figure_errors);
    const lines = [
      `Rendered ${written}${typeof outcome.value.pages === "number" ? ` (${outcome.value.pages} pages)` : ""}` +
        `${outcome.value.type ? `, type ${String(outcome.value.type)}` : ""}.`,
      ...(warnings.length ? ["Warnings:", ...warnings.map((w) => `- ${w}`)] : []),
      ...(figureErrors.length ? ["Figures left as code blocks:", ...figureErrors.map((e) => `- ${e}`)] : []),
    ];
    return { content: clamp(lines.join("\n")), display: { path: written } };
  },
});

// -- doc_diagram -------------------------------------------------------------

export const docDiagram = defineTool({
  name: "doc_diagram",
  description:
    "Render one Mermaid or Graphviz diagram to an SVG or PNG file, e.g. to check it before it goes " +
    "in a document, or to insert into a .docx with doc_edit. In Markdown, prefer a fenced block, " +
    "which doc_render draws itself.",
  permission: "write",
  inputSchema: z.strictObject({
    lang: z.enum(["mermaid", "dot"]).describe("The diagram language"),
    source: z.string().describe("The diagram source"),
    out: z.string().describe("Output path ending in .svg or .png, relative to the workspace root"),
  }),
  timeoutMs: SCRIPT_TIMEOUT_MS,
  async run(input, ctx): Promise<ToolResult> {
    const docs = configured(ctx);
    if ("error" in docs) return docs.error;
    const out = inWorkspace(ctx, input.out);
    if ("error" in out) return out.error;

    const staged = await stage(ctx, input.source, input.lang === "dot" ? "dot" : "mmd");
    const before = await exists(ctx, input.out);
    const outcome = await script(ctx, docs.value, "doc_diagram.py", [
      input.lang,
      ctx.executor.resolve(staged),
      "--out",
      out.value,
      "--workspace",
      ctx.executor.root(),
    ]);
    if (!outcome.ok) return outcome.error;

    await changed(ctx, input.out, before);
    const warnings = list(outcome.value.warnings);
    return {
      content: `Rendered ${input.out}.${warnings.length ? `\nWarnings:\n- ${warnings.join("\n- ")}` : ""}`,
      display: { path: input.out },
    };
  },
});

// -- doc_chart ---------------------------------------------------------------

export const docChart = defineTool({
  name: "doc_chart",
  description:
    "Render a data chart from a Vega-Lite spec to SVG or PNG, with the house theme applied. Write " +
    "the spec and the data, never drawing code. In Markdown, prefer a vega-lite fenced block.",
  permission: "write",
  inputSchema: z.strictObject({
    spec: z.string().describe("The Vega-Lite spec as JSON. Omit colours and fonts: the theme sets them."),
    data: z
      .string()
      .nullable()
      .describe("A CSV or JSON table in the workspace to use as the data. Null uses data.values in the spec."),
    out: z.string().describe("Output path ending in .svg or .png, relative to the workspace root"),
  }),
  async run(input, ctx): Promise<ToolResult> {
    const docs = configured(ctx);
    if ("error" in docs) return docs.error;
    const out = inWorkspace(ctx, input.out);
    if ("error" in out) return out.error;
    const data = input.data ? inWorkspace(ctx, input.data) : null;
    if (data && "error" in data) return data.error;

    const staged = await stage(ctx, input.spec, "vl.json");
    const before = await exists(ctx, input.out);
    const outcome = await script(ctx, docs.value, "doc_chart.py", [
      ctx.executor.resolve(staged),
      "--out",
      out.value,
      "--workspace",
      ctx.executor.root(),
      ...(data ? ["--data", data.value] : []),
    ]);
    if (!outcome.ok) return outcome.error;

    await changed(ctx, input.out, before);
    return { content: `Rendered ${input.out} (${String(outcome.value.rows)} rows).`, display: { path: input.out } };
  },
});

// -- doc_check ---------------------------------------------------------------

export const docCheck = defineTool({
  name: "doc_check",
  description:
    "Run the deterministic checks on a rendered PDF: page budget, embedded fonts, broken links, " +
    "blank pages, text or images off the page, images wider than the text, a near-empty last " +
    "page, and -- given the Markdown source -- captions, heading order and the outline. Run after " +
    "every render, before doc_inspect.",
  permission: "read",
  inputSchema: z.strictObject({
    pdf: z.string().describe("The PDF, relative to the workspace root"),
    source: z.string().nullable().describe("The Markdown it was rendered from. Null skips the source checks."),
    page_budget: z.number().int().min(1).nullable().describe("The most pages it should have. Null skips the check."),
  }),
  async run(input, ctx): Promise<ToolResult> {
    const docs = configured(ctx);
    if ("error" in docs) return docs.error;
    const pdf = inWorkspace(ctx, input.pdf);
    if ("error" in pdf) return pdf.error;
    const source = input.source ? inWorkspace(ctx, input.source) : null;
    if (source && "error" in source) return source.error;

    const outcome = await script(ctx, docs.value, "doc_check.py", [
      pdf.value,
      ...(source ? ["--source", source.value] : []),
      ...(input.page_budget ? ["--budget", String(input.page_budget)] : []),
    ]);
    if (!outcome.ok) return outcome.error;

    const result = outcome.value as {
      pages: number;
      passed: boolean;
      errors: number;
      warnings: number;
      issues: { check: string; severity: string; page: number | null; detail: string }[];
    };
    const head = `${input.pdf}: ${result.pages} pages, ${result.passed ? "passed" : "failed"} (${result.errors} errors, ${result.warnings} warnings).`;
    const issues = result.issues.map(
      (i) => `- [${i.severity}] ${i.check}${i.page ? ` p${i.page}` : ""}: ${i.detail}`,
    );
    return { content: [head, ...issues].join("\n"), display: { path: input.pdf } };
  },
});

// -- doc_skill ---------------------------------------------------------------

export const docSkill = defineTool({
  name: "doc_skill",
  description:
    "Load one of the documentation skills listed in the instructions: the full guidance for " +
    "that step. Load a skill before the step it covers.",
  permission: "read",
  inputSchema: z.strictObject({
    name: z.enum(DOCUMENTATION_SKILL_NAMES).describe("The skill to load"),
  }),
  async run(input, ctx): Promise<ToolResult> {
    const docs = configured(ctx);
    if ("error" in docs) return docs.error;
    try {
      // The kit is the harness's own, not the project's, so this is read
      // from the server's disk rather than through the executor.
      const text = await readHostFile(join(docs.value.kitDir, "skills", input.name, "SKILL.md"), "utf8");
      return { content: text.replace(/^---\n[\s\S]*?\n---\n/, "").trim(), display: { title: input.name } };
    } catch (error) {
      return { content: `Could not load the ${input.name} skill: ${describe(error)}`, isError: true };
    }
  },
});
