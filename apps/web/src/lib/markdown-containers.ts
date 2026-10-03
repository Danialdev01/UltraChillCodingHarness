/**
 * Container blocks -- callouts, toggles, columns -- in Markdown.
 *
 * Markdown has no syntax for them, so they travel as the HTML GitHub
 * renders: a `<div data-type="…">` (or `<details>`) around ordinary
 * Markdown. Reading that back needs the matching close tag, with nesting
 * respected, which is what these helpers find. Pure, so the shapes are
 * tested without the editor.
 */

export interface HtmlContainer {
  /** The whole thing, open tag to close tag. */
  raw: string;
  attrs: Record<string, string>;
  /** What is between the tags. */
  inner: string;
}

/**
 * The container at the start of `src`, if one opens there: `<tag …>` up to
 * the `</tag>` that balances it. With `dataType`, only a tag whose
 * `data-type` is that.
 */
export function matchHtmlContainer(
  src: string,
  tag: string,
  dataType?: string,
): HtmlContainer | null {
  const open = new RegExp(`^<${tag}(\\s[^>]*)?>`, "i").exec(src);
  if (!open) return null;
  const attrs = parseAttrs(open[1] ?? "");
  if (dataType !== undefined && attrs["data-type"] !== dataType) return null;

  // Walk the rest counting opens and closes of the same tag.
  const tokens = new RegExp(`<${tag}(?:\\s[^>]*)?>|</${tag}\\s*>`, "gi");
  tokens.lastIndex = open[0].length;
  let depth = 1;
  for (let match = tokens.exec(src); match; match = tokens.exec(src)) {
    depth += match[0].startsWith("</") ? -1 : 1;
    if (depth === 0) {
      const raw = src.slice(0, match.index + match[0].length);
      return { raw, attrs, inner: src.slice(open[0].length, match.index) };
    }
  }
  return null;
}

/** Each `<div data-type="column">…</div>` directly inside a columns block. */
export function splitColumns(inner: string): string[] {
  const columns: string[] = [];
  let rest = inner;
  for (;;) {
    const at = rest.search(/<div\s[^>]*data-type="column"[^>]*>/i);
    if (at === -1) break;
    const column = matchHtmlContainer(rest.slice(at), "div", "column");
    if (!column) break;
    columns.push(column.inner.trim());
    rest = rest.slice(at + column.raw.length);
  }
  return columns;
}

/** An open tag with the attributes given; null and undefined values are left out. */
export function containerOpen(
  tag: string,
  attrs: Record<string, string | number | boolean | null | undefined>,
): string {
  const parts = Object.entries(attrs)
    .filter(([, v]) => v !== null && v !== undefined && v !== false)
    .map(([k, v]) => (v === true ? k : `${k}="${escapeAttr(String(v))}"`));
  return `<${tag}${parts.length ? " " + parts.join(" ") : ""}>`;
}

/** The attributes of an open tag, unescaped. Bare attributes are `""`. */
export function parseAttrs(source: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([\w:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  for (let m = re.exec(source); m; m = re.exec(source)) {
    attrs[m[1]!.toLowerCase()] = unescapeAttr(m[2] ?? m[3] ?? m[4] ?? "");
  }
  return attrs;
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

function unescapeAttr(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}
