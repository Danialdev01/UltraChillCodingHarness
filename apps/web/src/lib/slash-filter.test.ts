import { describe, expect, it } from "vitest";
import { filterSlashItems } from "./slash-filter";

const items = [
  { id: "h1", title: "Heading 1", description: "Section title", keywords: ["title"] },
  { id: "tasks", title: "To-do list", description: "Checkboxes", keywords: ["todo", "task"] },
  { id: "table", title: "Table", description: "3 by 3, with a header row", keywords: ["grid"] },
  { id: "mermaid", title: "Mermaid diagram", description: "Flowchart from text", keywords: ["diagram"] },
  { id: "whiteboard", title: "Whiteboard", description: "A canvas", keywords: ["tldraw", "draw"] },
  { id: "drawio", title: "Diagram (draw.io)", description: "Shapes", keywords: ["drawio"] },
];
const ids = (q: string) => filterSlashItems(q, items).map((i) => i.id);

describe("filterSlashItems", () => {
  it("returns everything for an empty query, in menu order", () => {
    expect(ids("")).toEqual(items.map((i) => i.id));
  });

  it("ranks a title match above a keyword match", () => {
    expect(ids("draw")).toEqual(["drawio", "whiteboard"]);
    expect(ids("head")).toEqual(["h1", "table"]);
  });

  it("finds by keyword and description", () => {
    expect(ids("todo")[0]).toBe("tasks");
    expect(ids("flowchart")).toEqual(["mermaid"]);
  });

  it("is empty when nothing matches", () => {
    expect(ids("zzz")).toEqual([]);
  });
});
