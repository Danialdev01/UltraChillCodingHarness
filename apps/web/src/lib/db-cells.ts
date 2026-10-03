import type { Cell, ColumnInfo } from "@ucch/protocol";

import { formatBytes } from "./stats-format";

/**
 * How a cell looks in the grid, and how what someone types becomes a cell.
 *
 * The two directions are deliberately not inverses: display truncates and
 * decorates, while parsing is as literal as it can be, so that editing a
 * cell starts from `editText` -- the whole value, undecorated -- rather
 * than from what the grid happened to show.
 */

/** The longest a cell is drawn before it is cut and given a title. */
export const CELL_PREVIEW = 120;

export type CellDisplay =
  | { kind: "null" }
  | { kind: "bytes"; label: string }
  | { kind: "bool"; value: boolean }
  | { kind: "text"; text: string; full: string; truncated: boolean };

export function formatCell(cell: Cell): CellDisplay {
  if (cell === null) return { kind: "null" };
  if (typeof cell === "boolean") return { kind: "bool", value: cell };
  if (typeof cell === "object") return { kind: "bytes", label: `[BLOB ${formatBytes(cell.size)}]` };
  const full = typeof cell === "number" ? String(cell) : cell;
  const oneLine = full.replace(/\r?\n/g, "↵");
  const truncated = oneLine.length > CELL_PREVIEW;
  return { kind: "text", text: truncated ? `${oneLine.slice(0, CELL_PREVIEW - 1)}…` : oneLine, full, truncated };
}

/** The text an inline editor starts with: the whole value, or "" for NULL. */
export function editText(cell: Cell): string {
  if (cell === null) return "";
  if (typeof cell === "object") return "";
  return String(cell);
}

/** A cell that cannot be edited from a text box: a blob the page only has a cut of. */
export function isEditable(cell: Cell): boolean {
  return !(typeof cell === "object" && cell !== null);
}

/**
 * What typed text means for this column.
 *
 * Empty text is NULL for a nullable column and the empty string otherwise;
 * a column with an explicit NULL wanted on a non-nullable column has the
 * checkbox in the row form for that. Numbers stay numbers only when the
 * whole text is one, so "12abc" reaches the server as text and fails there
 * with the engine's own words rather than being quietly cut to 12.
 */
export function parseCellInput(text: string, column: Pick<ColumnInfo, "kind" | "nullable">): Cell {
  if (text === "" && column.nullable) return null;
  if (column.kind === "number") {
    const trimmed = text.trim();
    // An integer too big for a double stays text: sent as a number it would
    // arrive rounded, and the engine reads "99999999999999999999" exactly.
    if (/^-?\d+$/.test(trimmed)) return Number.isSafeInteger(Number(trimmed)) ? Number(trimmed) : trimmed;
    if (/^-?(\d+\.\d*|\.\d+|\d+)([eE][-+]?\d+)?$/.test(trimmed) && Number.isFinite(Number(trimmed))) return Number(trimmed);
    return text;
  }
  if (column.kind === "bool") {
    const word = text.trim().toLowerCase();
    if (["true", "t", "1", "yes", "y"].includes(word)) return true;
    if (["false", "f", "0", "no", "n"].includes(word)) return false;
    return text;
  }
  return text;
}

/** The rows of a page keyed by their primary key, for updates and deletes. */
export function keyOf(row: Cell[], columns: ColumnInfo[], primaryKey: string[]): Record<string, Cell> {
  const key: Record<string, Cell> = {};
  for (const name of primaryKey) {
    const index = columns.findIndex((c) => c.name === name);
    if (index !== -1) key[name] = row[index] ?? null;
  }
  return key;
}

/** A stable identity for a row across re-renders: its key, serialised. */
export function rowId(row: Cell[], columns: ColumnInfo[], primaryKey: string[], index: number): string {
  if (primaryKey.length === 0) return `#${index}`;
  return JSON.stringify(keyOf(row, columns, primaryKey));
}

/** A table name the engine will read as one identifier, for SQL the page writes. */
export function quoteIdent(name: string, engine: "mysql" | "postgresql"): string {
  return engine === "mysql" ? `\`${name.replace(/`/g, "``")}\`` : `"${name.replace(/"/g, '""')}"`;
}
