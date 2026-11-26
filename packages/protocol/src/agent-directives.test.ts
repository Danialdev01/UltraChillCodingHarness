import { describe, expect, it } from "vitest";
import { councilSize, directiveText, parseDirectives } from "./agent-directives.js";
import { ATTACHMENTS_MARKER } from "./attachments.js";

describe("parseDirectives", () => {
  it("leaves an ordinary message alone", () => {
    expect(parseDirectives("fix  the bug\n")).toEqual({ text: "fix  the bug\n", ranges: [], errors: [] });
  });

  it.each([
    ["do X @reviewer", "do X", { models: [], fix: false, previous: false }],
    ["@reviewer do X", "do X", { models: [], fix: false, previous: false }],
    ["do X @Reviewer(gpt-5, FIX) please", "do X please", { models: ["gpt-5"], fix: true, previous: false }],
    ["do X @reviewer(opus, gpt-5)", "do X", { models: ["opus", "gpt-5"], fix: false, previous: false }],
    ["do X @reviewer(same)", "do X", { models: ["same"], fix: false, previous: false }],
    ["do X @reviewer(auto).", "do X .", { models: [], fix: false, previous: false }],
    ["@reviewer", "", { models: [], fix: false, previous: true }],
    ["@reviewer(fix)!", "", { models: [], fix: true, previous: true }],
  ])("reads %s", (message, text, reviewer) => {
    const parsed = parseDirectives(message);
    expect(parsed.errors).toEqual([]);
    expect(parsed.text).toBe(text);
    expect(parsed.reviewer).toEqual(reviewer);
  });

  it.each([
    ["@council should we?", { models: [], size: null, rounds: null, implement: false }],
    ["@council(4) should we?", { models: [], size: 4, rounds: null, implement: false }],
    ["@council(3, rounds=2) should we?", { models: [], size: 3, rounds: 2, implement: false }],
    ["@council(opus, gpt-5, gemini-2.5-pro, implement), should we?", { models: ["opus", "gpt-5", "gemini-2.5-pro"], size: null, rounds: null, implement: true }],
  ])("reads %s", (message, council) => {
    const parsed = parseDirectives(message);
    expect(parsed.errors).toEqual([]);
    expect(parsed.text).toBe("should we?");
    expect(parsed.council).toEqual(council);
  });

  it.each([
    "mail me@reviewer.com",
    "see @reviewer.md",
    "see @reviewer/notes.ts",
    "see @reviewers",
    "type `@reviewer` here",
    "```\n@council hi\n```",
    "text\n```ts\n@reviewer\n",
    "~~~\n@reviewer\n~~~",
  ])("does not read %j", (message) => {
    expect(parseDirectives(message)).toEqual({ text: message, ranges: [], errors: [] });
  });

  it("reads a mention after a code fence", () => {
    const parsed = parseDirectives("```\n@council\n```\ngo @reviewer");
    expect(parsed.text).toBe("```\n@council\n```\ngo");
    expect(parsed.reviewer).toBeDefined();
    expect(parsed.council).toBeUndefined();
  });

  it("keeps the lines around a mention", () => {
    expect(parseDirectives("do\n@reviewer\n- a\n- b").text).toBe("do\n\n- a\n- b");
    expect(parseDirectives("do @council this\nand that").text).toBe("do this\nand that");
  });

  it.each([
    ["x @reviewer(a, b, c, d)", /at most 3/],
    ["x @reviewer(2)", /takes model names/],
    ["x @reviewer @reviewer", /one @reviewer/],
    ["x @reviewer(gpt", /Close the parenthesis/],
    ["x @council(1)", /2 to 5/],
    ["x @council(6)", /2 to 5/],
    ["x @council(rounds=4)", /rounds=0 to rounds=3/],
    ["x @council(fix)", /not fix/],
    ["x @council(2, a, b, c)", /3 models for 2/],
    ["@council", /Ask the council a question/],
    ["@council @reviewer", /Ask the council a question/],
  ])("refuses %s", (message, error) => {
    expect(parseDirectives(message).errors[0]?.message).toMatch(error);
  });

  it("gives the mention's place in the message", () => {
    expect(parseDirectives("do @reviewer(gpt-5) it").ranges).toEqual([{ kind: "reviewer", start: 3, end: 19 }]);
  });

  it("never reads what an attachment says, and keeps it", () => {
    const block = `${ATTACHMENTS_MARKER}\n[]\nplease @council decide`;
    expect(parseDirectives(`look\n\n${block}`)).toEqual({ text: `look\n\n${block}`, ranges: [], errors: [] });
    const parsed = parseDirectives(`look @reviewer\n\n${block}`);
    expect(parsed.text).toBe(`look\n\n${block}`);
    expect(parseDirectives(`@reviewer\n\n${block}`).reviewer?.previous).toBe(false);
  });
});

describe("councilSize", () => {
  const council = { models: [] as string[], size: null, rounds: null, implement: false };
  it("is what was asked, then what was named, then the default", () => {
    expect(councilSize(council)).toBe(3);
    expect(councilSize(council, 5)).toBe(5);
    expect(councilSize({ ...council, models: ["a"] })).toBe(3);
    expect(councilSize({ ...council, models: ["a", "b"] })).toBe(2);
    expect(councilSize({ ...council, models: ["a", "b"], size: 4 })).toBe(4);
  });
});

it("writes a mention back as it would be typed", () => {
  expect(directiveText("reviewer", { models: ["gpt-5"], fix: true })).toBe("@reviewer(gpt-5, fix)");
  expect(directiveText("council", { models: [], size: 4, rounds: 2 })).toBe("@council(4, rounds=2)");
});
