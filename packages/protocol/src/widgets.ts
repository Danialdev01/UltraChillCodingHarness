/**
 * Inline interactive widgets: a chart, diagram or small tool the agent puts
 * in its answer, which the chat runs in a sandboxed frame.
 *
 * Two ways in, one shape out. Every backend can write a ```widget fence in
 * its answer; the built-in agent (and Claude Code / Codex through the MCP
 * bridge) can also call `show_widget`. Both become a `Widget`, read off the
 * events already in the log -- nothing new is stored, so a widget comes back
 * on reload exactly as it was drawn.
 *
 * Browser-safe: no zod, exported from `@ucch/protocol/plain`.
 */

/**
 * What every agent is told about widgets. One constant so it can be tuned in
 * one place; injected for the built-in agent (after `HARNESS_RULES`), for
 * Claude Code (`--append-system-prompt`) and for Codex (first message).
 * Fixed text, so it never breaks the prompt cache.
 */
export const WIDGET_PROMPT = `You can render interactive visuals inline in the chat. Use them when a visual explains something better than text: calculators, charts of numbers, process or architecture diagrams, comparisons. Don't use them for plain answers or code changes.

When the developer asks for a visualizer, a visualisation, a widget, a chart, a graph, a diagram, a calculator or anything shown "in the chat", answer with a widget in that reply. A widget is the only way to show something in this chat: files you write, HTML pages, browser windows, terminal UIs, and Claude Code mods, plugins, skills or artifacts never appear here. Write the visual to a file only when the developer asks for a file.

Emit one as a fenced code block with the language \`widget\` (or call the show_widget tool if you have it): an optional one-line JSON metadata object such as {"title": "hosting_cost_calculator"}, then a line containing only ---, then an HTML fragment (no <html>, <head> or <body>) or a raw <svg>. For example:

\`\`\`widget
{"title": "snake_case_title"}
---
<div id="app">...</div>
<style>...</style>
<script>...</script>
\`\`\`

Rules: self-contained; vanilla JS, or libraries loaded with <script src> from https://cdn.jsdelivr.net only (Chart.js, D3, Mermaid); no fetch, XHR or websockets -- embed any data; no localStorage or cookies. Colour it with the CSS variables --fg (text), --muted (secondary text), --bg, --card (panels), --border, --accent (highlights and selected states; text on it uses --accent-fg) and --chart-1 to --chart-6 (series), plus --radius, --font-sans and --font-mono; they follow the reader's light or dark theme, and leave the page background transparent. Make the width responsive (the container is about 720px but may be narrower on mobile), let the content set the height (no vh units or height:100% on html or body), and give charts a fixed pixel height. Keep it under about 400 lines. Put explanatory text in normal Markdown before or after the widget, not inside it, and do not restate the widget in prose. A button that should ask a follow-up question can call sendPrompt(text).`;

/**
 * What a message asking for a visual says. Matched on the person's own
 * message, so a turn that plainly wants a widget is told so right there --
 * the standing prompt alone loses to a long history of doing it some other
 * way. Loose on purpose: the nudge says to do something else when the
 * person wants a file or a code change.
 */
const ASKS_FOR_WIDGET: readonly RegExp[] = [
  /\bvisuali[sz](?:e|es|er|ers|ing|ation|ations)\b/i,
  /\bwidgets?\b/i,
  /\b(?:in|inside|within|into|on)\s+(?:the|this|my)\s+chat\b/i,
  /\b(?:inline|interactive)\s+(?:visual|visuals|chart|charts|graph|graphs|diagram|diagrams|calculator|tool|demo|simulation)\b/i,
  /\b(?:draw|sketch|plot|chart|graph|diagram|map out)\b[^.?!\n]{0,60}\b(?:diagram|flow|flowchart|chart|graph|architecture|pipeline|timeline|sequence)\b/i,
  /\b(?:make|create|build|show|give|generate|render)\b[^.?!\n]{0,40}\b(?:calculator|chart|graph|diagram|visual|visuals|dashboard|simulator|simulation)\b/i,
];

export function asksForWidget(text: string): boolean {
  return ASKS_FOR_WIDGET.some((pattern) => pattern.test(text));
}

/**
 * Added to a turn's message when `asksForWidget` matches it. Says the format
 * again, because a resumed Codex session was handed the standing prompt
 * only once, possibly before widgets existed.
 */
export const WIDGET_TURN_NUDGE = `[UCCH] This message asks for a visual. Answer it with an inline widget in this reply: a fenced code block with the language \`widget\` (or the show_widget tool if you have it) holding an optional one-line JSON object such as {"title": "snake_case_title"}, a line containing only ---, then a self-contained HTML fragment or a raw <svg>, coloured with var(--fg), var(--muted), var(--card), var(--border) and var(--accent). Do not write it to a file, open a browser, or build a Claude Code mod, plugin, skill or artifact: none of those appear in this chat. If an earlier answer here did one of those, do not continue it; draw the widget now. Only when the developer explicitly asks for a file or a change to the project's code, do that instead.`;

/** Script origins a widget may load libraries from. The CSP is built from this list. */
export const WIDGET_CDN_ALLOWLIST: readonly string[] = ["https://cdn.jsdelivr.net"];

/** Above this the widget is shown as code instead of run. */
export const WIDGET_MAX_BYTES = 200_000;

/** The fence languages that render. `widget` is the one the prompt teaches; the rest are older names. */
export const WIDGET_LANGUAGES: ReadonlySet<string> = new Set(["widget", "html-render", "html-preview", "render"]);

export function isWidgetLanguage(language: string | null | undefined): boolean {
  return language != null && WIDGET_LANGUAGES.has(language.toLowerCase());
}

/** The built-in tool, and its names as the MCP bridge surfaces it on Claude Code and Codex. */
export const SHOW_WIDGET_TOOL = "show_widget";
const SHOW_WIDGET_NAMES = new Set([SHOW_WIDGET_TOOL, "mcp__omp__show_widget", "mcp:omp.show_widget"]);

export function isShowWidgetTool(name: string): boolean {
  return SHOW_WIDGET_NAMES.has(name);
}

export interface Widget {
  /** snake_case as written, or null; the UI humanises it. */
  title: string | null;
  /** A height hint in px, from the metadata. */
  height: number | null;
  code: string;
  kind: "html" | "svg";
  loadingMessages: readonly string[];
}

export type WidgetParse =
  | { status: "streaming"; title: string | null; loadingMessages: readonly string[] }
  | { status: "too_large"; code: string }
  | ({ status: "ready" } & Widget);

function byteLength(text: string): number {
  // UTF-8 length without TextEncoder, so this runs anywhere.
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff) {
      n += 4;
      i++;
    } else n += 3;
  }
  return n;
}

interface Meta {
  title: string | null;
  height: number | null;
  loadingMessages: readonly string[];
}

const NO_META: Meta = { title: null, height: null, loadingMessages: [] };

function readMeta(raw: unknown): Meta {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return NO_META;
  const r = raw as Record<string, unknown>;
  const title = typeof r.title === "string" && r.title.trim() ? r.title.trim().slice(0, 120) : null;
  const height =
    typeof r.height === "number" && Number.isFinite(r.height) && r.height > 0 ? Math.round(r.height) : null;
  const loading = r.loading_messages ?? r.loadingMessages;
  const loadingMessages = Array.isArray(loading)
    ? loading.filter((m): m is string => typeof m === "string" && m.trim() !== "").slice(0, 10)
    : [];
  return { title, height, loadingMessages };
}

/** Splits the metadata line off the front, if there is one. */
function splitMeta(source: string): { meta: Meta; code: string } {
  const text = source.replace(/^﻿/, "");
  if (!text.trimStart().startsWith("{")) return { meta: NO_META, code: text };
  const sep = /^---[ \t]*$/m.exec(text);
  if (!sep) return { meta: NO_META, code: text };
  const head = text.slice(0, sep.index);
  const code = text.slice(sep.index + sep[0].length).replace(/^\r?\n/, "");
  try {
    return { meta: readMeta(JSON.parse(head)), code };
  } catch {
    // Not metadata after all: the whole thing is the widget.
    return { meta: NO_META, code: text };
  }
}

function kindOf(code: string): "html" | "svg" {
  const head = code.trimStart().replace(/^<\?xml[^>]*\?>\s*/i, "");
  return /^<svg[\s>]/i.test(head) ? "svg" : "html";
}

/**
 * A ```widget fence's body, read. `closed` is false while the answer is
 * still streaming and the closing fence has not arrived: the frame must not
 * run half a page, so only the metadata (for the placeholder) is read.
 */
export function parseWidgetFence(source: string, { closed }: { closed: boolean }): WidgetParse {
  if (!closed) {
    const { meta } = splitMeta(source);
    return { status: "streaming", title: meta.title, loadingMessages: meta.loadingMessages };
  }
  return readyWidget(source, NO_META);
}

function readyWidget(source: string, fallback: Meta): WidgetParse {
  if (byteLength(source) > WIDGET_MAX_BYTES) return { status: "too_large", code: source };
  const { meta, code } = splitMeta(source);
  const merged: Meta = {
    title: meta.title ?? fallback.title,
    height: meta.height ?? fallback.height,
    loadingMessages: meta.loadingMessages.length ? meta.loadingMessages : fallback.loadingMessages,
  };
  return { status: "ready", ...merged, code: code.trim(), kind: kindOf(code) };
}

/**
 * A `show_widget` call's input as a widget, or null when the call is not
 * one. `{ title, widget_code, loading_messages? }`; the code may itself carry
 * a metadata line, which wins.
 */
export function widgetFromToolUse(name: string, input: unknown): WidgetParse | null {
  if (!isShowWidgetTool(name)) return null;
  if (typeof input !== "object" || input === null) return null;
  const r = input as Record<string, unknown>;
  const code = typeof r.widget_code === "string" ? r.widget_code : typeof r.code === "string" ? r.code : null;
  const meta = readMeta(r);
  if (code === null) return { status: "streaming", title: meta.title, loadingMessages: meta.loadingMessages };
  return readyWidget(code, meta);
}

/** A short stable id for a widget's code: FNV-1a, base 36. */
export function widgetId(code: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < code.length; i++) {
    h ^= code.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `w${(h >>> 0).toString(36)}${code.length.toString(36)}`;
}

/** `hosting_cost_calculator` → "Hosting cost calculator". */
export function humaniseWidgetTitle(title: string | null | undefined): string {
  const text = (title ?? "").replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
  if (!text) return "Widget";
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** A file name for the download: `hosting_cost_calculator.html`. */
export function widgetFileName(title: string | null | undefined): string {
  const base = (title ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
  return `${base || "widget"}.html`;
}
