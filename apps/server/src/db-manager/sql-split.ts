import type { DatabaseEngine } from "@ucch/protocol";
import { DbRefusal } from "./adapter.js";

/**
 * One SQL text into its statements, the way a client would before sending
 * them one at a time.
 *
 * The drivers could take the whole text in one go, but then a batch is a
 * single result with a single count, and an error somewhere in the middle
 * has no statement number. Splitting here is what lets the SQL console
 * show a result per statement and an import say which line broke.
 *
 * The scanner knows what a `;` inside a string, a quoted name, a comment or
 * a dollar-quoted body is, and nothing more: it does not parse SQL. A
 * `DELIMITER` line is a mysql-client command, not SQL, and is refused so a
 * routine body is not chopped at its inner semicolons.
 */
export function splitStatements(text: string, engine: DatabaseEngine): string[] {
  if (/^\s*DELIMITER\b/im.test(text)) {
    throw new DbRefusal("DELIMITER is a mysql client command, not SQL; paste routines one at a time without it");
  }

  const statements: string[] = [];
  let start = 0;
  let i = 0;
  const n = text.length;
  // Whether anything but whitespace and comments has been seen since
  // `start`: a comment on its own is not a statement to send.
  let meaningful = false;

  const push = (end: number) => {
    const statement = text.slice(start, end).trim();
    if (statement && meaningful) statements.push(statement);
    meaningful = false;
  };

  while (i < n) {
    const c = text[i]!;
    const next = text[i + 1];

    if (c === "'" || c === '"' || (c === "`" && engine === "mysql")) {
      meaningful = true;
      i = skipQuoted(text, i, c, engine);
      continue;
    }
    if (c === "-" && next === "-") {
      i = skipLine(text, i);
      continue;
    }
    if (c === "#" && engine === "mysql") {
      i = skipLine(text, i);
      continue;
    }
    if (c === "/" && next === "*") {
      const close = text.indexOf("*/", i + 2);
      i = close === -1 ? n : close + 2;
      continue;
    }
    if (c === "$" && engine === "postgresql") {
      const tag = /^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/.exec(text.slice(i, i + 64));
      if (tag) {
        meaningful = true;
        const close = text.indexOf(tag[0], i + tag[0].length);
        i = close === -1 ? n : close + tag[0].length;
        continue;
      }
    }
    if (c === ";") {
      push(i);
      start = i + 1;
    } else if (!/\s/.test(c)) {
      meaningful = true;
    }
    i += 1;
  }
  push(n);
  return statements;
}

function skipQuoted(text: string, from: number, quote: string, engine: DatabaseEngine): number {
  let i = from + 1;
  while (i < text.length) {
    const c = text[i]!;
    if (c === "\\" && engine === "mysql" && quote !== "`") {
      i += 2;
      continue;
    }
    if (c === quote) {
      // A doubled quote is an escaped quote on both engines.
      if (text[i + 1] === quote) {
        i += 2;
        continue;
      }
      return i + 1;
    }
    i += 1;
  }
  return i;
}

function skipLine(text: string, from: number): number {
  const end = text.indexOf("\n", from);
  return end === -1 ? text.length : end + 1;
}
