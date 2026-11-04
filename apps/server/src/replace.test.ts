import { describe, expect, it } from "vitest";
import { applyReplacements, compilePattern } from "./replace.js";
import { SearchError } from "./search.js";

/** Every occurrence of `needle` on a line, as targets -- what the search would report. */
function targetsOf(content: string, needle: string, line: number) {
  const text = content.split("\n")[line - 1] ?? "";
  const targets = [];
  for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + needle.length)) {
    targets.push({ line, start: at, end: at + needle.length });
  }
  return targets;
}

describe("compilePattern", () => {
  it("escapes a literal query", () => {
    const pattern = compilePattern({ query: "config.get(", regex: false });
    pattern.lastIndex = 0;
    expect(pattern.test("config.get(")).toBe(true);
    pattern.lastIndex = 0;
    expect(pattern.test("configXget(")).toBe(false);
  });

  it("refuses a pattern JavaScript cannot parse", () => {
    expect(() => compilePattern({ query: "(", regex: true })).toThrow(SearchError);
  });
});

describe("applyReplacements", () => {
  it("replaces several keywords with one value", () => {
    const content = "foo = baz(foo)\n";
    const pattern = compilePattern({ query: "foo, baz", regex: false, caseSensitive: true, multi: true });
    const targets = [{ line: 1, start: 0, end: 3 }, { line: 1, start: 6, end: 9 }, { line: 1, start: 10, end: 13 }];
    expect(applyReplacements(content, pattern, "X", targets, false)).toEqual({ content: "X = X(X)\n", replaced: 3, stale: 0 });
  });

  it("takes a keyword inside another whole, as the search found it", () => {
    const pattern = compilePattern({ query: "foo, foobar", regex: false, caseSensitive: true, multi: true });
    const out = applyReplacements("foobar foo", pattern, "X", [{ line: 1, start: 0, end: 6 }, { line: 1, start: 7, end: 10 }], false);
    expect(out).toEqual({ content: "X X", replaced: 2, stale: 0 });
  });

  it("replaces several regular expressions, groups numbered across them", () => {
    const pattern = compilePattern({ query: "a(\\d), b(\\d)", regex: true, caseSensitive: true, multi: true });
    const out = applyReplacements("a1 b2", pattern, "<$1$2>", [{ line: 1, start: 0, end: 2 }, { line: 1, start: 3, end: 5 }], true);
    expect(out).toEqual({ content: "<1> <2>", replaced: 2, stale: 0 });
  });

  it("replaces literal text, metacharacters and all", () => {
    const content = "a.b(1)\na.b(2)\n";
    const pattern = compilePattern({ query: "a.b(", regex: false, caseSensitive: true });
    const out = applyReplacements(content, pattern, "c$1(", [{ line: 1, start: 0, end: 4 }, { line: 2, start: 0, end: 4 }], false);
    expect(out).toEqual({ content: "c$1(1)\nc$1(2)\n", replaced: 2, stale: 0 });
  });

  it("replaces only the occurrences that were ticked", () => {
    const content = "foo foo foo";
    const pattern = compilePattern({ query: "foo", regex: false, caseSensitive: true });
    const [, second] = targetsOf(content, "foo", 1);
    const out = applyReplacements(content, pattern, "bar", [second!], false);
    expect(out.content).toBe("foo bar foo");
  });

  it("replaces several on a line without shifting the rest", () => {
    const content = "x = x + x";
    const pattern = compilePattern({ query: "x", regex: false, caseSensitive: true });
    const out = applyReplacements(content, pattern, "value", targetsOf(content, "x", 1), false);
    expect(out.content).toBe("value = value + value");
    expect(out.replaced).toBe(3);
  });

  it("matches without case unless asked", () => {
    const content = "Token token";
    const loose = compilePattern({ query: "token", regex: false });
    expect(applyReplacements(content, loose, "key", [{ line: 1, start: 0, end: 5 }], false).content).toBe("key token");
    const strict = compilePattern({ query: "token", regex: false, caseSensitive: true });
    expect(applyReplacements(content, strict, "key", [{ line: 1, start: 0, end: 5 }], false)).toMatchObject({
      replaced: 0,
      stale: 1,
    });
  });

  it("expands groups in a regular expression", () => {
    const content = "get(name) get(age)";
    const pattern = compilePattern({ query: "get\\((\\w+)\\)", regex: true, caseSensitive: true });
    const out = applyReplacements(content, pattern, "read($1)", [{ line: 1, start: 10, end: 18 }], true);
    expect(out.content).toBe("get(name) read(age)");
  });

  it("keeps each line's own ending", () => {
    const content = "one\r\ntwo\none\r\n";
    const pattern = compilePattern({ query: "one", regex: false, caseSensitive: true });
    const out = applyReplacements(content, pattern, "1", [{ line: 1, start: 0, end: 3 }, { line: 3, start: 0, end: 3 }], false);
    expect(out.content).toBe("1\r\ntwo\n1\r\n");
  });

  it("leaves a match that moved since the search", () => {
    const content = "  foo\n";
    const pattern = compilePattern({ query: "foo", regex: false, caseSensitive: true });
    const out = applyReplacements(content, pattern, "bar", [{ line: 1, start: 0, end: 3 }, { line: 9, start: 0, end: 3 }], false);
    expect(out).toEqual({ content, replaced: 0, stale: 2 });
  });

  it("counts offsets the way the search reports them, past an emoji", () => {
    const content = "😀 foo";
    const pattern = compilePattern({ query: "foo", regex: false, caseSensitive: true });
    const out = applyReplacements(content, pattern, "bar", targetsOf(content, "foo", 1), false);
    expect(out.content).toBe("😀 bar");
  });
});
