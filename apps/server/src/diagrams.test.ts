import { describe, expect, it } from "vitest";
import { DIAGRAM_FILES, diagramAsk, extractMermaid, isDiagramKind } from "./diagrams.js";

describe("extractMermaid", () => {
  it("takes the diagram out of its fence", () => {
    const reply = "```mermaid\nerDiagram\n  users ||--o{ posts : writes\n```";
    expect(extractMermaid(reply, "database")).toBe("erDiagram\n  users ||--o{ posts : writes\n");
  });

  it("takes the last fence when there are several", () => {
    const reply = "```mermaid\nerDiagram\n  a\n```\nThen:\n```mermaid\nerDiagram\n  b\n```";
    expect(extractMermaid(reply, "database")).toBe("erDiagram\n  b\n");
  });

  it("refuses a reply without a mermaid fence", () => {
    expect(() => extractMermaid("There is no database.", "database")).toThrow(/did not reply/);
    expect(() => extractMermaid("```sql\nCREATE TABLE a ();\n```", "database")).toThrow(/did not reply/);
  });

  it("refuses a diagram of the wrong type for the kind", () => {
    const flowchart = "```mermaid\nflowchart LR\n  a --> b\n```";
    const sequence = "```mermaid\nsequenceDiagram\n  a->>b: hi\n```";
    expect(() => extractMermaid(flowchart, "database")).toThrow(/not an entity-relationship/);
    expect(() => extractMermaid(sequence, "architecture")).toThrow(/not a flowchart/);
    expect(() => extractMermaid(flowchart, "system-flow")).toThrow(/not a sequence/);
    expect(() => extractMermaid(sequence, "user-flow")).toThrow(/not a flowchart/);
  });

  it("accepts each kind's own type", () => {
    expect(extractMermaid("```mermaid\nflowchart LR\n  a --> b\n```", "architecture")).toMatch(/^flowchart LR/);
    expect(extractMermaid("```mermaid\nsequenceDiagram\n  a->>b: hi\n```", "system-flow")).toMatch(/^sequenceDiagram/);
    expect(extractMermaid("```mermaid\nflowchart TD\n  a --> b\n```", "user-flow")).toMatch(/^flowchart TD/);
  });
});

describe("diagramAsk", () => {
  it("names the Mermaid type each kind must reply with", () => {
    expect(diagramAsk("database")).toContain("`erDiagram`");
    expect(diagramAsk("architecture")).toContain("`flowchart LR`");
    expect(diagramAsk("system-flow")).toContain("`sequenceDiagram`");
    expect(diagramAsk("user-flow")).toContain("`flowchart TD`");
  });

  it("points every kind at .ucch/INFO.md and forbids changes", () => {
    for (const kind of Object.keys(DIAGRAM_FILES) as (keyof typeof DIAGRAM_FILES)[]) {
      expect(diagramAsk(kind)).toContain(".ucch/INFO.md");
      expect(diagramAsk(kind)).toContain("Do not change any files.");
    }
  });
});

describe("isDiagramKind", () => {
  it("knows every kind on the page, all kept in .ucch/diagrams/", () => {
    for (const kind of ["database", "architecture", "system-flow", "user-flow"]) {
      expect(isDiagramKind(kind)).toBe(true);
    }
    expect(Object.values(DIAGRAM_FILES).every((path) => path.startsWith(".ucch/diagrams/"))).toBe(true);
    expect(isDiagramKind("toString")).toBe(false);
    expect(isDiagramKind("sequence")).toBe(false);
  });
});

describe("extractMermaid repairs", () => {
  it("quotes a flowchart's labels before it is saved", () => {
    const reply = "```mermaid\nflowchart TD\n  View -->|@auth| Edit\n```";
    expect(extractMermaid(reply, "user-flow")).toBe('flowchart TD\n  View -->|"@auth"| Edit\n');
  });
});
