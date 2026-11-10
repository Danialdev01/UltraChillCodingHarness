/**
 * Inline widgets in a chat answer: a ```widget fence or a `show_widget`
 * call, run as a live page in the message (see `@ucch/protocol` widgets.ts
 * for the format, and what the agent is told).
 *
 * After t3code's inline visualiser. The page runs in a sandboxed `srcdoc`
 * frame with `allow-scripts` and nothing else: an opaque origin, so it can
 * run its own JavaScript but cannot read this app's cookies, storage or DOM,
 * and cannot navigate the app, open popups or submit forms. Its CSP lets it
 * load scripts only from the CDN allowlist and gives it no network at all
 * otherwise. What it can do is post a few messages to its parent, each
 * tagged with the frame's id: its height, an error it threw, a link the
 * reader clicked, and a follow-up prompt (`sendPrompt`).
 *
 * Pure, so the shapes are tested without a browser.
 */
import { WIDGET_CDN_ALLOWLIST, type Widget } from "@ucch/protocol/plain";

/** The iframe's sandbox attribute. Never `allow-same-origin`, `allow-top-navigation`, `allow-popups` or `allow-forms`. */
export const WIDGET_SANDBOX = "allow-scripts";

/** Low, because no box is drawn around a widget: a taller floor shows as a gap under a short one. */
export const WIDGET_MIN_HEIGHT = 40;
/** Inline; the frame scrolls beyond this. Fullscreen has no cap. */
export const WIDGET_MAX_HEIGHT = 900;
/** Until the page reports its height. */
export const WIDGET_DEFAULT_HEIGHT = 200;
/** The longest follow-up a widget may put in the composer. */
export const WIDGET_PROMPT_MAX = 4000;
const ERROR_MAX = 500;

/**
 * The app's colour tokens handed to the page, so a chart drawn with
 * `var(--chart-1)` on `var(--card)` matches the chat around it. Read live off
 * <html> because a chosen palette is painted there inline.
 */
export const WIDGET_TOKENS = [
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

export interface WidgetTheme {
  mode: "light" | "dark";
  variables: Record<string, string>;
}

/** Message type tags; namespaced so nothing else posting to the window is mistaken for one. */
const RESIZE = "ucch-widget:resize";
const ERROR = "ucch-widget:error";
const PROMPT = "ucch-widget:prompt";
const LINK = "ucch-widget:link";
const THEME = "ucch-widget:theme";

/** A token value that cannot close the rule it is written into. */
function safeValue(value: string): string {
  return value.replace(/[;{}<>]/g, "").trim();
}

/**
 * The app's `--muted` and `--accent` are pale background tones, but a page
 * written to the prompt uses `--muted` for secondary text and `--accent` for
 * a highlight. Those names take the prompt's meaning; the app's tones move.
 */
const RENAMED: Record<string, string> = {
  "--muted": "--muted-bg",
  "--accent": "--accent-bg",
  "--accent-foreground": "--accent-bg-foreground",
};

export function themeCss(theme: WidgetTheme): string {
  const vars = Object.entries(theme.variables)
    .filter(([name]) => /^--[a-z0-9-]+$/.test(name))
    .map(([name, value]) => `${RENAMED[name] ?? name}:${safeValue(value)};`)
    .join("");
  // Short aliases (the names the prompt teaches) and `--font-*`, so a page
  // can use the names it would guess. The page's own `:root` rules win.
  return (
    `:root{color-scheme:${theme.mode === "dark" ? "dark" : "light"};${vars}` +
    "--bg:var(--background);--fg:var(--foreground);--muted:var(--muted-foreground);--muted-fg:var(--muted-foreground);" +
    "--accent:var(--primary);--accent-fg:var(--primary-foreground);" +
    `--font-sans:var(--app-font-sans,system-ui,sans-serif);--font-mono:var(--app-font-mono,ui-monospace,monospace)}`
  );
}

/**
 * The base sheet: a transparent page with the app's text and font, border-box
 * sizing, and no scrollbar -- the frame grows to the page instead.
 */
const BASE_CSS =
  "*,*::before,*::after{box-sizing:border-box}" +
  "html{background:transparent;color:var(--foreground);font-family:var(--font-sans);font-size:14px;line-height:1.5;-webkit-font-smoothing:antialiased;scrollbar-width:none}" +
  "html::-webkit-scrollbar{display:none}body{margin:0;padding:4px 2px;background:transparent}code,kbd,pre,samp{font-family:var(--font-mono)}" +
  ".ucch-svg{display:flex;justify-content:center}.ucch-svg>svg{max-width:100%;height:auto}";

/** A CSP source list entry that cannot break out of the attribute or the directive. */
function cspSource(origin: string): string | null {
  return /^https:\/\/[a-z0-9.-]+(?::\d+)?(?:\/[\w./-]*)?$/i.test(origin) ? origin : null;
}

/**
 * Network rules for the page. Inline code runs, and scripts may load from the
 * allowlisted CDN (Chart.js, D3, Mermaid); `fetch`, XHR and sockets go
 * nowhere, forms submit nowhere, and there is no `eval`. A page drawn from a
 * model's answer has no business calling out.
 */
export function widgetCsp(cdnAllowlist: readonly string[] = WIDGET_CDN_ALLOWLIST): string {
  const cdn = cdnAllowlist.map(cspSource).filter((s): s is string => s !== null);
  return [
    "default-src 'none'",
    ["script-src 'unsafe-inline'", ...cdn].join(" "),
    "style-src 'unsafe-inline'",
    "img-src data: blob:",
    "font-src data:",
    "connect-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
  ].join("; ");
}

/**
 * Runs before the page's own code: reports the document's height whenever it
 * changes, reports errors, sends link clicks and `sendPrompt` to the parent,
 * and swaps the theme rule when the app's mode changes, so a toggle does not
 * reload the page and lose its state. Everything it posts carries the id.
 * The height is the content's, never `<html>`'s scrollHeight: that is at
 * least the frame's own height, so a frame could grow but never shrink.
 */
function bootstrap(id: string): string {
  const ID = JSON.stringify(id);
  return `(function(){
var P=window.parent,ID=${ID},last=-1;
function post(m){m.id=ID;try{P.postMessage(m,"*");}catch(x){}}
function size(){var r=document.documentElement,b=document.body,s=b?getComputedStyle(b):null,h=Math.ceil(Math.max(r.getBoundingClientRect().height,b?b.scrollHeight+parseFloat(s.marginTop)+parseFloat(s.marginBottom):0));if(h!==last){last=h;post({type:${JSON.stringify(RESIZE)},height:h});}}
if(window.ResizeObserver){var o=new ResizeObserver(size);o.observe(document.documentElement);document.addEventListener("DOMContentLoaded",function(){if(document.body)o.observe(document.body);});}
document.addEventListener("DOMContentLoaded",size);window.addEventListener("load",size);setTimeout(size,0);
function fail(m){post({type:${JSON.stringify(ERROR)},message:String(m||"Unknown error").slice(0,${ERROR_MAX})});}
window.addEventListener("error",function(e){if(e&&e.target&&e.target!==window&&e.target.tagName){fail("Could not load "+(e.target.src||e.target.tagName));return;}fail(e&&e.message?e.message:"Script error");},true);
window.addEventListener("unhandledrejection",function(e){var r=e&&e.reason;fail(r&&r.message?r.message:r);});
window.addEventListener("securitypolicyviolation",function(e){fail("Blocked by the widget sandbox: "+e.violatedDirective+" "+(e.blockedURI||""));});
window.sendPrompt=function(t){if(typeof t!=="string"||!t.trim())return;post({type:${JSON.stringify(PROMPT)},text:t.slice(0,${WIDGET_PROMPT_MAX})});};
document.addEventListener("click",function(e){if(!e.isTrusted||e.defaultPrevented)return;var a=e.target&&e.target.closest?e.target.closest("a[href]"):null;if(!a)return;var u;try{u=new URL(a.getAttribute("href"),document.baseURI);}catch(x){return;}if(!/^https?:$/.test(u.protocol))return;e.preventDefault();post({type:${JSON.stringify(LINK)},url:u.href});});
window.addEventListener("message",function(e){var d=e.data;if(e.source!==P||!d||d.type!==${JSON.stringify(THEME)}||typeof d.css!=="string")return;var s=document.getElementById("ucch-theme");if(s)s.textContent=d.css;});
})();`;
}

/** `</script` inside the id would end the bootstrap early; ids are ours, but be sure. */
function safeId(id: string): string {
  return id.replace(/[^\w-]/g, "");
}

function headMarkup(theme: WidgetTheme, id: string, cdnAllowlist: readonly string[]): string {
  return (
    `<meta charset="utf-8">` +
    `<meta http-equiv="Content-Security-Policy" content="${widgetCsp(cdnAllowlist)}">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<style id="ucch-theme">${themeCss(theme)}</style>` +
    `<style>${BASE_CSS}</style>` +
    `<script>${bootstrap(safeId(id))}</script>`
  );
}

/**
 * The widget as a document with the CSP and bootstrap in front of everything
 * it wrote.
 *
 * A fragment (what the prompt asks for) is wrapped in a document; SVG is
 * centred and scaled to the width. A full document -- which older
 * ```html-render answers wrote -- gets the head markup right after its
 * `<head>` (or after `<html>`/the doctype when it has none). The CSP comes
 * first, so it is in force before any of the page's own markup.
 */
export function buildWidgetDocument(
  widget: Pick<Widget, "code" | "kind">,
  theme: WidgetTheme,
  id: string,
  cdnAllowlist: readonly string[] = WIDGET_CDN_ALLOWLIST,
): string {
  const head = headMarkup(theme, id, cdnAllowlist);
  const source = widget.code;
  if (widget.kind === "svg") {
    return `<!doctype html><html><head>${head}</head><body><div class="ucch-svg">${source}</div></body></html>`;
  }
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

/**
 * A standalone `.html` for the Download button: the same document with the
 * theme frozen as it is now, opaque background, and the bridge inert (no
 * parent to talk to). The CSP stays, so the file behaves as it did in chat.
 */
export function standaloneWidgetHtml(
  widget: Pick<Widget, "code" | "kind" | "title">,
  theme: WidgetTheme,
  cdnAllowlist: readonly string[] = WIDGET_CDN_ALLOWLIST,
): string {
  const doc = buildWidgetDocument(widget, theme, "standalone", cdnAllowlist);
  const title = (widget.title ?? "widget").replace(/[<>&"]/g, "");
  const extra = `<title>${title}</title><style>html{background:var(--background)}</style>`;
  return doc.replace("</head>", `${extra}</head>`);
}

export function themeMessage(theme: WidgetTheme) {
  return { type: THEME, css: themeCss(theme) } as const;
}

export type WidgetMessage =
  | { type: "resize"; height: number }
  | { type: "error"; message: string }
  | { type: "prompt"; text: string }
  | { type: "link"; url: string };

function clampHeight(height: number): number {
  return Math.min(WIDGET_MAX_HEIGHT, Math.max(WIDGET_MIN_HEIGHT, Math.ceil(height)));
}

/**
 * A message from the frame with this id, read and checked, or undefined.
 * Unknown types, another frame's id and malformed fields are all ignored.
 * The caller has already checked `event.source` is the frame's window.
 */
export function readWidgetMessage(data: unknown, id: string): WidgetMessage | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const d = data as Record<string, unknown>;
  if (d.id !== safeId(id)) return undefined;
  switch (d.type) {
    case RESIZE:
      return typeof d.height === "number" && Number.isFinite(d.height)
        ? { type: "resize", height: Math.max(0, Math.ceil(d.height)) }
        : undefined;
    case ERROR:
      return typeof d.message === "string" ? { type: "error", message: d.message.slice(0, ERROR_MAX) } : undefined;
    case PROMPT: {
      if (typeof d.text !== "string") return undefined;
      const text = d.text.trim();
      return text && text.length <= WIDGET_PROMPT_MAX ? { type: "prompt", text } : undefined;
    }
    case LINK: {
      if (typeof d.url !== "string") return undefined;
      try {
        const parsed = new URL(d.url);
        return parsed.protocol === "http:" || parsed.protocol === "https:" ? { type: "link", url: parsed.href } : undefined;
      } catch {
        return undefined;
      }
    }
    default:
      return undefined;
  }
}

/** The inline frame height for a reported content height. */
export function inlineHeight(reported: number): number {
  return clampHeight(reported);
}

/** The composer text the "Ask AI to fix" button puts in. */
export function fixPrompt(title: string, error: string): string {
  return `The widget "${title}" failed with: ${error}. Please fix it.`;
}

/** The page's `<title>`, if it has one -- older html-render pages carry their name there. */
export function documentTitle(source: string): string | null {
  const match = /<title[^>]*>([\s\S]*?)<\/title\s*>/i.exec(source.slice(0, 8192));
  const title = match?.[1]?.replace(/\s+/g, " ").trim();
  return title ? title.slice(0, 120) : null;
}

/**
 * Whether a fence whose source spans `[start, end)` of `text` has its
 * closing fence yet. While an answer streams, an unclosed fence runs to the
 * end of the text; its last line is content, not a matching marker.
 */
export function isFenceClosed(text: string, start: number | undefined, end: number | undefined): boolean {
  if (start === undefined || end === undefined) return false;
  const block = text.slice(start, end).replace(/\s+$/, "");
  const lines = block.split("\n");
  if (lines.length < 2) return false;
  const open = /^ {0,3}(`{3,}|~{3,})/.exec(lines[0]!)?.[1];
  const close = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(lines[lines.length - 1]!)?.[1];
  return !!open && !!close && close[0] === open[0] && close.length >= open.length;
}
