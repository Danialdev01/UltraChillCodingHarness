import type { Cell, CellKind, DatabaseEngine } from "@ucch/protocol";

/**
 * Driver values in, JSON cells out -- and back.
 *
 * Both drivers are configured to hand over dates and big numbers as text
 * (see `withMysql`/`withPostgres`), so most values pass straight through.
 * What is left: `Date` for the few paths that still produce one, binary as
 * base64 capped at 16 KiB, and anything structured (json columns, arrays)
 * as its JSON text, which is what the grid can show and the user can edit.
 */
export const BYTES_PREVIEW_MAX = 16 * 1024;

export function serializeCell(value: unknown): Cell {
  if (value === null || value === undefined) return null;
  switch (typeof value) {
    case "string":
    case "number":
    case "boolean":
      return value;
    case "bigint":
      return value.toString();
  }
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    const bytes = Buffer.from(value);
    return {
      $bytes: bytes.subarray(0, BYTES_PREVIEW_MAX).toString("base64"),
      size: bytes.length,
      ...(bytes.length > BYTES_PREVIEW_MAX ? { truncated: true as const } : {}),
    };
  }
  return JSON.stringify(value);
}

/** A cell from the client as a driver parameter. */
export function bindValue(cell: Cell): null | string | number | boolean | Buffer {
  if (cell !== null && typeof cell === "object") return Buffer.from(cell.$bytes, "base64");
  return cell;
}

const KINDS: Array<[RegExp, CellKind]> = [
  [/^(tinyint\(1\)|bool|boolean|bit\(1\))$/i, "bool"],
  [/^((tiny|small|medium|big)?int(eger)?[248]?|(big|small)?serial|decimal|numeric|float[48]?|double( precision)?|real|money|year|dec|fixed)$/i, "number"],
  [/^date$/i, "date"],
  [/timestamp|datetime/i, "datetime"],
  [/^time/i, "time"],
  [/json/i, "json"],
  [/blob|binary|bytea/i, "bytes"],
  [/^(enum|set)$/i, "enum"],
  [/char|text|uuid|inet|cidr|xml|citext|name/i, "text"],
];

export function cellKindFor(_engine: DatabaseEngine, dataType: string, fullType?: string): CellKind {
  // MySQL's tinyint(1) is only recognisable from the full type.
  const probe = fullType && /^tinyint\(1\)/i.test(fullType) ? "tinyint(1)" : dataType;
  for (const [pattern, kind] of KINDS) if (pattern.test(probe)) return kind;
  return "other";
}
