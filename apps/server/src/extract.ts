import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync, inflateRawSync } from "node:zlib";
import { estimateTokens as estimateTokenCount } from "@ucch/protocol/plain";

/**
 * Turns an attachment into text a model can read.
 *
 * Every harness can read text, while only some can read a picture and none
 * reads a `.docx`. So documents are converted once, when they are staged, and
 * the text goes everywhere the file does: inlined into the message up to the
 * model's budget, and written beside the original in the workspace's
 * `.attachments/` for the rest (`UploadStore.materialize`).
 *
 * The Office and OpenDocument formats are ZIP files of XML, read here
 * directly: no subprocess, no dependency, and the same result in dev and in
 * the image. PDF goes through poppler's `pdftotext`, which the image ships.
 * The legacy binary formats go through LibreOffice when it is installed.
 * A PDF page with no text layer is read by OCR (`tesseract`) when that is
 * installed, so a scanned contract reaches a model that cannot see as well
 * as one that can. An archive is listed, and the files in it read as if each
 * had been attached on its own.
 *
 * Everything fails soft. A file this cannot read gets `null` or a warning,
 * and the attachment is still offered by id and by path.
 */

export type ExtractKind =
  | "text"
  | "pdf"
  | "document"
  | "spreadsheet"
  | "presentation"
  | "html"
  | "ebook"
  | "archive";

export interface Extraction {
  kind: ExtractKind;
  /** Markdown-ish plain text. */
  text: string;
  /** A short description, e.g. "PDF, 12 pages" or "Spreadsheet, 3 sheets". */
  summary: string;
  /** True when the text was cut at `maxChars`. */
  truncated: boolean;
  /** Something the model should know about how far to trust the text. */
  warning?: string;
  /** A PDF with no text layer: page renders a vision model can look at instead. */
  pageImages?: Buffer[];
}

export interface ExtractOptions {
  /** The most text kept. Past this the text is cut and `truncated` is set. */
  maxChars?: number;
  /** For a scanned PDF, how many pages to render as pictures. 0 turns it off. */
  maxPageImages?: number;
  /** How long one external converter may run. */
  timeoutMs?: number;
  /** The most PDF pages without a text layer to OCR. 0 turns OCR off. */
  maxOcrPages?: number;
}

const DEFAULT_MAX_CHARS = 4_000_000;
/** The most one ZIP entry may inflate to: a zip bomb stops here. */
const MAX_ENTRY_BYTES = 64 * 1024 * 1024;

/** A rough token count for a text, by the harness's one estimate. */
export function estimateTokens(text: string): number {
  return estimateTokenCount(text.length);
}

/** The extension in lowercase, without the dot. */
function extOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

const TEXT_EXTS = new Set([
  "c", "cc", "cfg", "conf", "cpp", "cs", "css", "csv", "diff", "dockerfile", "env", "go", "gql",
  "graphql", "h", "hpp", "ini", "java", "js", "json", "jsonc", "jsonl", "jsx", "kt", "less", "lock",
  "log", "lua", "md", "mdx", "mjs", "cjs", "patch", "php", "pl", "properties", "py", "rb", "rs",
  "scss", "sh", "sql", "svelte", "swift", "toml", "ts", "tsv", "tsx", "txt", "vue", "xml", "yaml",
  "yml", "zsh", "bash", "fish", "r", "scala", "dart", "ex", "exs", "erl", "hs", "ml", "tf", "hcl",
  "gradle", "bat", "ps1", "svg", "tex", "bib", "srt", "vtt", "ics", "vcf", "ipynb", "rst", "adoc",
  "org", "nix", "zig", "proto", "prisma", "graphqls", "blade", "twig", "erb", "liquid", "astro",
]);

/**
 * Text for one attachment, or null when it is not something to read as text
 * (an image, an archive, a video) or could not be read at all.
 */
export async function extractDocument(
  name: string,
  contentType: string,
  bytes: Buffer,
  options: ExtractOptions = {},
): Promise<Extraction | null> {
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
  const ext = extOf(name);
  const type = contentType.split(";")[0]!.trim().toLowerCase();

  let result: Omit<Extraction, "truncated"> | null = null;
  try {
    result = await dispatch(ext, type, bytes, options, 0);
  } catch (error) {
    // A malformed file is an ordinary upload: say so rather than fail it.
    return {
      kind: "text",
      text: "",
      summary: "Unreadable file",
      truncated: false,
      warning: `Could not read the file's text: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (!result) return null;

  const text = tidy(result.text);
  if (text.length <= maxChars) return { ...result, text, truncated: false };
  return { ...result, text: text.slice(0, maxChars), truncated: true };
}

async function dispatch(
  ext: string,
  type: string,
  bytes: Buffer,
  options: ExtractOptions,
  depth: number,
): Promise<Omit<Extraction, "truncated"> | null> {
  if (ext === "pdf" || type === "application/pdf") return pdf(bytes, options);
  if (ext === "docx" || ext === "docm" || ext === "dotx" || type.includes("wordprocessingml")) return docx(bytes);
  if (ext === "xlsx" || ext === "xlsm" || ext === "xltx" || type.includes("spreadsheetml")) return xlsx(bytes);
  if (ext === "pptx" || ext === "pptm" || ext === "potx" || type.includes("presentationml")) return pptx(bytes);
  if (ext === "odt" || ext === "ott" || type === "application/vnd.oasis.opendocument.text") return odf(bytes, "document");
  if (ext === "ods" || type === "application/vnd.oasis.opendocument.spreadsheet") return odf(bytes, "spreadsheet");
  if (ext === "odp" || type === "application/vnd.oasis.opendocument.presentation") return odf(bytes, "presentation");
  if (ext === "epub" || type === "application/epub+zip") return epub(bytes);
  if (ext === "rtf" || type === "application/rtf" || type === "text/rtf") {
    return { kind: "document", text: rtfToText(bytes.toString("latin1")), summary: "Rich text document" };
  }
  if (ext === "doc" || ext === "xls" || ext === "ppt" || ext === "pages" || ext === "key" || ext === "numbers") {
    return legacy(ext, bytes, options);
  }
  if (ext === "html" || ext === "htm" || ext === "xhtml" || type === "text/html" || type === "application/xhtml+xml") {
    const html = decodeText(bytes);
    const page = htmlToText(html);
    const description = metaDescription(html);
    const text = description && !page.text.includes(description) ? `> ${description}\n\n${page.text}` : page.text;
    // A single-page app ships a shell and draws the rest with script.
    const scripted = page.text.length < 300 && html.length > 5_000 && /<script\b/i.test(html);
    return {
      kind: "html",
      text,
      summary: page.title ? `Web page: ${page.title}` : "Web page",
      ...(scripted
        ? { warning: "This page draws its content with JavaScript, so little of its text could be read. A direct link to the document, or a copy pasted in, would read better." }
        : {}),
    };
  }
  if (ext === "ipynb") return notebook(bytes);
  // Archives, read one level deep: an archive inside one is listed, not opened.
  if (depth === 0) {
    if (ext === "zip" || type === "application/zip" || type === "application/x-zip-compressed") return zipArchive(bytes, options);
    if (ext === "tar" || type === "application/x-tar") return archive("Tar archive", tarEntries(bytes), options);
    if (ext === "tgz" || ext === "gz" || type === "application/gzip" || type === "application/x-gzip") return gzipped(ext, bytes, options);
  }

  const textual =
    type.startsWith("text/") ||
    /^application\/(json|xml|javascript|x-yaml|yaml|x-sh|sql|graphql|toml|x-ndjson)/.test(type) ||
    TEXT_EXTS.has(ext);
  if (textual || (!type.startsWith("image/") && !type.startsWith("video/") && !type.startsWith("audio/") && looksLikeText(bytes))) {
    if (!looksLikeText(bytes)) return null;
    const text = decodeText(bytes);
    const lines = text.split("\n").length;
    const kind: ExtractKind = ext === "csv" || ext === "tsv" ? "spreadsheet" : "text";
    return { kind, text, summary: `${kind === "spreadsheet" ? "Table" : "Text"}, ${lines.toLocaleString("en")} lines` };
  }
  return null;
}

/* ------------------------------------------------------------------ text */

/** No NUL bytes in the first 8 KB: the same test the editor uses. */
export function looksLikeText(bytes: Buffer): boolean {
  // UTF-16 is full of NULs and is still text; its byte-order mark says so.
  if ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff)) return true;
  return !bytes.subarray(0, 8000).includes(0);
}

/** UTF-8, or UTF-16 when it carries a byte-order mark. */
function decodeText(bytes: Buffer): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return bytes.subarray(2).toString("utf16le");
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    const swapped = Buffer.from(bytes.subarray(2));
    swapped.swap16();
    return swapped.toString("utf16le");
  }
  const text = bytes.toString("utf8");
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** Trailing spaces off, runs of blank lines down to one. */
function tidy(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function notebook(bytes: Buffer): Omit<Extraction, "truncated"> {
  const parsed = JSON.parse(decodeText(bytes)) as {
    cells?: { cell_type?: string; source?: string | string[]; outputs?: { text?: string | string[] }[] }[];
  };
  const join = (value: string | string[] | undefined) => (Array.isArray(value) ? value.join("") : value ?? "");
  const cells = parsed.cells ?? [];
  const text = cells
    .map((cell, i) => {
      const source = join(cell.source);
      if (cell.cell_type === "markdown") return source;
      const outputs = (cell.outputs ?? []).map((o) => join(o.text)).filter(Boolean).join("\n");
      return `\`\`\`\n# In [${i + 1}]\n${source}\n\`\`\`${outputs ? `\nOutput:\n${outputs.slice(0, 4000)}` : ""}`;
    })
    .join("\n\n");
  return { kind: "document", text, summary: `Jupyter notebook, ${cells.length} cells` };
}

/* ------------------------------------------------------------------- XML */

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body: string) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[body.toLowerCase()] ?? whole;
  });
}

function attr(tag: string, name: string): string | undefined {
  const match = new RegExp(`\\s${name.replace(/[:.]/g, "\\$&")}="([^"]*)"`).exec(tag);
  return match ? decodeEntities(match[1]!) : undefined;
}

const CHART_NS = "http://schemas.openxmlformats.org/drawingml/2006/chart";
const SHEET_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";

/**
 * The same XML with one namespace's elements under the prefix the readers
 * here expect (`want`, or none when it is ""). A prefix is the writer's
 * choice: Excel writes a chart as `<c:chart>`, openpyxl as a default
 * namespace `<chart>`, the .NET SDK a sheet as `<x:row>`. Attributes are
 * left as they are.
 */
export function normalizeNamespace(xml: string, uri: string, want: string): string {
  const declared = new RegExp(`xmlns(?::([\\w.-]+))?="${uri.replace(/[.\/]/g, "\\$&")}"`).exec(xml);
  if (!declared) return xml;
  const have = declared[1] ?? "";
  if (have === want) return xml;
  const to = want ? `${want}:` : "";
  if (have) return xml.replace(new RegExp(`<(/?)${have.replace(/\./g, "\\.")}:`, "g"), `<$1${to}`);
  return xml.replace(/<(\/?)([A-Za-z_][\w.-]*)(?=[\s/>])/g, `<$1${to}$2`);
}

/** A Markdown table, with pipes in cells escaped. */
function markdownTable(rows: string[][]): string {
  const width = Math.max(...rows.map((row) => row.length));
  if (!Number.isFinite(width) || width === 0) return "";
  const cell = (value: string | undefined) => (value ?? "").replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " ").trim();
  const line = (row: string[]) => `| ${Array.from({ length: width }, (_, i) => cell(row[i])).join(" | ")} |`;
  const [head, ...body] = rows;
  return [line(head!), `|${" --- |".repeat(width)}`, ...body.map(line)].join("\n");
}

/* ------------------------------------------------------------------- ZIP */

export interface ZipEntries {
  names(): string[];
  has(name: string): boolean;
  /** The entry's uncompressed size, as the directory states it. */
  size(name: string): number;
  text(name: string): string | null;
  bytes(name: string): Buffer | null;
}

/**
 * A ZIP read from its central directory. Only stored and deflated entries,
 * which is everything Office, OpenDocument and EPUB write.
 */
export function readZip(buffer: Buffer): ZipEntries {
  let eocd = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65_557); i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("not a ZIP container");
  const count = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  const entries = new Map<string, { method: number; size: number; local: number; compressed: number }>();
  for (let i = 0; i < count && offset + 46 <= buffer.length; i++) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) break;
    const method = buffer.readUInt16LE(offset + 10);
    const compressed = buffer.readUInt32LE(offset + 20);
    const size = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const local = buffer.readUInt32LE(offset + 42);
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
    entries.set(name, { method, size, local, compressed });
    offset += 46 + nameLength + extraLength + commentLength;
  }

  const bytes = (name: string): Buffer | null => {
    const entry = entries.get(name);
    if (!entry || entry.local + 30 > buffer.length) return null;
    const nameLength = buffer.readUInt16LE(entry.local + 26);
    const extraLength = buffer.readUInt16LE(entry.local + 28);
    const start = entry.local + 30 + nameLength + extraLength;
    const data = buffer.subarray(start, start + entry.compressed);
    if (entry.method === 0) return Buffer.from(data);
    if (entry.method === 8) return inflateRawSync(data, { maxOutputLength: MAX_ENTRY_BYTES });
    return null;
  };

  return {
    names: () => [...entries.keys()],
    has: (name) => entries.has(name),
    size: (name) => entries.get(name)?.size ?? 0,
    bytes,
    text: (name) => bytes(name)?.toString("utf8") ?? null,
  };
}

/** `Target` by `Id` from a `.rels` file, resolved against `base`. */
function relationships(zip: ZipEntries, relsPath: string, base: string): Map<string, { target: string; type: string }> {
  const map = new Map<string, { target: string; type: string }>();
  const xml = zip.text(relsPath);
  if (!xml) return map;
  for (const tag of xml.match(/<Relationship\b[^>]*>/g) ?? []) {
    const id = attr(tag, "Id");
    const target = attr(tag, "Target");
    if (!id || !target) continue;
    map.set(id, { target: resolveZipPath(base, target), type: attr(tag, "Type") ?? "" });
  }
  return map;
}

function resolveZipPath(base: string, target: string): string {
  if (target.startsWith("/")) return target.slice(1);
  const parts = base.split("/").filter(Boolean);
  for (const segment of target.split("/")) {
    if (segment === "..") parts.pop();
    else if (segment !== ".") parts.push(segment);
  }
  return parts.join("/");
}

/* ------------------------------------------------------------------ DOCX */

/** The visible text of one `<w:p>`: runs, tabs, breaks. */
function wordRuns(xml: string): string {
  let out = "";
  for (const match of xml.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:(tab|br|cr)\b[^>]*\/>|<w:delText\b/g)) {
    if (match[1] !== undefined) out += decodeEntities(match[1]);
    else if (match[2] === "tab") out += "\t";
    else if (match[2]) out += "\n";
  }
  return out;
}

function wordParagraph(xml: string): string {
  const text = wordRuns(xml).trim();
  if (!text) return "";
  const style = /<w:pStyle\s+w:val="([^"]+)"/.exec(xml)?.[1] ?? "";
  const heading = /^(?:Heading|heading)\s?(\d)$/.exec(style)?.[1];
  if (style === "Title") return `# ${text}`;
  if (heading) return `${"#".repeat(Math.min(6, Number(heading) + 1))} ${text}`;
  if (/<w:numPr>/.test(xml) || /List/.test(style)) return `- ${text}`;
  return text;
}

function wordBody(xml: string): string {
  const blocks: string[] = [];
  for (const match of xml.matchAll(/<w:tbl>[\s\S]*?<\/w:tbl>|<w:p\b[^>]*\/>|<w:p\b[^>]*>[\s\S]*?<\/w:p>/g)) {
    const block = match[0];
    if (block.startsWith("<w:tbl")) {
      const rows = (block.match(/<w:tr\b[\s\S]*?<\/w:tr>/g) ?? []).map((row) =>
        (row.match(/<w:tc\b[\s\S]*?<\/w:tc>/g) ?? []).map((cell) =>
          (cell.match(/<w:p\b[^>]*>[\s\S]*?<\/w:p>/g) ?? []).map(wordRuns).join(" ").trim(),
        ),
      );
      if (rows.length) blocks.push(markdownTable(rows));
    } else {
      const paragraph = wordParagraph(block);
      if (paragraph) blocks.push(paragraph);
      // A picture's alt text is often the only account of it there is.
      for (const tag of block.match(/<wp:docPr\b[^>]*>/g) ?? []) {
        const alt = attr(tag, "descr") ?? attr(tag, "title");
        if (alt?.trim()) blocks.push(`[Picture: ${alt.trim()}]`);
      }
    }
  }
  return blocks.join("\n\n");
}

function docx(bytes: Buffer): Omit<Extraction, "truncated"> {
  const zip = readZip(bytes);
  const body = zip.text("word/document.xml");
  if (!body) throw new Error("no word/document.xml");
  const parts = [wordBody(body)];
  for (const [file, label] of [
    ["word/footnotes.xml", "Footnotes"],
    ["word/endnotes.xml", "Endnotes"],
    ["word/comments.xml", "Comments"],
  ] as const) {
    const xml = zip.text(file);
    const text = xml ? wordBody(xml).trim() : "";
    if (text) parts.push(`## ${label}\n\n${text}`);
  }
  const charts = chartsIn(zip, /^word\/charts\/chart\d+\.xml$/);
  if (charts) parts.push(`## Charts\n\n${charts}`);
  const pictures = zip.names().filter((name) => name.startsWith("word/media/")).length;
  if (pictures) {
    parts.push(`(This document has ${pictures} embedded picture${pictures === 1 ? "" : "s"}, not shown in this text; the original file is attached.)`);
  }
  const text = parts.join("\n\n");
  const words = text.split(/\s+/).filter(Boolean).length;
  return { kind: "document", text, summary: `Word document, ${words.toLocaleString("en")} words` };
}

/* ---------------------------------------------------------------- charts */

/** The cached values of a chart's points, by index. */
function chartPoints(xml: string): string[] {
  const out: string[] = [];
  for (const match of xml.matchAll(/<c:pt\b[^>]*idx="(\d+)"[^>]*>\s*(?:<c:formatCode>[^<]*<\/c:formatCode>\s*)?<c:v>([^<]*)<\/c:v>/g)) {
    out[Number(match[1])] = decodeEntities(match[2]!);
  }
  return Array.from(out, (value) => value ?? "");
}

/**
 * A chart's data as a table. Office keeps the numbers a chart was drawn from
 * cached in the chart's own XML, so a deck's bar chart is a table a model
 * can read rather than a picture it may not be able to see.
 */
export function chartText(source: string): string {
  const xml = normalizeNamespace(source, CHART_NS, "c");
  const title = drawingParagraphs(/<c:title>[\s\S]*?<\/c:title>/.exec(xml)?.[0] ?? "").join(" ");
  const type = /<c:(\w+?)Chart>/.exec(xml)?.[1];
  const series = [...xml.matchAll(/<c:ser>([\s\S]*?)<\/c:ser>/g)].map((match, i) => {
    const body = match[1]!;
    const tx = /<c:tx>[\s\S]*?<\/c:tx>/.exec(body)?.[0] ?? "";
    const name = chartPoints(tx)[0] ?? /<c:v>([^<]*)<\/c:v>/.exec(tx)?.[1] ?? `Series ${i + 1}`;
    const categories = chartPoints(/<c:(cat|xVal)>[\s\S]*?<\/c:\1>/.exec(body)?.[0] ?? "");
    const valueXml = /<c:(val|yVal)>[\s\S]*?<\/c:\1>/.exec(body)?.[0] ?? "";
    const values = chartPoints(valueXml);
    const ref = /<c:f>([^<]*)<\/c:f>/.exec(valueXml)?.[1];
    return { name: decodeEntities(name), categories, values, ref: ref ? decodeEntities(ref) : undefined };
  });
  if (!series.length) return "";
  const heading = `Chart${type ? ` (${type})` : ""}${title ? `: ${title}` : ""}`;
  // Written without its numbers cached (openpyxl does this): say which
  // cells it plots, which the sheets above hold.
  if (series.every((s) => !s.values.length)) {
    const refs = series.filter((s) => s.ref).map((s) => `${s.name === `Series ${series.indexOf(s) + 1}` ? "" : `${s.name}: `}${s.ref}`);
    return refs.length ? `${heading} — plots ${refs.join("; ")}` : "";
  }
  const categories = series.find((s) => s.categories.length)?.categories ?? [];
  const length = Math.max(categories.length, ...series.map((s) => s.values.length));
  const rows = [
    ["", ...series.map((s) => s.name)],
    ...Array.from({ length: Math.min(length, 500) }, (_, i) => [categories[i] ?? String(i + 1), ...series.map((s) => s.values[i] ?? "")]),
  ];
  return `${heading}\n\n${markdownTable(rows)}`;
}

/** Every chart in a package whose path matches, in number order. */
function chartsIn(zip: ZipEntries, pattern: RegExp): string {
  return zip
    .names()
    .filter((name) => pattern.test(name))
    .sort((a, b) => Number(/(\d+)\.xml$/.exec(a)?.[1] ?? 0) - Number(/(\d+)\.xml$/.exec(b)?.[1] ?? 0))
    .map((name) => chartText(zip.text(name) ?? ""))
    .filter(Boolean)
    .join("\n\n");
}

/* ------------------------------------------------------------------ PPTX */

/** A slide's tables as Markdown, and the slide's XML without them. */
function slideTables(xml: string): { tables: string[]; rest: string } {
  const tables: string[] = [];
  const rest = xml.replace(/<a:tbl>[\s\S]*?<\/a:tbl>/g, (table) => {
    const rows = (table.match(/<a:tr\b[\s\S]*?<\/a:tr>/g) ?? []).map((row) =>
      (row.match(/<a:tc\b[\s\S]*?<\/a:tc>/g) ?? []).map((cell) => drawingParagraphs(cell).join(" ")),
    );
    if (rows.length) tables.push(markdownTable(rows));
    return "";
  });
  return { tables, rest };
}

function drawingParagraphs(xml: string): string[] {
  const paragraphs: string[] = [];
  for (const match of xml.matchAll(/<a:p(?:\s[^>]*?)?(?<!\/)>[\s\S]*?<\/a:p>/g)) {
    let text = "";
    for (const run of match[0].matchAll(/<a:t>([^<]*)<\/a:t>|<a:br\b/g)) text += run[1] !== undefined ? decodeEntities(run[1]) : "\n";
    if (text.trim()) paragraphs.push(text.trim());
  }
  return paragraphs;
}

function pptx(bytes: Buffer): Omit<Extraction, "truncated"> {
  const zip = readZip(bytes);
  // The order the deck shows, from presentation.xml; numeric names as a fallback.
  const rels = relationships(zip, "ppt/_rels/presentation.xml.rels", "ppt");
  const order = [...(zip.text("ppt/presentation.xml") ?? "").matchAll(/<p:sldId\b[^>]*>/g)]
    .map((match) => rels.get(attr(match[0], "r:id") ?? "")?.target)
    .filter((target): target is string => Boolean(target && zip.has(target)));
  const slides = order.length
    ? order
    : zip
        .names()
        .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
        .sort((a, b) => Number(/(\d+)\.xml$/.exec(a)![1]) - Number(/(\d+)\.xml$/.exec(b)![1]));

  const out: string[] = [];
  slides.forEach((path, i) => {
    const { tables, rest: xml } = slideTables(zip.text(path) ?? "");
    const paragraphs = drawingParagraphs(xml);
    const file = path.split("/").pop()!;
    const slideRels = relationships(zip, `ppt/slides/_rels/${file}.rels`, "ppt/slides");
    const charts = [...slideRels.values()]
      .filter((rel) => rel.type.endsWith("/chart"))
      .map((rel) => chartText(zip.text(rel.target) ?? ""))
      .filter(Boolean);
    const pictures = (xml.match(/<p:pic>[\s\S]*?<\/p:pic>/g) ?? []).map((pic) => {
      const alt = attr(/<p:cNvPr\b[^>]*>/.exec(pic)?.[0] ?? "", "descr")?.trim();
      return alt ? `[Picture: ${alt}]` : "[Picture]";
    });
    const notesPath = [...slideRels.values()].find((rel) => rel.type.endsWith("/notesSlide"))?.target;
    const notes = notesPath
      ? drawingParagraphs(zip.text(notesPath) ?? "").filter((p) => !/^\d+$/.test(p))
      : [];
    const [title, ...rest] = paragraphs;
    out.push(
      [
        `## Slide ${i + 1}${title ? `: ${title.replace(/\n/g, " ")}` : ""}`,
        ...rest.map((p) => (p.includes("\n") ? p : `- ${p}`)),
        ...tables,
        ...charts,
        ...pictures,
        ...(notes.length ? [`Speaker notes: ${notes.join(" ")}`] : []),
      ].join("\n"),
    );
  });
  return { kind: "presentation", text: out.join("\n\n"), summary: `Presentation, ${slides.length} slides` };
}

/* ------------------------------------------------------------------ XLSX */

/**
 * Rows past this per sheet are counted, not listed. The text is a reading
 * copy; the workbook itself sits beside it for a script to analyse whole.
 */
const MAX_SHEET_ROWS = 20_000;
const MAX_SHEET_COLS = 60;

function columnIndex(ref: string): number {
  let n = 0;
  for (const ch of /^[A-Z]+/.exec(ref)?.[0] ?? "A") n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/** Built-in number formats that are dates, and custom ones that look like one. */
function dateStyles(zip: ZipEntries): Set<number> {
  const xml = zip.text("xl/styles.xml") ?? "";
  const custom = new Map<number, string>();
  for (const tag of xml.match(/<numFmt\b[^>]*>/g) ?? []) {
    custom.set(Number(attr(tag, "numFmtId")), attr(tag, "formatCode") ?? "");
  }
  const isDate = (id: number) => {
    if ((id >= 14 && id <= 22) || (id >= 45 && id <= 47)) return true;
    const code = custom.get(id)?.replace(/"[^"]*"|\[[^\]]*\]|\\./g, "") ?? "";
    return /[dmyhs]/i.test(code) && !/^[#0.,%E+-]+$/.test(code);
  };
  const styles = new Set<number>();
  const xfs = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(xml)?.[1] ?? "";
  (xfs.match(/<xf\b[^>]*>/g) ?? []).forEach((tag, index) => {
    if (isDate(Number(attr(tag, "numFmtId") ?? 0))) styles.add(index);
  });
  return styles;
}

function serialToDate(serial: number): string {
  const ms = Math.round((serial - 25569) * 86_400_000);
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return String(serial);
  const iso = date.toISOString();
  return serial % 1 === 0 ? iso.slice(0, 10) : iso.slice(0, 19).replace("T", " ");
}

function xlsx(bytes: Buffer): Omit<Extraction, "truncated"> {
  const raw = readZip(bytes);
  // SpreadsheetML unprefixed, whoever wrote it.
  const zip: ZipEntries = { ...raw, text: (name) => {
    const xml = raw.text(name);
    return xml && name.endsWith(".xml") && !name.includes("/charts/") ? normalizeNamespace(xml, SHEET_NS, "") : xml;
  } };
  const shared = [...(zip.text("xl/sharedStrings.xml") ?? "").matchAll(/<si>([\s\S]*?)<\/si>/g)].map((match) =>
    [...match[1]!.matchAll(/<t(?:\s[^>]*)?>([^<]*)<\/t>/g)].map((t) => decodeEntities(t[1]!)).join(""),
  );
  const dates = dateStyles(zip);
  const rels = relationships(zip, "xl/_rels/workbook.xml.rels", "xl");
  const sheets = [...(zip.text("xl/workbook.xml") ?? "").matchAll(/<sheet\b[^>]*>/g)].map((match) => ({
    name: attr(match[0], "name") ?? "Sheet",
    hidden: attr(match[0], "state") === "hidden",
    path: rels.get(attr(match[0], "r:id") ?? "")?.target ?? "",
  }));

  const out: string[] = [];
  for (const sheet of sheets) {
    const xml = zip.text(sheet.path);
    if (!xml) continue;
    const rows: string[][] = [];
    let totalRows = 0;
    let maxCols = 0;
    for (const rowMatch of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
      totalRows++;
      if (rows.length >= MAX_SHEET_ROWS) continue;
      const row: string[] = [];
      for (const cell of rowMatch[1]!.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const tag = cell[1]!;
        const inner = cell[2] ?? "";
        const ref = attr(` ${tag}`, "r") ?? "";
        const col = ref ? columnIndex(ref) : row.length;
        if (col >= MAX_SHEET_COLS) continue;
        const type = attr(` ${tag}`, "t");
        const style = Number(attr(` ${tag}`, "s") ?? -1);
        const raw = /<v>([^<]*)<\/v>/.exec(inner)?.[1];
        let value = "";
        if (type === "s" && raw !== undefined) value = shared[Number(raw)] ?? "";
        else if (type === "inlineStr") value = [...inner.matchAll(/<t(?:\s[^>]*)?>([^<]*)<\/t>/g)].map((t) => decodeEntities(t[1]!)).join("");
        else if (type === "b") value = raw === "1" ? "TRUE" : "FALSE";
        else if (raw) {
          const decoded = decodeEntities(raw);
          value = dates.has(style) && type !== "str" && type !== "e" && Number.isFinite(Number(decoded)) ? serialToDate(Number(decoded)) : decoded;
        } else {
          const formula = /<f\b[^>]*>([^<]*)<\/f>/.exec(inner)?.[1];
          if (formula) value = `=${decodeEntities(formula)}`;
        }
        row[col] = value;
      }
      // Cells are sparse: fill the gaps so columns line up.
      for (let i = 0; i < row.length; i++) row[i] ??= "";
      maxCols = Math.max(maxCols, row.length);
      rows.push(row);
    }
    // Trailing rows with nothing in them are formatting, not data.
    while (rows.length && rows.at(-1)!.every((v) => !v)) rows.pop();
    const header = `## Sheet: ${sheet.name}${sheet.hidden ? " (hidden)" : ""} — ${totalRows.toLocaleString("en")} rows × ${maxCols} columns`;
    if (!rows.length) {
      out.push(`${header}\n\n(empty)`);
      continue;
    }
    const more =
      totalRows > MAX_SHEET_ROWS
        ? `\n\n(${(totalRows - MAX_SHEET_ROWS).toLocaleString("en")} more rows not shown: analyse the original workbook with a script for all of them.)`
        : "";
    out.push(`${header}\n\n${markdownTable(rows)}${more}`);
  }
  const charts = chartsIn(zip, /^xl\/charts\/chart\d+\.xml$/);
  if (charts) out.push(`## Charts\n\n${charts}`);
  return { kind: "spreadsheet", text: out.join("\n\n"), summary: `Spreadsheet, ${sheets.length} sheet${sheets.length === 1 ? "" : "s"}` };
}

/* ------------------------------------------------------------ OpenDocument */

function odfText(xml: string): string {
  return decodeEntities(
    xml
      .replace(/<text:s\b[^>]*c="(\d+)"[^>]*\/>/g, (_, n: string) => " ".repeat(Math.min(Number(n), 64)))
      .replace(/<text:s\b[^>]*\/>/g, " ")
      .replace(/<text:tab\b[^>]*\/>/g, "\t")
      .replace(/<text:line-break\b[^>]*\/>/g, "\n")
      .replace(/<[^>]+>/g, ""),
  );
}

function odf(bytes: Buffer, kind: "document" | "spreadsheet" | "presentation"): Omit<Extraction, "truncated"> {
  const zip = readZip(bytes);
  const xml = zip.text("content.xml");
  if (!xml) throw new Error("no content.xml");
  if (kind === "spreadsheet") {
    const out: string[] = [];
    let count = 0;
    for (const table of xml.matchAll(/<table:table\b([^>]*)>([\s\S]*?)<\/table:table>/g)) {
      count++;
      const rows: string[][] = [];
      for (const row of table[2]!.matchAll(/<table:table-row\b([^>]*)>([\s\S]*?)<\/table:table-row>/g)) {
        if (rows.length >= MAX_SHEET_ROWS) break;
        const cells: string[] = [];
        for (const cell of row[2]!.matchAll(/<table:(?:covered-)?table-cell\b([^>]*?)(?:\/>|>([\s\S]*?)<\/table:(?:covered-)?table-cell>)/g)) {
          const repeat = Math.min(Number(attr(cell[1]!, "table:number-columns-repeated") ?? 1), MAX_SHEET_COLS);
          const value = (cell[2] ? (cell[2].match(/<text:p\b[\s\S]*?<\/text:p>/g) ?? []).map(odfText).join(" ") : "").trim();
          for (let i = 0; i < repeat && cells.length < MAX_SHEET_COLS; i++) cells.push(value);
        }
        while (cells.length && !cells.at(-1)) cells.pop();
        const repeatRows = Math.min(Number(attr(row[1]!, "table:number-rows-repeated") ?? 1), 1000);
        if (!cells.length) {
          if (repeatRows < 100) rows.push([]);
          continue;
        }
        for (let i = 0; i < repeatRows; i++) rows.push(cells);
      }
      while (rows.length && !rows.at(-1)!.length) rows.pop();
      const name = attr(table[1]!, "table:name") ?? `Sheet ${count}`;
      out.push(`## Sheet: ${name}\n\n${rows.length ? markdownTable(rows.map((r) => (r.length ? r : [""]))) : "(empty)"}`);
    }
    return { kind, text: out.join("\n\n"), summary: `Spreadsheet, ${count} sheet${count === 1 ? "" : "s"}` };
  }
  if (kind === "presentation") {
    const pages = [...xml.matchAll(/<draw:page\b([^>]*)>([\s\S]*?)<\/draw:page>/g)];
    const text = pages
      .map((page, i) => {
        const paragraphs = (page[2]!.match(/<text:(?:p|h)\b[\s\S]*?<\/text:(?:p|h)>/g) ?? []).map(odfText).map((p) => p.trim()).filter(Boolean);
        const [title, ...rest] = paragraphs;
        return [`## Slide ${i + 1}${title ? `: ${title}` : ""}`, ...rest.map((p) => `- ${p}`)].join("\n");
      })
      .join("\n\n");
    return { kind, text, summary: `Presentation, ${pages.length} slides` };
  }
  const body = /<office:text\b[^>]*>([\s\S]*)<\/office:text>/.exec(xml)?.[1] ?? xml;
  const blocks: string[] = [];
  for (const match of body.matchAll(/<text:h\b([^>]*)>([\s\S]*?)<\/text:h>|<text:p\b[^>]*>([\s\S]*?)<\/text:p>|<text:p\b[^>]*\/>/g)) {
    if (match[2] !== undefined) {
      const level = Number(attr(match[1]!, "text:outline-level") ?? 1);
      blocks.push(`${"#".repeat(Math.min(6, level + 1))} ${odfText(match[2]).trim()}`);
    } else if (match[3] !== undefined) {
      const text = odfText(match[3]).trim();
      if (text) blocks.push(text);
    }
  }
  const text = blocks.join("\n\n");
  return { kind, text, summary: `Document, ${text.split(/\s+/).filter(Boolean).length.toLocaleString("en")} words` };
}

/* ------------------------------------------------------------------ EPUB */

function epub(bytes: Buffer): Omit<Extraction, "truncated"> {
  const zip = readZip(bytes);
  const container = zip.text("META-INF/container.xml") ?? "";
  const opfPath = attr(/<rootfile\b[^>]*>/.exec(container)?.[0] ?? "", "full-path") ?? "";
  const opf = zip.text(opfPath) ?? "";
  const base = opfPath.split("/").slice(0, -1).join("/");
  const manifest = new Map<string, string>();
  for (const tag of opf.match(/<item\b[^>]*>/g) ?? []) {
    const id = attr(tag, "id");
    const href = attr(tag, "href");
    if (id && href) manifest.set(id, resolveZipPath(base, href));
  }
  const spine = (opf.match(/<itemref\b[^>]*>/g) ?? []).map((tag) => manifest.get(attr(tag, "idref") ?? "")).filter(Boolean) as string[];
  const chapters = spine.map((path) => htmlToText(zip.text(decodeURIComponent(path)) ?? zip.text(path) ?? "").text).filter(Boolean);
  const title = /<dc:title[^>]*>([^<]*)<\/dc:title>/.exec(opf)?.[1];
  return {
    kind: "ebook",
    text: chapters.join("\n\n---\n\n"),
    summary: `E-book${title ? `: ${decodeEntities(title)}` : ""}, ${chapters.length} sections`,
  };
}

/* ------------------------------------------------------------------ HTML */

/** A page's own summary of itself: `description`, or Open Graph's. */
function metaDescription(html: string): string | null {
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    const key = (/\b(?:name|property)\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1] ?? "").toLowerCase();
    if (key !== "description" && key !== "og:description") continue;
    const content = /\bcontent\s*=\s*"([^"]*)"|\bcontent\s*=\s*'([^']*)'/i.exec(tag);
    const value = decodeEntities(content?.[1] ?? content?.[2] ?? "").replace(/\s+/g, " ").trim();
    if (value) return value;
  }
  return null;
}

/**
 * Readable text from a page: the article when it marks one, headings and
 * lists kept as Markdown, chrome (scripts, styles, navigation) dropped.
 */
export function htmlToText(html: string): { title: string; text: string } {
  const title = decodeEntities(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? "").replace(/\s+/g, " ").trim();
  let body = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|noscript|svg|template|iframe|canvas|head)\b[\s\S]*?<\/\1>/gi, "");
  // The main content, when the page says which part that is.
  const main = /<(article|main)\b[^>]*>([\s\S]*?)<\/\1>/i.exec(body)?.[2];
  if (main && main.replace(/<[^>]+>/g, "").trim().length > 400) body = main;
  else body = body.replace(/<(nav|footer|header|aside|form)\b[\s\S]*?<\/\1>/gi, "");

  const text = decodeEntities(
    body
      .replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_, n: string, inner: string) => `\n\n${"#".repeat(Number(n))} ${inner.replace(/<[^>]+>/g, "").trim()}\n\n`)
      .replace(/<li\b[^>]*>/gi, "\n- ")
      .replace(/<(?:td|th)\b[^>]*>/gi, " | ")
      .replace(/<\/tr>/gi, " |\n")
      .replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_, inner: string) => `\n\n\`\`\`\n${inner.replace(/<[^>]+>/g, "")}\n\`\`\`\n\n`)
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|section|article|blockquote|ul|ol|table|tr|dl|dt|dd|figure|figcaption)>/gi, "\n\n")
      .replace(/<[^>]+>/g, "")
      .replace(/[ \t ]+/g, " "),
  )
    .split("\n")
    .map((line) => line.trim())
    .join("\n");
  return { title, text: tidy(text) };
}

/* ------------------------------------------------------------------- RTF */

export function rtfToText(rtf: string): string {
  let out = "";
  let depth = 0;
  let skipDepth = -1;
  let i = 0;
  while (i < rtf.length) {
    const ch = rtf[i]!;
    if (ch === "{") {
      depth++;
      if (rtf.startsWith("{\\*", i) && skipDepth < 0) skipDepth = depth;
      i++;
    } else if (ch === "}") {
      if (depth === skipDepth) skipDepth = -1;
      depth--;
      i++;
    } else if (ch === "\\") {
      const control = /^\\([a-z]+)(-?\d+)? ?|^\\'([0-9a-f]{2})|^\\(.)/i.exec(rtf.slice(i, i + 40));
      if (!control) {
        i++;
        continue;
      }
      i += control[0].length;
      if (skipDepth >= 0) continue;
      const word = control[1];
      if (word === "fonttbl" || word === "colortbl" || word === "stylesheet" || word === "info" || word === "pict") skipDepth = depth;
      else if (word === "par" || word === "line") out += "\n";
      else if (word === "tab") out += "\t";
      else if (word === "u" && control[2]) {
        out += String.fromCharCode(Number(control[2]) < 0 ? Number(control[2]) + 65536 : Number(control[2]));
        if (rtf[i] === "?") i++;
      } else if (control[3]) out += Buffer.from([parseInt(control[3], 16)]).toString("latin1");
      else if (control[4] && "\\{}".includes(control[4])) out += control[4];
    } else {
      if (skipDepth < 0 && ch !== "\r" && ch !== "\n") out += ch;
      i++;
    }
  }
  return out;
}

/* -------------------------------------------------------------- archives */

interface ArchiveEntry {
  name: string;
  size: number;
  read(): Buffer | null;
}

const ARCHIVE_MAX_LISTED = 500;
/** Inside an archive, files past this size are listed and not opened. */
const ARCHIVE_MAX_FILE_BYTES = 20 * 1024 * 1024;
/** The most an archive's files may inflate to in total: a bomb stops here. */
const ARCHIVE_MAX_TOTAL_BYTES = 256 * 1024 * 1024;
/** Text kept from all of an archive's files, and from any one of them. */
const ARCHIVE_TEXT_CHARS = 1_000_000;
const ARCHIVE_FILE_CHARS = 200_000;
/** What is almost never what the person meant to share. */
const ARCHIVE_NOISE = /(^|\/)(__MACOSX|\.git|node_modules|\.DS_Store|Thumbs\.db)(\/|$)/;

function zipArchive(bytes: Buffer, options: ExtractOptions): Promise<Omit<Extraction, "truncated">> {
  const zip = readZip(bytes);
  return archive(
    "ZIP archive",
    zip.names().map((name) => ({ name, size: zip.size(name), read: () => zip.bytes(name) })),
    options,
  );
}

/** A ustar/GNU tar's regular files. */
function tarEntries(bytes: Buffer): ArchiveEntry[] {
  const entries: ArchiveEntry[] = [];
  let offset = 0;
  let longName: string | null = null;
  while (offset + 512 <= bytes.length && entries.length < 10_000) {
    const header = bytes.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) break;
    const field = (start: number, length: number) => header.subarray(start, start + length).toString("utf8").replace(/\0.*$/s, "");
    const size = parseInt(field(124, 12).trim() || "0", 8) || 0;
    const flag = field(156, 1);
    const prefix = field(257, 6).startsWith("ustar") ? field(345, 155) : "";
    const name = longName ?? (prefix ? `${prefix}/${field(0, 100)}` : field(0, 100));
    const start = offset + 512;
    offset = start + Math.ceil(size / 512) * 512;
    if (flag === "L") {
      longName = bytes.subarray(start, start + size).toString("utf8").replace(/\0.*$/s, "");
      continue;
    }
    longName = null;
    if (flag !== "0" && flag !== "" && flag !== "7") continue;
    entries.push({ name, size, read: () => (start + size <= bytes.length ? bytes.subarray(start, start + size) : null) });
  }
  return entries;
}

function gzipped(ext: string, bytes: Buffer, options: ExtractOptions): Promise<Omit<Extraction, "truncated">> | Omit<Extraction, "truncated"> {
  const inner = gunzipSync(bytes, { maxOutputLength: ARCHIVE_MAX_TOTAL_BYTES });
  const isTar = ext === "tgz" || inner.subarray(257, 262).toString("latin1") === "ustar";
  if (isTar) return archive("Tar archive (gzip)", tarEntries(inner), options);
  return archive("Gzip file", [{ name: "(contents)", size: inner.length, read: () => inner }], options);
}

/**
 * An archive as text: the list of what is in it, then each file it can read
 * -- source, a PDF, a workbook -- under its own heading, as if each had been
 * attached on its own. Bounded on every side: entries, bytes, and text.
 */
async function archive(label: string, entries: ArchiveEntry[], options: ExtractOptions): Promise<Omit<Extraction, "truncated">> {
  const files = entries.filter((entry) => !entry.name.endsWith("/"));
  const listing = files
    .slice(0, ARCHIVE_MAX_LISTED)
    .map((entry) => `- ${entry.name} (${humanSize(entry.size)})`)
    .join("\n");
  const unlisted = files.length > ARCHIVE_MAX_LISTED ? `\n- … and ${(files.length - ARCHIVE_MAX_LISTED).toLocaleString("en")} more` : "";

  const sections: string[] = [];
  let budget = ARCHIVE_TEXT_CHARS;
  let inflated = 0;
  let skipped = 0;
  for (const entry of files) {
    if (ARCHIVE_NOISE.test(entry.name)) continue;
    if (budget <= 0 || entry.size > ARCHIVE_MAX_FILE_BYTES || inflated + entry.size > ARCHIVE_MAX_TOTAL_BYTES) {
      skipped++;
      continue;
    }
    inflated += entry.size;
    let bytes: Buffer | null = null;
    try {
      bytes = entry.read();
    } catch {
      bytes = null;
    }
    if (!bytes?.length) continue;
    const inner = await dispatch(extOf(entry.name), "", bytes, { ...options, maxPageImages: 0 }, 1).catch(() => null);
    const text = inner ? tidy(inner.text) : "";
    if (!text) continue;
    const shown = text.slice(0, Math.min(ARCHIVE_FILE_CHARS, budget));
    budget -= shown.length;
    const fence = "`".repeat(Math.max(3, ...[...shown.matchAll(/`{3,}/g)].map((m) => m[0].length + 1)));
    const cut = shown.length < text.length ? "\n(cut short here)" : "";
    sections.push(`## ${entry.name}${inner!.kind !== "text" ? ` (${inner!.summary})` : ""}\n\n${fence}\n${shown}\n${fence}${cut}`);
  }

  const text = [
    `## Contents: ${files.length.toLocaleString("en")} file${files.length === 1 ? "" : "s"}\n\n${listing}${unlisted}`,
    ...sections,
  ].join("\n\n");
  return {
    kind: "archive",
    text,
    summary: `${label}, ${files.length.toLocaleString("en")} file${files.length === 1 ? "" : "s"}`,
    ...(skipped ? { warning: `${skipped} file${skipped === 1 ? " was" : "s were"} too large to read inside the archive; extract it to read ${skipped === 1 ? "it" : "them"}.` } : {}),
  };
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/* ------------------------------------------------------- external tools */

function run(argv: string[], timeoutMs: number, maxBuffer = 64 * 1024 * 1024): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile(argv[0]!, argv.slice(1), { timeout: timeoutMs, maxBuffer, encoding: "buffer", killSignal: "SIGKILL" }, (error, stdout) =>
      error ? reject(error) : resolve(stdout),
    );
  });
}

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}

async function withTemp<T>(work: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "ucch-extract-"));
  try {
    return await work(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function pdf(bytes: Buffer, options: ExtractOptions): Promise<Omit<Extraction, "truncated">> {
  const timeout = options.timeoutMs ?? 60_000;
  return withTemp(async (dir) => {
    const input = join(dir, "in.pdf");
    await writeFile(input, bytes);
    let raw: string;
    try {
      raw = (await run(["pdftotext", "-layout", "-enc", "UTF-8", input, "-"], timeout)).toString("utf8");
    } catch (error) {
      if (missing(error)) {
        return { kind: "pdf", text: "", summary: "PDF", warning: "pdftotext (poppler-utils) is not installed on the server, so this PDF's text could not be read." };
      }
      throw error;
    }
    const pages = raw.split("\f");
    if (pages.at(-1)?.trim() === "") pages.pop();
    const letters = raw.replace(/\s+/g, "").length;
    const summary = `PDF, ${pages.length} page${pages.length === 1 ? "" : "s"}`;

    // Pages with no text layer -- the whole of a scan, or the odd scanned
    // page in a typed document -- are read by OCR where it is installed.
    const blank = pages.flatMap((page, i) => (page.replace(/\s+/g, "").length < 20 ? [i] : []));
    const ocr = blank.length ? await ocrPages(input, dir, blank.slice(0, options.maxOcrPages ?? 20), timeout) : null;
    const recognised = ocr ? [...ocr.values()].filter((t) => t.replace(/\s+/g, "").length >= 20).length : 0;
    const text = pages
      .map((page, i) => {
        const read = ocr?.get(i);
        return read ? `--- Page ${i + 1} (OCR) ---\n${read.trim()}` : `--- Page ${i + 1} ---\n${page.replace(/^\n+|\s+$/g, "")}`;
      })
      .join("\n\n");
    const ocrNote = recognised
      ? ` ${recognised} page${recognised === 1 ? " was" : "s were"} read by OCR (marked "(OCR)"), which can misread characters: check figures that matter against the page images or the original.` +
        (blank.length > recognised ? ` ${blank.length - recognised} page${blank.length - recognised === 1 ? "" : "s"} without a text layer could not be read.` : "")
      : "";

    // Under ~40 characters a page there is no text layer to speak of: a scan.
    if (letters < Math.max(40, pages.length * 40)) {
      const pageImages = await renderPages(input, dir, options.maxPageImages ?? 8, timeout);
      return {
        kind: "pdf",
        text,
        summary,
        warning:
          "This PDF has little or no text layer (it is probably scanned)." +
          ocrNote +
          (pageImages.length ? ` The first ${pageImages.length} page${pageImages.length === 1 ? " is" : "s are"} attached as images.` : ""),
        ...(pageImages.length ? { pageImages } : {}),
      };
    }
    return { kind: "pdf", text, summary, ...(ocrNote ? { warning: ocrNote.trim() } : {}) };
  });
}

/**
 * The text of these pages (0-based) by OCR: rendered at 200 dpi in grey,
 * then read by `tesseract`. Null when OCR is off or not installed; a page it
 * could not read is left out of the map. The whole pass is held to one
 * deadline, since it runs while the upload waits.
 */
async function ocrPages(input: string, dir: string, pages: number[], timeoutMs: number): Promise<Map<number, string> | null> {
  if (pages.length === 0) return null;
  const out = new Map<number, string>();
  const deadline = Date.now() + Math.max(timeoutMs, 90_000);
  for (const page of pages) {
    const left = deadline - Date.now();
    if (left <= 1_000) break;
    const stem = join(dir, `ocr-${page}`);
    try {
      await run(["pdftoppm", "-r", "200", "-gray", "-png", "-singlefile", "-f", String(page + 1), "-l", String(page + 1), input, stem], left);
    } catch {
      continue;
    }
    try {
      const text = (await run(["tesseract", `${stem}.png`, "-", "--psm", "3"], deadline - Date.now())).toString("utf8");
      if (text.trim()) out.set(page, text);
    } catch (error) {
      if (missing(error)) return null;
    } finally {
      await rm(`${stem}.png`, { force: true });
    }
  }
  return out;
}

/** Pages as PNGs, for a scanned PDF and a model that can see. */
async function renderPages(input: string, dir: string, maxPages: number, timeoutMs: number): Promise<Buffer[]> {
  if (maxPages <= 0) return [];
  try {
    await run(["pdftoppm", "-png", "-r", "110", "-f", "1", "-l", String(maxPages), "-scale-to", "1600", input, join(dir, "page")], timeoutMs);
  } catch {
    return [];
  }
  const files = (await readdir(dir)).filter((name) => /^page-\d+\.png$/.test(name)).sort((a, b) => Number(/\d+/.exec(a)![0]) - Number(/\d+/.exec(b)![0]));
  return Promise.all(files.map((name) => readFile(join(dir, name))));
}

/** Legacy binaries, through LibreOffice into the format this file reads. */
async function legacy(ext: string, bytes: Buffer, options: ExtractOptions): Promise<Omit<Extraction, "truncated">> {
  const target = ext === "xls" || ext === "numbers" ? "xlsx" : ext === "ppt" || ext === "key" ? "pptx" : "docx";
  const unreadable = (why: string) => ({
    kind: (target === "xlsx" ? "spreadsheet" : target === "pptx" ? "presentation" : "document") as ExtractKind,
    text: "",
    summary: `.${ext} file`,
    warning: `${why} Saving it as .${target} (or PDF) and attaching that would let it be read.`,
  });
  return withTemp(async (dir) => {
    const input = join(dir, `in.${ext}`);
    await writeFile(input, bytes);
    for (const bin of ["soffice", "libreoffice"]) {
      try {
        await run([bin, "--headless", "--norestore", `-env:UserInstallation=file://${dir}/profile`, "--convert-to", target, "--outdir", dir, input], options.timeoutMs ?? 90_000);
        const converted = await readFile(join(dir, `in.${target}`)).catch(() => null);
        if (!converted) return unreadable("LibreOffice could not convert this file.");
        return target === "xlsx" ? xlsx(converted) : target === "pptx" ? pptx(converted) : docx(converted);
      } catch (error) {
        if (missing(error)) continue;
        return unreadable("LibreOffice could not convert this file.");
      }
    }
    return unreadable(`Reading the legacy .${ext} format needs LibreOffice, which is not installed on the server.`);
  });
}
