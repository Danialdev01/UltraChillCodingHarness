import { describe, expect, it } from "vitest";
import { looksLikeMarkdown } from "./markdown-paste";

describe("looksLikeMarkdown", () => {
  it("recognises block syntax", () => {
    expect(looksLikeMarkdown("## Heading\n\ntext")).toBe(true);
    expect(looksLikeMarkdown("- one\n- two")).toBe(true);
    expect(looksLikeMarkdown("1. first")).toBe(true);
    expect(looksLikeMarkdown("```js\nx\n```")).toBe(true);
    expect(looksLikeMarkdown("| a | b |\n|---|---|")).toBe(true);
  });

  it("leaves ordinary prose alone", () => {
    expect(looksLikeMarkdown("just a sentence")).toBe(false);
    expect(looksLikeMarkdown("a * b = c")).toBe(false);
    expect(looksLikeMarkdown("two lines\nof prose")).toBe(false);
    expect(looksLikeMarkdown("x - y")).toBe(false);
  });
});
