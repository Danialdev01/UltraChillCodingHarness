import { describe, expect, it } from "vitest";
import { DbQueryError, DbRefusal, guardedColumns } from "./adapter.js";
import { csvRow, parseCsv } from "./csv.js";
import { columnDdl } from "./ddl.js";
import { cellKindFor, serializeCell } from "./serialize.js";
import { escapeLike, mysqlAccount, qualified, quoteIdent, quoteLiteral } from "./sql-ident.js";
import { splitStatements } from "./sql-split.js";

describe("quoting", () => {
  it("quotes identifiers per engine and doubles the quote inside", () => {
    expect(quoteIdent("mysql", "we`ird")).toBe("`we``ird`");
    expect(quoteIdent("postgresql", 'we"ird')).toBe('"we""ird"');
    expect(qualified("mysql", "db", "t")).toBe("`db`.`t`");
    expect(qualified("postgresql", "db", "t")).toBe('"public"."t"');
  });

  it("quotes literals and accounts", () => {
    expect(quoteLiteral("postgresql", "it's")).toBe("'it''s'");
    expect(quoteLiteral("mysql", "it's")).toBe("'it\\'s'");
    expect(mysqlAccount("bob", "%")).toBe("'bob'@'%'");
    expect(escapeLike("50%_x\\")).toBe("50\\%\\_x\\\\");
  });
});

describe("serializeCell", () => {
  it("passes JSON-native values and stringifies the rest", () => {
    expect(serializeCell(null)).toBeNull();
    expect(serializeCell(undefined)).toBeNull();
    expect(serializeCell(3)).toBe(3);
    expect(serializeCell("x")).toBe("x");
    expect(serializeCell(true)).toBe(true);
    expect(serializeCell(10n)).toBe("10");
    expect(serializeCell(new Date("2020-01-02T03:04:05Z"))).toBe("2020-01-02T03:04:05.000Z");
    expect(serializeCell({ a: 1 })).toBe('{"a":1}');
    expect(serializeCell([1, 2])).toBe("[1,2]");
  });

  it("caps binary at the preview size", () => {
    expect(serializeCell(Buffer.from("hi"))).toEqual({ $bytes: "aGk=", size: 2 });
    const big = serializeCell(Buffer.alloc(20_000));
    expect(big).toMatchObject({ size: 20_000, truncated: true });
  });

  it("maps types to cell kinds", () => {
    expect(cellKindFor("mysql", "tinyint", "tinyint(1)")).toBe("bool");
    expect(cellKindFor("mysql", "tinyint", "tinyint(4)")).toBe("number");
    expect(cellKindFor("postgresql", "int8")).toBe("number");
    expect(cellKindFor("postgresql", "timestamptz")).toBe("datetime");
    expect(cellKindFor("mysql", "datetime")).toBe("datetime");
    expect(cellKindFor("postgresql", "jsonb")).toBe("json");
    expect(cellKindFor("postgresql", "bytea")).toBe("bytes");
    expect(cellKindFor("mysql", "varchar")).toBe("text");
    expect(cellKindFor("postgresql", "bool")).toBe("bool");
    expect(cellKindFor("mysql", "enum")).toBe("enum");
    expect(cellKindFor("postgresql", "point")).toBe("other");
  });
});

describe("splitStatements", () => {
  it("splits on semicolons outside strings and comments", () => {
    expect(splitStatements("select 1; select ';' -- ;\n; /* ; */ select 2", "mysql")).toEqual([
      "select 1",
      "select ';' -- ;",
      "/* ; */ select 2",
    ]);
  });

  it("drops statements that are only comments or whitespace", () => {
    expect(splitStatements("-- header\n\n/* note */;\nselect 1;\n-- trailer\n", "postgresql")).toEqual(["select 1"]);
  });

  it("knows backticks and # comments on MySQL only", () => {
    expect(splitStatements("select `a;b`; # x;\nselect 2", "mysql")).toEqual(["select `a;b`", "# x;\nselect 2"]);
    expect(splitStatements("select 1 # not a comment;\nselect 2", "postgresql")).toEqual(["select 1 # not a comment", "select 2"]);
  });

  it("keeps dollar-quoted bodies whole on PostgreSQL", () => {
    const fn = "create function f() returns int as $$ begin return 1; end; $$ language plpgsql";
    expect(splitStatements(`${fn}; select f()`, "postgresql")).toEqual([fn, "select f()"]);
    expect(splitStatements("select $tag$a;b$tag$; select 2", "postgresql")).toEqual(["select $tag$a;b$tag$", "select 2"]);
  });

  it("handles escaped and doubled quotes", () => {
    expect(splitStatements("select 'a\\';b'; select 2", "mysql")).toEqual(["select 'a\\';b'", "select 2"]);
    expect(splitStatements("select 'a'';b'; select 2", "postgresql")).toEqual(["select 'a'';b'", "select 2"]);
  });

  it("refuses DELIMITER", () => {
    expect(() => splitStatements("DELIMITER //\nselect 1//", "mysql")).toThrow(DbRefusal);
  });
});

describe("csv", () => {
  it("round-trips quoted fields, newlines and nulls", () => {
    const text = csvRow(["a", 'say "hi"', "line\nbreak", null, "1,2"]);
    expect(text).toBe('a,"say ""hi""","line\nbreak",,"1,2"\r\n');
    expect(parseCsv(text)).toEqual([["a", 'say "hi"', "line\nbreak", "", "1,2"]]);
  });

  it("accepts LF and CRLF and ignores a trailing newline", () => {
    expect(parseCsv("a,b\n1,2\r\n3,4\n")).toEqual([
      ["a", "b"],
      ["1", "2"],
      ["3", "4"],
    ]);
  });
});

describe("columnDdl", () => {
  const base = { name: "n", type: "int", nullable: true, autoincrement: false, default: null, primaryKey: false, unique: false };
  it("spells nullability, defaults and identity per engine", () => {
    expect(columnDdl("mysql", { ...base, nullable: false, default: { kind: "literal", value: "x" } })).toBe("`n` int NOT NULL DEFAULT 'x'");
    expect(columnDdl("mysql", { ...base, default: { kind: "expression", value: "CURRENT_TIMESTAMP" } })).toBe("`n` int NULL DEFAULT CURRENT_TIMESTAMP");
    expect(columnDdl("mysql", { ...base, default: { kind: "expression", value: "uuid()" } })).toBe("`n` int NULL DEFAULT (uuid())");
    expect(columnDdl("mysql", { ...base, autoincrement: true, comment: "c" })).toBe("`n` int NOT NULL AUTO_INCREMENT COMMENT 'c'");
    expect(columnDdl("postgresql", { ...base, autoincrement: true })).toBe('"n" int NOT NULL GENERATED BY DEFAULT AS IDENTITY');
    expect(columnDdl("postgresql", { ...base, primaryKey: true })).toBe('"n" int NOT NULL');
    expect(() => columnDdl("postgresql", { ...base, type: "text", autoincrement: true })).toThrow();
  });
});

describe("guardedColumns", () => {
  const detail = {
    columns: [
      { name: "id", kind: "number" },
      { name: "name", kind: "text" },
      { name: "avatar", kind: "bytes" },
    ],
  } as never;

  it("guards the cells the grid read, except bytes it holds only a preview of", () => {
    expect(guardedColumns(detail, { name: "Ann", avatar: { $bytes: "aGk=", size: 2 } })).toEqual(["name"]);
    expect(guardedColumns(detail, {})).toEqual([]);
  });

  it("refuses a column the table does not have", () => {
    expect(() => guardedColumns(detail, { nope: 1 })).toThrow(DbQueryError);
  });
});
