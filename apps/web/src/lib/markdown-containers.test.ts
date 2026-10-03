import { describe, expect, it } from "vitest";
import {
  containerOpen,
  matchHtmlContainer,
  parseAttrs,
  splitColumns,
} from "./markdown-containers";

describe("matchHtmlContainer", () => {
  it("finds the balancing close tag through nesting", () => {
    const src = '<div data-type="callout" data-emoji="💡">\n\n<div>inner</div>\n\n</div>\n\nafter';
    const m = matchHtmlContainer(src, "div", "callout");
    expect(m?.attrs).toEqual({ "data-type": "callout", "data-emoji": "💡" });
    expect(m?.inner).toBe("\n\n<div>inner</div>\n\n");
    expect(m?.raw.endsWith("</div>")).toBe(true);
    expect(src.slice(m!.raw.length)).toBe("\n\nafter");
  });
  it("refuses another type, an unclosed tag, or text that starts elsewhere", () => {
    expect(matchHtmlContainer('<div data-type="column">x</div>', "div", "callout")).toBeNull();
    expect(matchHtmlContainer('<div data-type="callout">x', "div", "callout")).toBeNull();
    expect(matchHtmlContainer('text <div data-type="callout">x</div>', "div")).toBeNull();
  });
  it("reads a details block with a bare attribute", () => {
    const m = matchHtmlContainer("<details open><summary>S</summary>\n\nbody\n\n</details>", "details");
    expect(m?.attrs).toEqual({ open: "" });
    expect(m?.inner).toContain("<summary>S</summary>");
  });
});

describe("splitColumns", () => {
  it("lists each column's inner markdown", () => {
    const inner =
      '\n<div data-type="column">\n\nleft\n\n</div>\n<div data-type="column">\n\nright <div>x</div>\n\n</div>\n';
    expect(splitColumns(inner)).toEqual(["left", "right <div>x</div>"]);
  });
});

describe("containerOpen and parseAttrs", () => {
  it("round-trip attributes, escaping quotes", () => {
    const open = containerOpen("div", {
      "data-type": "callout",
      "data-emoji": '"',
      "data-color": null,
      open: true,
    });
    expect(open).toBe('<div data-type="callout" data-emoji="&quot;" open>');
    expect(parseAttrs(open.slice(4, -1))).toEqual({
      "data-type": "callout",
      "data-emoji": '"',
      open: "",
    });
  });
});
