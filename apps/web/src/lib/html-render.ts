/**
 * Live HTML in a chat answer: a fenced ```html-render block runs as a page.
 *
 * After t3code's `html_render`. The model writes a self-contained page --
 * a chart, a diagram, a small interactive mockup -- and the chat shows the
 * page rather than its source. The page runs in a sandboxed `srcdoc` frame
 * with `allow-scripts` and nothing else: an opaque origin, so it can run its
 * own JavaScript but cannot read this app's cookies, storage or DOM, and
 * cannot navigate the app. What it can do is post two messages to its
 * parent: its height, so the frame fits it, and a link the reader clicked,
 * which the parent opens in a new tab.
 *
 * Pure, so the shapes are tested without a browser.
 */

/** The fence languages that render. `html-render` is the one the prompt teaches. */
export const HTML_RENDER_LANGUAGES = new Set(["html-render", "html-preview", "render"]);

export function isHtmlRenderLanguage(language: string | null | undefined): boolean {
  return language != null && HTML_RENDER_LANGUAGES.has(language.toLowerCase());
}

export const HTML_RENDER_MIN_HEIGHT = 48;
export const HTML_RENDER_MAX_HEIGHT = 1600;
/** Until the page reports its height. */
export const HTML_RENDER_DEFAULT_HEIGHT = 160;

/**
 * The app's colour tokens handed to the page, so a chart drawn with
 * `var(--chart-1)` on `var(--background)` matches the chat around it. Read
 * live off <html> because a chosen palette is painted there inline.
 */
export const HTML_RENDER_TOKENS = [
  "--background",
  "--foreground",
  "--card",
  "--card-foreground",
  "--popover",
  "--popover-foreground",
  "--primary",
  "--primary-foreground",
  "--secondary",
  "--secondary-foreground",
  "--muted",
  "--muted-foreground",
  "--accent",
  "--accent-foreground",
  "--destructive",
  "--border",
  "--input",
  "--ring",
  "--danger",
  "--warning",
  "--success",
  "--info",
  "--chart-1",
  "--chart-2",
  "--chart-3",
  "--chart-4",
  "--chart-5",
  "--chart-6",
  "--radius",
  "--app-font-sans",
  "--app-font-mono",
] as const;

export interface HtmlRenderTheme {
  mode: "light" | "dark";
  variables: Record<string, string>;
}

/** Message type tags; namespaced so nothing else posting to the window is mistaken for one. */
const SIZE = "ucch-html-render:size";
const LINK = "ucch-html-render:link";
const THEME = "ucch-html-render:theme";

/** A token value that cannot close the rule it is written into. */
function safeValue(value: string): string {
  return value.replace(/[;{}<>]/g, "").trim();
}

export function themeCss(theme: HtmlRenderTheme): string {
  const vars = Object.entries(theme.variables)
    .filter(([name]) => /^--[a-z0-9-]+$/.test(name))
    .map(([name, value]) => `${name}:${safeValue(value)};`)
    .join("");
  // `--font-*` aliases so a page can use the names it would guess.
  return (
    `:root{color-scheme:${theme.mode === "dark" ? "dark" : "light"};${vars}` +
    `--font-sans:var(--app-font-sans,system-ui,sans-serif);--font-mono:var(--app-font-mono,ui-monospace,monospace)}`
  );
}

/**
 * The base sheet: the page sits on the chat's own ground with the app's text
 * and font, and no scrollbar -- the frame grows to the page instead.
 */
const BASE_CSS =
  "html{background:var(--background);color:var(--foreground);font-family:var(--font-sans);font-size:14px;line-height:1.5;-webkit-font-smoothing:antialiased;scrollbar-width:none}" +
  "html::-webkit-scrollbar{display:none}body{margin:0;padding:8px}code,kbd,pre,samp{font-family:var(--font-mono)}";

/**
 * Network rules for the page. Scripts and styles may come from any https
 * CDN (a chart library is the common case), inline code runs, but `fetch`,
 * XHR and sockets go nowhere and forms submit nowhere: a page drawn from a
 * model's answer has no business calling out.
 */
const PAGE_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline' 'unsafe-eval' https: blob:",
  "style-src 'unsafe-inline' https:",
  "img-src https: data: blob:",
  "font-src https: data:",
  "media-src https: data: blob:",
  "connect-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
].join("; ");

/**
 * Runs before the page's own code: reports the document's height whenever it
 * changes, sends link clicks to the parent, and swaps the theme rule when the
 * app's mode changes, so a toggle does not reload the page and lose its state.
 */
const BOOTSTRAP = `(function(){
var P=window.parent,last=-1;
function size(){var r=document.documentElement,h=Math.ceil(r.scrollHeight>r.clientHeight?r.scrollHeight:r.getBoundingClientRect().height);if(h!==last){last=h;P.postMessage({type:${JSON.stringify(SIZE)},height:h},"*");}}
if(window.ResizeObserver){var o=new ResizeObserver(size);o.observe(document.documentElement);document.addEventListener("DOMContentLoaded",function(){if(document.body)o.observe(document.body);});}
document.addEventListener("DOMContentLoaded",size);window.addEventListener("load",size);setTimeout(size,0);
document.addEventListener("click",function(e){if(!e.isTrusted||e.defaultPrevented)return;var a=e.target&&e.target.closest?e.target.closest("a[href]"):null;if(!a)return;var u;try{u=new URL(a.getAttribute("href"),document.baseURI);}catch(x){return;}if(!/^https?:$/.test(u.protocol))return;e.preventDefault();P.postMessage({type:${JSON.stringify(LINK)},url:u.href},"*");});
window.addEventListener("message",function(e){var d=e.data;if(e.source!==P||!d||d.type!==${JSON.stringify(THEME)}||typeof d.css!=="string")return;var s=document.getElementById("ucch-theme");if(s)s.textContent=d.css;});
})();`;

/** What goes in front of the page's own markup, inside <head>. */
function headMarkup(theme: HtmlRenderTheme): string {
  return (
    `<meta charset="utf-8">` +
    `<meta http-equiv="Content-Security-Policy" content="${PAGE_CSP}">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<style id="ucch-theme">${themeCss(theme)}</style>` +
    `<style>${BASE_CSS}</style>` +
    `<script>${BOOTSTRAP}</script>`
  );
}

/**
 * The model's page with the bootstrap in front of everything it wrote.
 *
 * A full document gets the head markup right after its `<head>` (or after
 * `<html>`/the doctype when it has none); a fragment -- `<canvas>` and a
 * `<script>` -- is wrapped in a document. The theme rule comes first so the
 * page's own `:root` rules win where it sets its own colours.
 */
export function buildHtmlRenderDocument(source: string, theme: HtmlRenderTheme): string {
  const head = headMarkup(theme);
  // Only the first stretch is searched, and only outside script and comments,
  // so a `<head>` inside a string in the page's code is not mistaken for one.
  const scan = source
    .slice(0, 8192)
    .replace(/<!--[\s\S]*?(?:-->|$)|<(script|style|textarea)\b[\s\S]*?(?:<\/\1\s*>|$)/gi, (m) => " ".repeat(m.length));
  const headOpen = /<head(?:\s[^>]*)?>/i.exec(scan);
  if (headOpen) {
    const at = headOpen.index + headOpen[0].length;
    return source.slice(0, at) + head + source.slice(at);
  }
  const htmlOpen = /<html(?:\s[^>]*)?>/i.exec(scan);
  if (htmlOpen) {
    const at = htmlOpen.index + htmlOpen[0].length;
    return `${source.slice(0, at)}<head>${head}</head>${source.slice(at)}`;
  }
  const doctype = /^\s*<!doctype[^>]*>/i.exec(scan);
  if (doctype) {
    const at = doctype[0].length;
    return `${source.slice(0, at)}<head>${head}</head>${source.slice(at)}`;
  }
  return `<!doctype html><html><head>${head}</head><body>${source}</body></html>`;
}

export function themeMessage(theme: HtmlRenderTheme) {
  return { type: THEME, css: themeCss(theme) } as const;
}

/** The page's reported height, clamped, or undefined if this is not one. */
export function readSizeMessage(data: unknown): number | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const { type, height } = data as Record<string, unknown>;
  if (type !== SIZE || typeof height !== "number" || !Number.isFinite(height)) return undefined;
  return Math.min(HTML_RENDER_MAX_HEIGHT, Math.max(HTML_RENDER_MIN_HEIGHT, Math.ceil(height)));
}

/** An http(s) link the reader clicked in the page, or undefined. */
export function readLinkMessage(data: unknown): string | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const { type, url } = data as Record<string, unknown>;
  if (type !== LINK || typeof url !== "string") return undefined;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.href : undefined;
  } catch {
    return undefined;
  }
}

/** The page's `<title>`, if it has one, for the block's header. */
export function htmlRenderTitle(source: string): string | null {
  const match = /<title[^>]*>([\s\S]*?)<\/title\s*>/i.exec(source.slice(0, 8192));
  const title = match?.[1]?.replace(/\s+/g, " ").trim();
  return title ? title.slice(0, 120) : null;
}
