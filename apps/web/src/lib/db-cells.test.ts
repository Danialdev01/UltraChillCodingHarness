import { describe, expect, it } from "vitest";

import { editText, formatCell, keyOf, parseCellInput, quoteIdent, rowId } from "./db-cells";

const columns = [
  { name: "id", kind: "number", nullable: false },
  { name: "name", kind: "text", nullable: true },
] as never;

describe("formatCell", () => {
  it("names the shapes a cell can take", () => {
    expect(formatCell(null)).toEqual({ kind: "null" });
    expect(formatCell(true)).toEqual({ kind: "bool", value: true });
    expect(formatCell({ $bytes: "AA==", size: 2048 })).toEqual({ kind: "bytes", label: "[BLOB 2 KB]" });
    expect(formatCell(12)).toMatchObject({ kind: "text", text: "12", truncated: false });
  });

  it("flattens and cuts long text but keeps the whole value", () => {
    const long = "a\nb".repeat(100);
    const shown = formatCell(long);
    expect(shown).toMatchObject({ kind: "text", truncated: true, full: long });
    if (shown.kind !== "text") throw new Error("expected text");
    expect(shown.text.endsWith("…")).toBe(true);
    expect(shown.text).not.toContain("\n");
  });
});

describe("parseCellInput", () => {
  it("reads numbers only when the whole text is one", () => {
    expect(parseCellInput("42", { kind: "number", nullable: false })).toBe(42);
    expect(parseCellInput("-1.5e3", { kind: "number", nullable: false })).toBe(-1500);
    expect(parseCellInput("12abc", { kind: "number", nullable: false })).toBe("12abc");
    expect(parseCellInput("99999999999999999999", { kind: "number", nullable: false })).toBe("99999999999999999999");
  });

  it("makes empty text NULL only where NULL is allowed", () => {
    expect(parseCellInput("", { kind: "text", nullable: true })).toBeNull();
    expect(parseCellInput("", { kind: "text", nullable: false })).toBe("");
  });

  it("reads the usual spellings of a boolean", () => {
    expect(parseCellInput("yes", { kind: "bool", nullable: false })).toBe(true);
    expect(parseCellInput("0", { kind: "bool", nullable: false })).toBe(false);
    expect(parseCellInput("maybe", { kind: "bool", nullable: false })).toBe("maybe");
  });
});

describe("keys", () => {
  it("picks the primary key columns out of a row", () => {
    expect(keyOf([7, "x"], columns, ["id"])).toEqual({ id: 7 });
    expect(rowId([7, "x"], columns, ["id"], 0)).toBe('{"id":7}');
    expect(rowId([7, "x"], columns, [], 3)).toBe("#3");
  });

  it("starts an edit from the whole value", () => {
    expect(editText(null)).toBe("");
    expect(editText(3.5)).toBe("3.5");
    expect(editText({ $bytes: "", size: 1 })).toBe("");
  });

  it("quotes identifiers the way each engine reads them", () => {
    expect(quoteIdent("a`b", "mysql")).toBe("`a``b`");
    expect(quoteIdent('a"b', "postgresql")).toBe('"a""b"');
  });
});
