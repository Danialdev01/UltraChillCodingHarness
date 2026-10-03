import { describe, expect, it } from "vitest";
import { markdownFileName, markdownWithTitle, splitMarkdownTitle } from "./markdown-file";

describe("markdownFileName", () => {
  it("strips what a filesystem refuses", () => {
    expect(markdownFileName('Plan: v2 / "final"?')).toBe("Plan v2 final.md");
    expect(markdownFileName("   ")).toBe("Untitled.md");
    expect(markdownFileName("x".repeat(100))).toBe(`${"x".repeat(80)}.md`);
  });
});

describe("markdownWithTitle", () => {
  it("puts the title first as a heading", () => {
    expect(markdownWithTitle("Hello", "body")).toBe("# Hello\n\nbody");
    expect(markdownWithTitle("  ", "\n\nbody")).toBe("body");
  });
});

describe("splitMarkdownTitle", () => {
  it("takes a leading heading as the title", () => {
    expect(splitMarkdownTitle("# Hello\n\nbody")).toEqual({ title: "Hello", body: "body" });
    expect(splitMarkdownTitle("﻿# Hello\nbody")).toEqual({ title: "Hello", body: "body" });
  });
  it("leaves a file without one alone", () => {
    expect(splitMarkdownTitle("body\n# not first")).toEqual({
      title: null,
      body: "body\n# not first",
    });
    expect(splitMarkdownTitle("## Sub\n")).toEqual({ title: null, body: "## Sub\n" });
  });
});
