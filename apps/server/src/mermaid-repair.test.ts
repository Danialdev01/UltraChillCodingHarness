import { describe, expect, it } from "vitest";
import { quoteLabel, repairMermaid } from "./mermaid-repair.js";

const flow = (...lines: string[]) => repairMermaid(["flowchart TD", ...lines].join("\n")).split("\n").slice(1);

describe("repairMermaid", () => {
  it("quotes an edge label Mermaid would read as an edge id", () => {
    // The reply that broke the user-flow tab: `@` after an arrow is syntax.
    expect(flow("    PubAssetView -->|@auth| PubAssetEditPage")).toEqual([
      '    PubAssetView -->|"@auth"| PubAssetEditPage',
    ]);
  });

  it("quotes node text that mixes a quoted part with more words", () => {
    expect(flow('Root[/"/login" GET/]')).toEqual([`Root[/"'/login' GET"/]`]);
    expect(flow('Login -->|"Forgot password?" link| Forgot')).toEqual([`Login -->|"'Forgot password?' link"| Forgot`]);
  });

  it("quotes every shape, and leaves a label already quoted alone", () => {
    expect(
      flow(
        "Start([Visitor arrives]) --> Check{Auth + role}",
        "H(rounded (x)) --> I((circle))",
        'Done["already: fine"] --> DB[(Postgres)]',
      ),
    ).toEqual([
      'Start(["Visitor arrives"]) --> Check{"Auth + role"}',
      'H("rounded (x)") --> I(("circle"))',
      'Done["already: fine"] --> DB[("Postgres")]',
    ]);
  });

  it("turns inline link text into a quoted label", () => {
    expect(
      flow("A -.redirect after login.-> B", "C -- plain text --> D", "E == thick text ==> F"),
    ).toEqual(['A -.->|"redirect after login"| B', 'C -->|"plain text"| D', 'E ==>|"thick text"| F']);
  });

  it("does not take node ids for arrow ends, nor arrows for ids", () => {
    expect(flow("odd-->xray", "a-->b & c", "E --o F")).toEqual(['odd-->xray', "a-->b & c", "E --o F"]);
  });

  it("leaves comments, styling and subgraph ends as written", () => {
    const lines = ["%% from routes/web.php: [x] |y|", "classDef warn fill:#f96", "class A warn", "end"];
    expect(flow(...lines)).toEqual(lines);
  });

  it("quotes a subgraph title but keeps its id", () => {
    expect(flow("subgraph admin [Admin area (role)]")).toEqual(['subgraph admin["Admin area (role)"]']);
  });

  it("changes nothing in other kinds of diagram", () => {
    const er = "erDiagram\n  users ||--o{ posts : writes\n";
    const seq = "sequenceDiagram\n  A->>B: GET /x (y)\n";
    expect(repairMermaid(er)).toBe(er);
    expect(repairMermaid(seq)).toBe(seq);
  });
});

describe("quoteLabel", () => {
  it("wraps text in quotes and softens any inside", () => {
    expect(quoteLabel(" a b ")).toBe('"a b"');
    expect(quoteLabel('"done"')).toBe('"done"');
    expect(quoteLabel('row "View" button')).toBe(`"row 'View' button"`);
  });
});
