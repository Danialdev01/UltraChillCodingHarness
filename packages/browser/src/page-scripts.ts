/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
/**
 * Functions that run inside the page, through `page.evaluate`.
 *
 * Each is serialised on its own, so each is self-contained: no imports, no
 * closures over this module, helpers declared inside. They read the DOM and
 * computed styles and hand back plain JSON.
 */

export type ExtractFormat = "markdown" | "text" | "links" | "tables" | "meta" | "html";

/** Scrapes the page (or `selector`) in one of the extract formats. */
export function extractInPage(args: { format: ExtractFormat; selector: string | null }): unknown {
  const root: Element | null = args.selector ? document.querySelector(args.selector) : document.body;
  if (!root) return { error: `nothing matches ${args.selector}` };
  const abs = (href: string | null) => {
    if (!href) return "";
    try {
      return new URL(href, document.baseURI).href;
    } catch {
      return href;
    }
  };
  const visible = (el: Element) => {
    const style = getComputedStyle(el);
    return style.display !== "none" && style.visibility !== "hidden";
  };

  switch (args.format) {
    case "text":
      return (root as HTMLElement).innerText ?? root.textContent ?? "";
    case "html":
      return root.outerHTML;
    case "links": {
      const seen = new Set<string>();
      const links: { text: string; href: string }[] = [];
      for (const a of Array.from(root.querySelectorAll("a[href]"))) {
        const href = abs(a.getAttribute("href"));
        if (!href || href.startsWith("javascript:") || seen.has(href)) continue;
        seen.add(href);
        const text = ((a as HTMLElement).innerText || a.getAttribute("aria-label") || a.getAttribute("title") || "").trim().replace(/\s+/g, " ");
        links.push({ text: text.slice(0, 200), href });
      }
      return links;
    }
    case "tables":
      return Array.from(root.querySelectorAll("table")).map((table, index) => {
        const caption = table.querySelector("caption")?.textContent?.trim() ?? null;
        const rows = Array.from(table.querySelectorAll("tr")).map((tr) =>
          Array.from(tr.querySelectorAll("th,td")).map((cell) => ((cell as HTMLElement).innerText ?? "").trim().replace(/\s+/g, " ")),
        );
        return { index, caption, rows };
      });
    case "meta": {
      const meta: Record<string, string> = {};
      for (const el of Array.from(document.querySelectorAll("meta[name],meta[property]"))) {
        const key = el.getAttribute("name") ?? el.getAttribute("property");
        const value = el.getAttribute("content");
        if (key && value) meta[key] = value.slice(0, 500);
      }
      const headings = Array.from(root.querySelectorAll("h1,h2,h3,h4"))
        .filter(visible)
        .slice(0, 80)
        .map((h) => `${"  ".repeat(Number(h.tagName[1]) - 1)}${h.tagName.toLowerCase()}: ${(h.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 160)}`);
      return {
        title: document.title,
        url: location.href,
        lang: document.documentElement.lang || null,
        canonical: abs(document.querySelector("link[rel=canonical]")?.getAttribute("href") ?? null) || null,
        icons: Array.from(document.querySelectorAll("link[rel~=icon]")).map((l) => abs(l.getAttribute("href"))).slice(0, 6),
        meta,
        headings,
      };
    }
    case "markdown": {
      const SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "SVG", "CANVAS", "IFRAME", "HEAD"]);
      const out: string[] = [];
      const inline = (node: Node): string => {
        if (node.nodeType === Node.TEXT_NODE) return (node.textContent ?? "").replace(/\s+/g, " ");
        if (node.nodeType !== Node.ELEMENT_NODE) return "";
        const el = node as HTMLElement;
        if (SKIP.has(el.tagName) || !visible(el)) return "";
        const inner = Array.from(el.childNodes).map(inline).join("");
        switch (el.tagName) {
          case "A": {
            const href = abs(el.getAttribute("href"));
            return href && inner.trim() ? `[${inner.trim()}](${href})` : inner;
          }
          case "STRONG":
          case "B":
            return inner.trim() ? `**${inner.trim()}**` : "";
          case "EM":
          case "I":
            return inner.trim() ? `_${inner.trim()}_` : "";
          case "CODE":
            return inner.trim() ? `\`${inner.trim()}\`` : "";
          case "IMG": {
            const alt = el.getAttribute("alt") ?? "";
            return `![${alt}](${abs(el.getAttribute("src"))})`;
          }
          case "BR":
            return "\n";
          default:
            return inner;
        }
      };
      const BLOCK = /^(P|DIV|SECTION|ARTICLE|MAIN|HEADER|FOOTER|NAV|ASIDE|UL|OL|LI|H[1-6]|PRE|BLOCKQUOTE|TABLE|FIGURE|FORM|DL|DT|DD|HR)$/;
      const block = (el: Element, depth: number) => {
        if (SKIP.has(el.tagName) || !visible(el)) return;
        const tag = el.tagName;
        if (/^H[1-6]$/.test(tag)) {
          out.push(`${"#".repeat(Number(tag[1]))} ${inline(el).trim()}`);
          return;
        }
        if (tag === "PRE") {
          out.push("```\n" + ((el as HTMLElement).innerText ?? "").trimEnd() + "\n```");
          return;
        }
        if (tag === "HR") return void out.push("---");
        if (tag === "BLOCKQUOTE") return void out.push(`> ${inline(el).trim().replace(/\n/g, "\n> ")}`);
        if (tag === "UL" || tag === "OL") {
          let n = 1;
          for (const li of Array.from(el.children)) {
            if (li.tagName !== "LI") continue;
            const nested = Array.from(li.children).filter((c) => c.tagName === "UL" || c.tagName === "OL");
            const own = Array.from(li.childNodes).filter((c) => !nested.includes(c as Element)).map(inline).join("").trim();
            out.push(`${"  ".repeat(depth)}${tag === "OL" ? `${n++}.` : "-"} ${own}`);
            for (const list of nested) block(list, depth + 1);
          }
          return;
        }
        if (tag === "TABLE") {
          const rows = Array.from(el.querySelectorAll("tr")).map((tr) =>
            Array.from(tr.querySelectorAll("th,td")).map((c) => inline(c).trim().replace(/\|/g, "\\|")),
          );
          if (rows.length === 0) return;
          const width = Math.max(...rows.map((r) => r.length));
          const line = (r: string[]) => `| ${Array.from({ length: width }, (_, i) => r[i] ?? "").join(" | ")} |`;
          out.push([line(rows[0]!), `|${" --- |".repeat(width)}`, ...rows.slice(1).map(line)].join("\n"));
          return;
        }
        const hasBlockChild = Array.from(el.children).some((c) => BLOCK.test(c.tagName));
        if (!hasBlockChild) {
          const text = inline(el).trim();
          if (text) out.push(text);
          return;
        }
        // Mixed content: inline runs between block children become paragraphs.
        let run = "";
        for (const child of Array.from(el.childNodes)) {
          if (child.nodeType === Node.ELEMENT_NODE && BLOCK.test((child as Element).tagName)) {
            if (run.trim()) out.push(run.trim());
            run = "";
            block(child as Element, depth);
          } else run += inline(child);
        }
        if (run.trim()) out.push(run.trim());
      };
      block(root, 0);
      return out.join("\n\n").replace(/\n{3,}/g, "\n\n");
    }
  }
}

export interface DesignNode {
  tag: string;
  id?: string;
  cls?: string;
  role?: string;
  box: [number, number, number, number];
  layout?: string;
  text?: string;
  children?: DesignNode[];
}

/** The design system a page actually uses, read from computed styles. */
export function designInPage(args: { selector: string | null; depth: number }): unknown {
  const root: Element | null = args.selector ? document.querySelector(args.selector) : document.body;
  if (!root) return { error: `nothing matches ${args.selector}` };
  const MAX_ELEMENTS = 4000;
  const MAX_NODES = 500;

  const tally = <K extends string>(map: Map<K, number>, key: K | null | undefined, weight = 1) => {
    if (!key) return;
    map.set(key, (map.get(key) ?? 0) + weight);
  };
  const top = <K>(map: Map<K, number>, n: number) =>
    [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([value, count]) => ({ value, count }));

  const toHex = (color: string): string | null => {
    const m = /rgba?\(([^)]+)\)/.exec(color);
    if (!m) return null;
    const parts = m[1]!.split(/[ ,/]+/).filter(Boolean).map(Number);
    const [r = 0, g = 0, b = 0] = parts;
    const a = parts.length > 3 ? parts[3]! : 1;
    if (a === 0) return null;
    const hex = `#${[r, g, b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`;
    return a < 1 ? `${hex}${Math.round(a * 255).toString(16).padStart(2, "0")}` : hex;
  };

  const text = new Map<string, number>();
  const backgrounds = new Map<string, number>();
  const borders = new Map<string, number>();
  const families = new Map<string, number>();
  const typeScale = new Map<string, number>();
  const spacing = new Map<string, number>();
  const radii = new Map<string, number>();
  const shadows = new Map<string, number>();
  const gradients = new Map<string, number>();

  const elements = [root, ...Array.from(root.querySelectorAll("*"))].slice(0, MAX_ELEMENTS);
  for (const el of elements) {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) continue;
    const s = getComputedStyle(el);
    if (s.display === "none" || s.visibility === "hidden") continue;
    const area = Math.min(50, Math.max(1, Math.round((rect.width * rect.height) / 20000)));
    const ownText = Array.from(el.childNodes).some((n) => n.nodeType === Node.TEXT_NODE && (n.textContent ?? "").trim());
    if (ownText) {
      tally(text, toHex(s.color));
      tally(families, s.fontFamily.split(",")[0]!.trim().replace(/["']/g, ""));
      tally(typeScale, `${s.fontSize}/${s.lineHeight} ${s.fontWeight}${s.letterSpacing !== "normal" ? ` ls ${s.letterSpacing}` : ""} ${el.tagName.toLowerCase()}`);
    }
    tally(backgrounds, toHex(s.backgroundColor), area);
    if (s.backgroundImage.includes("gradient")) tally(gradients, s.backgroundImage.slice(0, 300));
    if (s.borderTopWidth !== "0px" && s.borderTopStyle !== "none") tally(borders, toHex(s.borderTopColor));
    for (const v of [s.paddingTop, s.paddingRight, s.paddingBottom, s.paddingLeft, s.marginTop, s.marginBottom, s.rowGap, s.columnGap]) {
      if (v && v !== "0px" && v !== "normal" && !v.startsWith("-") && v !== "auto") tally(spacing, v);
    }
    if (s.borderTopLeftRadius !== "0px") tally(radii, s.borderRadius);
    if (s.boxShadow !== "none") tally(shadows, s.boxShadow.slice(0, 200));
  }

  // Custom properties declared on :root / html, from every readable sheet.
  const variables: Record<string, string> = {};
  const breakpoints = new Set<string>();
  const rootStyle = getComputedStyle(document.documentElement);
  const walk = (rules: CSSRuleList) => {
    for (const rule of Array.from(rules)) {
      if (rule instanceof CSSMediaRule) {
        for (const m of rule.conditionText.matchAll(/(min|max)-width:\s*([\d.]+(px|em|rem))/g)) breakpoints.add(`${m[1]} ${m[2]}`);
        walk(rule.cssRules);
      } else if (rule instanceof CSSStyleRule && /(^|,)\s*(:root|html)\s*(,|$)/.test(rule.selectorText)) {
        for (const name of Array.from(rule.style)) {
          if (name.startsWith("--") && Object.keys(variables).length < 300) variables[name] = rootStyle.getPropertyValue(name).trim();
        }
      } else if ("cssRules" in rule && (rule as CSSGroupingRule).cssRules) walk((rule as CSSGroupingRule).cssRules);
    }
  };
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      walk(sheet.cssRules);
    } catch {
      // A cross-origin sheet without CORS: its rules are not readable.
    }
  }

  let nodes = 0;
  const layoutOf = (s: CSSStyleDeclaration): string | undefined => {
    const parts: string[] = [];
    if (s.display.includes("flex")) {
      parts.push(`flex ${s.flexDirection}`);
      if (s.flexWrap !== "nowrap") parts.push(s.flexWrap);
      if (s.justifyContent !== "normal") parts.push(`justify ${s.justifyContent}`);
      if (s.alignItems !== "normal") parts.push(`align ${s.alignItems}`);
      if (s.gap !== "normal") parts.push(`gap ${s.gap}`);
    } else if (s.display.includes("grid")) {
      parts.push(`grid cols ${s.gridTemplateColumns}`);
      if (s.gridTemplateRows !== "none") parts.push(`rows ${s.gridTemplateRows}`);
      if (s.gap !== "normal") parts.push(`gap ${s.gap}`);
    } else if (s.display !== "block" && s.display !== "inline") parts.push(s.display);
    if (s.position !== "static") parts.push(s.position);
    if (s.maxWidth !== "none") parts.push(`max-w ${s.maxWidth}`);
    const pad = [s.paddingTop, s.paddingRight, s.paddingBottom, s.paddingLeft];
    if (pad.some((p) => p !== "0px")) parts.push(`p ${pad.join(" ")}`);
    if (s.backgroundColor !== "rgba(0, 0, 0, 0)") parts.push(`bg ${toHex(s.backgroundColor)}`);
    return parts.length ? parts.join(", ") : undefined;
  };
  const tree = (el: Element, depth: number): DesignNode | null => {
    if (nodes >= MAX_NODES) return null;
    const rect = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    if (s.display === "none" || s.visibility === "hidden" || rect.width < 1 || rect.height < 1) return null;
    nodes++;
    const node: DesignNode = {
      tag: el.tagName.toLowerCase(),
      box: [Math.round(rect.x + scrollX), Math.round(rect.y + scrollY), Math.round(rect.width), Math.round(rect.height)],
    };
    if (el.id) node.id = el.id;
    const cls = typeof el.className === "string" ? el.className.trim().split(/\s+/).slice(0, 4).join(" ") : "";
    if (cls) node.cls = cls.slice(0, 80);
    const role = el.getAttribute("role");
    if (role) node.role = role;
    const layout = layoutOf(s);
    if (layout) node.layout = layout;
    const kids = depth < args.depth ? Array.from(el.children).map((c) => tree(c, depth + 1)).filter((n): n is DesignNode => n !== null) : [];
    if (kids.length) node.children = kids;
    else {
      const t = ((el as HTMLElement).innerText ?? "").trim().replace(/\s+/g, " ");
      if (t) node.text = t.slice(0, 80);
    }
    return node;
  };

  return {
    url: location.href,
    title: document.title,
    viewport: { width: innerWidth, height: innerHeight },
    document: { width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight },
    colors: { text: top(text, 12), background: top(backgrounds, 12), border: top(borders, 8), gradients: top(gradients, 4) },
    fonts: top(families, 8),
    typeScale: top(typeScale, 16),
    spacing: top(spacing, 16),
    radii: top(radii, 8),
    shadows: top(shadows, 6),
    variables,
    breakpoints: [...breakpoints].sort(),
    layout: tree(root, 0),
  };
}

/**
 * A standalone copy of a section: its markup with each element's computed
 * style inlined where it differs from that tag's default, scripts and
 * handlers stripped, and URLs made absolute.
 */
export function inlineHtmlInPage(args: { selector: string | null }): string | { error: string } {
  const root: Element | null = args.selector ? document.querySelector(args.selector) : document.body;
  if (!root) return { error: `nothing matches ${args.selector}` };
  const PROPS = [
    "display", "position", "top", "right", "bottom", "left", "z-index", "box-sizing", "width", "height", "min-width", "max-width",
    "min-height", "max-height", "margin-top", "margin-right", "margin-bottom", "margin-left", "padding-top", "padding-right",
    "padding-bottom", "padding-left", "flex-direction", "flex-wrap", "justify-content", "align-items", "align-self", "align-content",
    "flex-grow", "flex-shrink", "flex-basis", "order", "gap", "row-gap", "column-gap", "grid-template-columns", "grid-template-rows",
    "grid-column", "grid-row", "grid-auto-flow", "font-family", "font-size", "font-weight", "font-style", "line-height",
    "letter-spacing", "text-align", "text-transform", "text-decoration-line", "white-space", "color", "background-color",
    "background-image", "background-size", "background-position", "background-repeat", "border-top", "border-right",
    "border-bottom", "border-left", "border-radius", "box-shadow", "opacity", "overflow-x", "overflow-y", "object-fit",
    "transform", "list-style-type", "cursor", "filter", "backdrop-filter",
  ];
  // Probes live in a shadow root, where the page's own stylesheets do not
  // reach: their computed style is the browser default for the tag.
  const sandbox = document.createElement("div");
  sandbox.style.cssText = "all: initial; position: absolute; left: -99999px; top: 0; visibility: hidden;";
  document.documentElement.appendChild(sandbox);
  const shadow = sandbox.attachShadow({ mode: "open" });
  const INHERITED = new Set([
    "font-family", "font-size", "font-weight", "font-style", "line-height", "letter-spacing", "text-align",
    "text-transform", "white-space", "color", "cursor", "list-style-type",
  ]);
  const SIZED = /^(IMG|VIDEO|CANVAS|IFRAME|INPUT|TEXTAREA|SELECT|svg|PICTURE)$/;
  const defaults = new Map<string, Record<string, string>>();
  const defaultsFor = (tag: string) => {
    let d = defaults.get(tag);
    if (!d) {
      const probe = document.createElement(tag);
      shadow.appendChild(probe);
      const s = getComputedStyle(probe);
      d = Object.fromEntries(PROPS.map((p) => [p, s.getPropertyValue(p)]));
      probe.remove();
      defaults.set(tag, d);
    }
    return d;
  };
  const abs = (url: string) => {
    try {
      return new URL(url, document.baseURI).href;
    } catch {
      return url;
    }
  };
  let count = 0;
  const copy = (el: Element, parent: CSSStyleDeclaration | null): Element | null => {
    if (++count > 3000) return null;
    if (/^(SCRIPT|NOSCRIPT|TEMPLATE|LINK|META|STYLE)$/.test(el.tagName)) return null;
    const s = getComputedStyle(el);
    if (s.display === "none") return null;
    const clone = el.cloneNode(false) as Element;
    for (const attr of Array.from(clone.attributes)) {
      if (attr.name.startsWith("on") || attr.name === "class" || attr.name === "style" || attr.name.startsWith("data-")) clone.removeAttribute(attr.name);
    }
    for (const name of ["src", "href", "poster"]) {
      const value = clone.getAttribute(name);
      if (value) clone.setAttribute(name, abs(value));
    }
    if (clone.hasAttribute("srcset")) clone.removeAttribute("srcset");
    const d = defaultsFor(el.tagName.toLowerCase());
    const style: string[] = [];
    for (const p of PROPS) {
      const v = s.getPropertyValue(p);
      if (!v) continue;
      if (INHERITED.has(p)) {
        // Said once where it changes, not again on every descendant.
        if (parent ? v === parent.getPropertyValue(p) : v === d[p]) continue;
      } else if (v === d[p]) continue;
      if (p.startsWith("border-") && p !== "border-radius" && (/^0px/.test(v) || v.includes(" none "))) continue;
      if ((p === "width" || p === "height") && !SIZED.test(el.tagName)) continue;
      if ((p === "min-width" || p === "min-height") && v === "auto") continue;
      style.push(`${p}:${p === "background-image" ? v.replace(/url\("([^"]+)"\)/g, (_, u) => `url("${abs(u)}")`) : v}`);
    }
    if (style.length) clone.setAttribute("style", style.join(";"));
    if (el.tagName === "svg" || el.namespaceURI === "http://www.w3.org/2000/svg") return el.cloneNode(true) as Element;
    for (const child of Array.from(el.childNodes)) {
      if (child.nodeType === Node.TEXT_NODE) clone.appendChild(child.cloneNode());
      else if (child.nodeType === Node.ELEMENT_NODE) {
        const c = copy(child as Element, s);
        if (c) clone.appendChild(c);
      }
    }
    return clone;
  };
  const body = copy(root, null);
  sandbox.remove();
  const bodyStyle = getComputedStyle(document.body);
  return (
    `<!doctype html>\n<html lang="${document.documentElement.lang || "en"}">\n<head>\n<meta charset="utf-8">\n` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">\n<title>${document.title.replace(/</g, "&lt;")}</title>\n` +
    `<!-- Captured from ${location.href} by browser_design. Styles are computed values inlined per element. -->\n` +
    `<style>body{margin:0;font-family:${bodyStyle.fontFamily};background:${bodyStyle.backgroundColor};color:${bodyStyle.color}}</style>\n` +
    `</head>\n<body>\n${body ? (body as HTMLElement).outerHTML : ""}\n</body>\n</html>\n`
  );
}

export interface CompareOutcome {
  width: number;
  height: number;
  sizeMismatch: string | null;
  diffPixels: number;
  ratio: number;
  /** A 4x4 grid of the region's differing share, row by row, as percentages. */
  grid: number[][];
  /** Bounding box of every differing pixel, or null. */
  bounds: [number, number, number, number] | null;
  diffPng: string;
}

/**
 * A pixel diff of two PNGs (data URLs), drawn in a canvas: a YIQ colour
 * distance per pixel against `threshold`, the way pixelmatch measures it,
 * and a diff image with the differences in red over a faded baseline.
 */
export async function compareInPage(args: { a: string; b: string; threshold: number }): Promise<CompareOutcome> {
  const load = (src: string) =>
    new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("an image could not be decoded"));
      img.src = src;
    });
  const [a, b] = await Promise.all([load(args.a), load(args.b)]);
  const width = Math.min(a.naturalWidth, b.naturalWidth);
  const height = Math.min(a.naturalHeight, b.naturalHeight);
  const pixels = (img: HTMLImageElement) => {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(img, 0, 0);
    return ctx.getImageData(0, 0, width, height).data;
  };
  const pa = pixels(a);
  const pb = pixels(b);
  const out = document.createElement("canvas");
  out.width = width;
  out.height = height;
  const octx = out.getContext("2d")!;
  const diff = octx.createImageData(width, height);
  // pixelmatch's ceiling: the largest possible YIQ distance.
  const maxDelta = 35215 * args.threshold * args.threshold;
  const cells = Array.from({ length: 4 }, () => [0, 0, 0, 0]);
  let count = 0;
  let minX = width, minY = height, maxX = -1, maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const blend = (c: number, alpha: number) => 255 + ((c - 255) * alpha) / 255;
      const r1 = blend(pa[i]!, pa[i + 3]!), g1 = blend(pa[i + 1]!, pa[i + 3]!), b1 = blend(pa[i + 2]!, pa[i + 3]!);
      const r2 = blend(pb[i]!, pb[i + 3]!), g2 = blend(pb[i + 1]!, pb[i + 3]!), b2 = blend(pb[i + 2]!, pb[i + 3]!);
      const yd = (r1 - r2) * 0.29889531 + (g1 - g2) * 0.58662247 + (b1 - b2) * 0.11448223;
      const id = (r1 - r2) * 0.59597799 - (g1 - g2) * 0.2741761 - (b1 - b2) * 0.32180189;
      const qd = (r1 - r2) * 0.21147017 - (g1 - g2) * 0.52261711 + (b1 - b2) * 0.31114694;
      const delta = 0.5053 * yd * yd + 0.299 * id * id + 0.1957 * qd * qd;
      if (delta > maxDelta) {
        count++;
        cells[Math.min(3, Math.floor((y / height) * 4))]![Math.min(3, Math.floor((x / width) * 4))]!++;
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
        diff.data[i] = 255;
        diff.data[i + 1] = 0;
        diff.data[i + 2] = 0;
        diff.data[i + 3] = 255;
      } else {
        const gray = 255 + ((r1 * 0.299 + g1 * 0.587 + b1 * 0.114 - 255) * 0.1);
        diff.data[i] = diff.data[i + 1] = diff.data[i + 2] = gray;
        diff.data[i + 3] = 255;
      }
    }
  }
  octx.putImageData(diff, 0, 0);
  const cellArea = (width / 4) * (height / 4);
  return {
    width,
    height,
    sizeMismatch:
      a.naturalWidth !== b.naturalWidth || a.naturalHeight !== b.naturalHeight
        ? `baseline is ${a.naturalWidth}x${a.naturalHeight}, candidate ${b.naturalWidth}x${b.naturalHeight}; compared the top-left ${width}x${height}`
        : null,
    diffPixels: count,
    ratio: width * height ? count / (width * height) : 0,
    grid: cells.map((row) => row.map((c) => Math.round((c / cellArea) * 1000) / 10)),
    bounds: maxX >= 0 ? [minX, minY, maxX - minX + 1, maxY - minY + 1] : null,
    diffPng: out.toDataURL("image/png").replace(/^data:image\/png;base64,/, ""),
  };
}
