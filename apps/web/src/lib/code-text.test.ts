import { describe, expect, it } from "vitest";
import { nodeLanguage, nodeText, type SyntaxNode } from "./code-text.js";

/** What remark hands a `pre` component for ```lang … ``` */
const fence = (code: string, language?: string): SyntaxNode => ({
  type: "element",
  tagName: "pre",
  children: [
    {
      type: "element",
      tagName: "code",
      properties: language ? { className: [`language-${language}`] } : {},
      children: [{ type: "text", value: code }],
    },
  ],
});

describe("reading the source back out", () => {
  it("returns exactly what was between the fences", () => {
    const code = "const a = 1\nconst b = 2\n";
    expect(nodeText(fence(code, "ts"))).toBe(code);
  });

  it("keeps the whitespace that makes the code work", () => {
    // Indentation and the trailing newline are the two a reader would have
    // to repair by hand if the copy dropped them.
    const python = "def main():\n    return 1\n";
    expect(nodeText(fence(python, "python"))).toBe(python);
  });

  it("joins split text nodes with nothing between them", () => {
    // A tree built in more than one piece must not gain characters the file
    // does not contain.
    const split: SyntaxNode = {
      type: "element",
      tagName: "pre",
      children: [
        {
          type: "element",
          tagName: "code",
          children: [
            { type: "text", value: "const a" },
            { type: "text", value: " = 1\n" },
          ],
        },
      ],
    };
    expect(nodeText(split)).toBe("const a = 1\n");
  });

  it("has something to return for a tree that is not there", () => {
    expect(nodeText(null)).toBe("");
    expect(nodeText(undefined)).toBe("");
    expect(nodeText({ type: "element", tagName: "pre" })).toBe("");
    expect(nodeText({ type: "element", tagName: "pre", children: null })).toBe("");
  });
});

describe("reading the language", () => {
  it("takes it from the class remark writes on the code element", () => {
    expect(nodeLanguage(fence("x", "ts"))).toBe("ts");
    expect(nodeLanguage(fence("x", "python"))).toBe("python");
  });

  it("lowercases it, so ```JSON and ```json label the same", () => {
    expect(nodeLanguage(fence("{}", "JSON"))).toBe("json");
  });

  it("finds it among other classes, in any position", () => {
    const styled: SyntaxNode = {
      type: "element",
      tagName: "pre",
      children: [
        {
          type: "element",
          tagName: "code",
          properties: { className: ["hljs", "language-rust", "line-numbers"] },
          children: [{ type: "text", value: "fn main() {}" }],
        },
      ],
    };
    expect(nodeLanguage(styled)).toBe("rust");
  });

  it("accepts a class written as one string rather than a list", () => {
    // hast normalises to an array, but a tree built by hand or by another
    // plugin can carry the string form.
    const single: SyntaxNode = {
      type: "element",
      tagName: "pre",
      children: [
        {
          type: "element",
          tagName: "code",
          properties: { className: "language-go" },
          children: [],
        },
      ],
    };
    expect(nodeLanguage(single)).toBe("go");
  });

  it("returns null for an unlabelled fence rather than guessing one", () => {
    expect(nodeLanguage(fence("plain text"))).toBeNull();
    expect(nodeLanguage(null)).toBeNull();
    expect(nodeLanguage({ type: "element", tagName: "pre", children: [] })).toBeNull();
  });

  it("is not fooled by a class that merely starts the same way", () => {
    const decoy: SyntaxNode = {
      type: "element",
      tagName: "pre",
      children: [
        {
          type: "element",
          tagName: "code",
          properties: { className: ["languages-many", "language-c"] },
          children: [],
        },
      ],
    };
    expect(nodeLanguage(decoy)).toBe("c");
  });
});
