import { describe, expect, it } from "vitest";
import { mergeSearchHits, rankTitleMatches } from "./note-search";

const notes = [
  { id: "1", parentId: null, title: "Roadmap", icon: null, position: 0 },
  { id: "2", parentId: "1", title: "Q3 roadmap review", icon: null, position: 0 },
  { id: "3", parentId: "1", title: "", icon: null, position: 1 },
];

describe("rankTitleMatches", () => {
  it("prefers a title that starts with the query", () => {
    expect(rankTitleMatches(notes, "road").map((n) => n.id)).toEqual(["1", "2"]);
    expect(rankTitleMatches(notes, "REVIEW").map((n) => n.id)).toEqual(["2"]);
  });
  it("matches the name a blank title shows as", () => {
    expect(rankTitleMatches(notes, "unt").map((n) => n.id)).toEqual(["3"]);
  });
  it("finds nothing for nothing", () => {
    expect(rankTitleMatches(notes, "  ")).toEqual([]);
  });
});

describe("mergeSearchHits", () => {
  it("lists titles first and each page once", () => {
    const a = { id: "1", parentId: null, title: "A", icon: null };
    const b = { id: "2", parentId: null, title: "B", icon: null, snippet: "…" };
    const aBody = { ...a, snippet: "also in body" };
    expect(mergeSearchHits([a], [aBody, b])).toEqual([a, b]);
  });
});
