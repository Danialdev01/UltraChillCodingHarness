import { describe, expect, it } from "vitest";
import { extractMermaid, isDiagramKind } from "./diagrams.js";

describe("extractMermaid", () => {
  it("takes the diagram out of its fence", () => {
    const reply = "```mermaid\nerDiagram\n  users ||--o{ posts : writes\n```";
    expect(extractMermaid(reply)).toBe("erDiagram\n  users ||--o{ posts : writes\n");
  });

  it("takes the last fence when there are several", () => {
    const reply = "```mermaid\nerDiagram\n  a\n```\nThen:\n```mermaid\nerDiagram\n  b\n```";
    expect(extractMermaid(reply)).toBe("erDiagram\n  b\n");
  });

  it("refuses a reply without a mermaid fence", () => {
    expect(() => extractMermaid("There is no database.")).toThrow(/did not reply/);
    expect(() => extractMermaid("```sql\nCREATE TABLE a ();\n```")).toThrow(/did not reply/);
  });

  it("refuses a diagram that is not an erDiagram", () => {
    expect(() => extractMermaid("```mermaid\nflowchart LR\n  a --> b\n```")).toThrow(/not an entity/);
  });
});

describe("isDiagramKind", () => {
  it("knows only the kinds that have a file", () => {
    expect(isDiagramKind("database")).toBe(true);
    expect(isDiagramKind("architecture")).toBe(false);
    expect(isDiagramKind("toString")).toBe(false);
  });
});
