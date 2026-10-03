import { describe, expect, it } from "vitest";
import { noteText, snippetAround } from "./note-text.js";

const doc = {
  type: "doc" as const,
  content: [
    { type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "Plan" }] },
    {
      type: "paragraph",
      content: [
        { type: "text", text: "Ship " },
        { type: "text", marks: [{ type: "bold" }], text: "soon" },
        { type: "hardBreak" },
        { type: "text", text: "please" },
      ],
    },
    { type: "image", attrs: { src: "/x.png", alt: "diagram", caption: "The flow" } },
    { type: "mermaid", attrs: { code: "graph TD; A-->B" } },
    { type: "tldraw", attrs: { snapshot: { store: { "shape:1": { text: "hidden" } } } } },
    { type: "pageLink", attrs: { noteId: "abc" } },
    {
      type: "bulletList",
      content: [
        { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "one" }] }] },
        { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "two" }] }] },
      ],
    },
  ],
};

describe("noteText", () => {
  it("reads what a reader sees, one line per block", () => {
    expect(noteText(doc)).toBe("Plan\nShip soonplease\nThe flow\ndiagram\ngraph TD; A-->B\none\ntwo");
  });
  it("skips whiteboard snapshots and page ids", () => {
    expect(noteText(doc)).not.toContain("hidden");
    expect(noteText(doc)).not.toContain("abc");
  });
  it("is empty for an empty page", () => {
    expect(noteText({ type: "doc", content: [] })).toBe("");
    expect(noteText({ type: "doc" })).toBe("");
  });
});

describe("snippetAround", () => {
  const text = "a".repeat(100) + " needle " + "b".repeat(100);
  it("centres the match and marks what was cut", () => {
    const snippet = snippetAround(text, "NEEDLE", 10);
    expect(snippet).toBe("…aaaaaaaaa needle bbbbbbbbb…");
  });
  it("starts from the beginning when nothing matches", () => {
    expect(snippetAround("short text", "zzz")).toBe("short text");
    expect(snippetAround(text, "zzz", 5)).toBe("aaaaaaaaaa…");
  });
});
