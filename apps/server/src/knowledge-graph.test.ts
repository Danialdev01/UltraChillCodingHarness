import { describe, expect, it } from "vitest";
import {
  chunkText,
  cleanGraph,
  entityKey,
  heuristicGraph,
  knowledgePrompt,
  mergeGraphs,
  parseGraphJson,
  rankChunks,
  relevantFacts,
  safeFileName,
} from "./knowledge-graph.js";

describe("entityKey", () => {
  it("folds case, quotes and punctuation", () => {
    expect(entityKey("  The “OpenAI”, Inc. ")).toBe(entityKey("the openai inc."));
    expect(entityKey("C++")).toBe("c++");
  });
});

describe("parseGraphJson", () => {
  it("reads an object out of a fenced answer and drops relations to unknown entities", () => {
    const graph = parseGraphJson(
      'Here:\n```json\n{"entities":[{"name":"Postgres","type":"Technology","description":"A database."},{"name":"Drizzle","type":"technology"}],' +
        '"relations":[{"source":"Drizzle","target":"postgres","relation":"Talks To"},{"source":"Drizzle","target":"Redis","relation":"uses"}]}\n```',
    );
    expect(graph?.entities.map((e) => e.name)).toEqual(["Postgres", "Drizzle"]);
    expect(graph?.entities[0]!.type).toBe("technology");
    expect(graph?.relations).toEqual([{ source: "Drizzle", target: "postgres", relation: "talks to" }]);
  });

  it("is null for an answer with no JSON", () => {
    expect(parseGraphJson("I could not read that.")).toBeNull();
    expect(parseGraphJson("{not json}")).toBeNull();
  });
});

describe("cleanGraph", () => {
  it("drops duplicates and self-loops", () => {
    const graph = cleanGraph({
      entities: [
        { name: "A thing", type: "x", description: "" },
        { name: "a THING", type: "x", description: "" },
        { name: "B", type: "x", description: "" },
      ],
      relations: [
        { source: "A thing", target: "a thing", relation: "is" },
        { source: "A thing", target: "B", relation: "has" },
        { source: "a thing", target: "b", relation: "has" },
      ],
    });
    expect(graph.entities).toHaveLength(2);
    expect(graph.relations).toHaveLength(1);
  });
});

describe("heuristicGraph", () => {
  it("finds headings and repeated proper nouns, linked when named together", () => {
    const text = [
      "# Payment Service",
      "The Payment Service talks to Stripe Connect for payouts.",
      "Stripe Connect sends webhooks to the Payment Service.",
      "Ledger Core keeps balances. Ledger Core is audited monthly.",
    ].join("\n\n");
    const graph = heuristicGraph(text);
    const names = graph.entities.map((e) => entityKey(e.name));
    expect(names).toContain("payment service");
    expect(names).toContain("stripe connect");
    expect(names).toContain("ledger core");
    expect(graph.relations.some((r) => [r.source, r.target].map(entityKey).sort().join("|") === "payment service|stripe connect")).toBe(true);
  });
});

describe("mergeGraphs", () => {
  it("folds entities across documents and counts degree", () => {
    const graph = mergeGraphs([
      {
        id: "d1",
        graph: {
          entities: [
            { name: "Alice", type: "person", description: "An engineer." },
            { name: "Acme", type: "organization", description: "" },
          ],
          relations: [{ source: "Alice", target: "Acme", relation: "works at" }],
        },
      },
      {
        id: "d2",
        graph: {
          entities: [
            { name: "alice", type: "person", description: "" },
            { name: "ACME", type: "organization", description: "A company." },
          ],
          relations: [{ source: "alice", target: "acme", relation: "works at" }],
        },
      },
      { id: "d3", graph: null },
    ]);
    expect(graph.nodes).toHaveLength(2);
    const alice = graph.nodes.find((n) => n.id === "alice")!;
    expect(alice.documentIds).toEqual(["d1", "d2"]);
    expect(alice.degree).toBe(1);
    expect(graph.nodes.find((n) => n.id === "acme")!.description).toBe("A company.");
    expect(graph.edges).toEqual([{ source: "alice", target: "acme", relation: "works at", documentIds: ["d1", "d2"], weight: 2 }]);
  });
});

describe("chunkText", () => {
  it("keeps short text whole and splits long text with overlap", () => {
    expect(chunkText("short")).toEqual(["short"]);
    const long = Array.from({ length: 60 }, (_, i) => `Sentence number ${i} is here.`).join(" ");
    const chunks = chunkText(long, 300, 50);
    expect(chunks.length).toBeGreaterThan(3);
    expect(chunks.every((c) => c.length <= 300)).toBe(true);
    expect(chunks.join(" ")).toContain("Sentence number 59");
  });
});

describe("rankChunks", () => {
  const chunk = (documentName: string, text: string) => ({ baseId: "b", baseName: "Base", documentId: documentName, documentName, text });

  it("ranks the passage that matches best first and leaves out non-matches", () => {
    const hits = rankChunks(
      "how do refunds work",
      [
        chunk("a.md", "Shipping takes three days."),
        chunk("b.md", "Refunds are issued within 14 days. Refunds go to the original card."),
        chunk("c.md", "A refund needs a receipt."),
      ],
      5,
    );
    expect(hits[0]!.documentName).toBe("b.md");
    expect(hits.map((h) => h.documentName)).not.toContain("a.md");
  });

  it("returns nothing for a query of stop words", () => {
    expect(rankChunks("the and of", [chunk("a.md", "the and of")], 5)).toEqual([]);
  });
});

describe("relevantFacts", () => {
  it("lists what the graph says about entities the message names", () => {
    const graph = mergeGraphs([
      {
        id: "d",
        graph: {
          entities: [
            { name: "Ledger Core", type: "system", description: "Keeps balances." },
            { name: "Payments", type: "system", description: "" },
            { name: "Unrelated", type: "x", description: "Nothing." },
          ],
          relations: [{ source: "Payments", target: "Ledger Core", relation: "writes to" }],
        },
      },
    ]);
    const facts = relevantFacts("What does ledger core do?", graph);
    expect(facts).toContain("Ledger Core (system): Keeps balances.");
    expect(facts).toContain("Payments —writes to→ Ledger Core");
    expect(facts.join("\n")).not.toContain("Unrelated");
  });
});

describe("knowledgePrompt", () => {
  const base = { name: "Handbook", description: "Company rules", dir: ".knowledge/handbook", documents: ["rules.pdf"] };
  const hit = { baseId: "b", baseName: "Handbook", documentId: "d", documentName: "rules.pdf", text: "Leave is 25 days.", score: 2 };

  it("forbids the web for a knowledge-only turn", () => {
    const prompt = knowledgePrompt({ scope: "knowledge", bases: [base], hits: [hit], facts: [] });
    expect(prompt).toContain("Answer ONLY from the knowledge bases");
    expect(prompt).toContain(".knowledge/handbook/");
    expect(prompt).toContain('<passage base="Handbook" document="rules.pdf">');
  });

  it("allows the web when asked", () => {
    const prompt = knowledgePrompt({ scope: "web", bases: [base], hits: [], facts: ["A —b→ C"] });
    expect(prompt).toContain("You may also search the web");
    expect(prompt).toContain("- A —b→ C");
    expect(prompt).toContain("No passage matched");
  });
});

describe("safeFileName", () => {
  it("strips path separators and leading dots", () => {
    expect(safeFileName("../../etc/passwd")).toBe("passwd");
    expect(safeFileName("a\\b:c?.txt")).toBe("b_c_.txt");
    expect(safeFileName("..")).toBe("document");
    expect(safeFileName("Report 2026.pdf")).toBe("Report 2026.pdf");
  });
});
