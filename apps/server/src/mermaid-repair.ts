/**
 * Makes a model-written Mermaid flowchart parse.
 *
 * Models write labels as prose -- `-->|@auth|`, `[/"/login" GET/]`,
 * `-->|"Forgot password?" link|` -- and Mermaid's flowchart grammar reads
 * half of those characters as syntax: `@` after an arrow is an edge id, a
 * quote mid-label ends a string, `/` and `(` open shapes. Mermaid's own
 * parser needs a DOM, so the server cannot ask it; instead every node and
 * edge label is rewritten to the one form the grammar always accepts: the
 * whole text in double quotes, with any double quote inside it made a
 * single one -- the model meant it as quoting, and `'` reads the same.
 *
 * Line by line, and only the parts that are labels: comments, directives
 * and statements this does not recognise pass through untouched, so a
 * diagram that already parsed still does.
 */

/** Statements whose lines hold no node or edge labels to rewrite. */
const PASS_THROUGH = /^\s*(%%|classDef\b|class\b|style\b|linkStyle\b|click\b|direction\b|end\s*$|flowchart\b|graph\b)/;

/** Shape openers and their closers, longest first so `([` wins over `(`. */
const SHAPES: ReadonlyArray<readonly [open: string, close: readonly string[]]> = [
  ["(((", [")))"]],
  ["([", ["])"]],
  ["[[", ["]]"]],
  ["[(", [")]"]],
  ["((", ["))"]],
  ["{{", ["}}"]],
  ["[/", ["/]", "\\]"]],
  ["[\\", ["\\]", "/]"]],
  ["[", ["]"]],
  ["(", [")"]],
  ["{", ["}"]],
  [">", ["]"]],
];

/** An arrow or link, with no label inside it. */
const ARROW = /^<?(?:-{2,}|={2,}|-\.+-|~{3,})(?:>|[xo](?![\w$]))?/;

/** `-. text .->` and `-- text -->`, the inline label forms. */
const DOTTED_INLINE = /^(<)?-\.(?!-)\s*(.+?)\s*\.-(>)?/;
const SOLID_INLINE = /^(<)?(--|==)\s+(?![->=])(.+?)\s+(--|==)(-*|=*)(>|x|o)?/;

/** The text as a label the grammar cannot misread. */
export function quoteLabel(text: string): string {
  const trimmed = text.trim();
  // Already one clean quoted string: leave it exactly as written.
  if (/^"[^"]*"$/.test(trimmed)) return trimmed;
  return `"${trimmed.replace(/"/g, "'")}"`;
}

function isIdChar(c: string | undefined): boolean {
  return c !== undefined && /[\w$-]/.test(c);
}

/**
 * Where a shape's text ends: the first closer followed by something that can
 * come after a node -- the end of the line, a link, `&`, `:::`, `;`. A closer
 * with more text after it is part of the label (`["a [x] b"]`).
 */
function findClose(line: string, from: number, closers: readonly string[]): { at: number; close: string } | null {
  let best: { at: number; close: string } | null = null;
  for (const close of closers) {
    let at = line.indexOf(close, from);
    while (at !== -1) {
      const after = line.slice(at + close.length);
      if (/^\s*($|[-=<.~&;]|:::|%%)/.test(after)) break;
      at = line.indexOf(close, at + 1);
    }
    if (at !== -1 && (!best || at < best.at)) best = { at, close };
  }
  return best;
}

function repairLine(line: string): string {
  if (PASS_THROUGH.test(line)) return line;
  // `subgraph id [title]` keeps its id; only the title is a label.
  const subgraph = /^(\s*subgraph\s+)(.*)$/.exec(line);
  if (subgraph) {
    const rest = subgraph[2]!;
    const titled = /^([\w$-]+)\s*\[(.*)\]\s*$/.exec(rest);
    if (titled) return `${subgraph[1]}${titled[1]}[${quoteLabel(titled[2]!)}]`;
    return line;
  }

  let out = "";
  let i = 0;
  let afterArrow = false;
  while (i < line.length) {
    const rest = line.slice(i);

    if (rest.startsWith("%%")) {
      out += rest;
      break;
    }

    // An edge label right after an arrow: `-->|text|`.
    if (afterArrow && /^\s*\|/.test(rest)) {
      const open = i + rest.indexOf("|");
      // The label ends at the last `|` before the next node id, so a `|`
      // inside the text does not end it early.
      const m = /^\|(.*?)\|(?=\s*[\w$"([{>]|\s*$)/.exec(line.slice(open));
      if (m) {
        out += line.slice(i, open) + `|${quoteLabel(m[1]!)}|`;
        i = open + m[0].length;
        afterArrow = false;
        continue;
      }
    }

    const dotted = DOTTED_INLINE.exec(rest);
    if (dotted) {
      out += `${dotted[1] ?? ""}-.-${dotted[3] ?? ""}|${quoteLabel(dotted[2]!)}|`;
      i += dotted[0].length;
      afterArrow = false;
      continue;
    }
    const solid = SOLID_INLINE.exec(rest);
    if (solid) {
      out += `${solid[1] ?? ""}${solid[4]}${solid[5]}${solid[6] ?? ""}|${quoteLabel(solid[3]!)}|`;
      i += solid[0].length;
      afterArrow = false;
      continue;
    }

    const arrow = ARROW.exec(rest);
    if (arrow) {
      out += arrow[0];
      i += arrow[0].length;
      afterArrow = true;
      continue;
    }

    // A node: an id, then a shape.
    if (isIdChar(line[i]) && !isIdChar(line[i - 1])) {
      const id = /^[\w$]+(?:-[\w$]+)*/.exec(rest)?.[0];
      if (id) {
        const after = i + id.length;
        const shape = SHAPES.find(([open]) => line.startsWith(open, after));
        if (shape) {
          const [open, closers] = shape;
          const close = findClose(line, after + open.length, closers);
          if (close) {
            const text = line.slice(after + open.length, close.at);
            out += `${id}${open}${quoteLabel(text)}${close.close}`;
            i = close.at + close.close.length;
            afterArrow = false;
            continue;
          }
        }
        out += id;
        i = after;
        afterArrow = false;
        continue;
      }
    }

    if (!/\s/.test(line[i]!)) afterArrow = false;
    out += line[i];
    i += 1;
  }
  return out;
}

/** Every node and edge label of a flowchart, quoted. Other diagrams pass through. */
export function repairMermaid(source: string): string {
  const first = source.trimStart().split("\n", 1)[0] ?? "";
  if (!/^(flowchart|graph)\b/.test(first)) return source;
  return source.split("\n").map(repairLine).join("\n");
}
