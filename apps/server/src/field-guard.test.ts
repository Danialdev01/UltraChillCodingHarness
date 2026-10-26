import { describe, expect, it } from "vitest";
import { staleFields } from "./field-guard.js";

const task = { title: "Ship", startsOn: "2026-10-01", progress: 40, references: [{ kind: "url", url: "https://a" }] };

describe("staleFields", () => {
  it("passes a write whose fields are as the tab saw them", () => {
    expect(staleFields(task, { title: "Ship", progress: 40 })).toEqual([]);
    expect(staleFields(task, { references: [{ kind: "url", url: "https://a" }] })).toEqual([]);
  });

  it("names the fields somebody else changed", () => {
    expect(staleFields(task, { title: "Ship it", progress: 40 })).toEqual(["title"]);
    expect(staleFields(task, { references: [] })).toEqual(["references"]);
  });

  it("ignores the fields the write does not touch", () => {
    // Another person moved the dates; this write only renames.
    expect(staleFields({ ...task, startsOn: "2026-11-01" }, { title: "Ship" })).toEqual([]);
  });

  it("checks nothing without a base", () => {
    expect(staleFields(task, undefined)).toEqual([]);
  });
});
