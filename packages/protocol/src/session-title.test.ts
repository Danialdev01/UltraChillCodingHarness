import { describe, expect, it } from "vitest";

import { SESSION_TITLE_MAX, isPlaceholderTitle, titleFromPrompt } from "./session-title.js";

describe("titleFromPrompt", () => {
  it("takes the first line with words in it", () => {
    expect(titleFromPrompt("\n\nidentify project purpose\nand then more")).toBe("Identify project purpose");
  });

  it("drops markdown, slash commands and trailing punctuation", () => {
    expect(titleFromPrompt("## Fix **the** `build`!")).toBe("Fix the build");
    expect(titleFromPrompt("/plan add a login page.")).toBe("Add a login page");
    expect(titleFromPrompt("- [docs](https://x.dev) need work")).toBe("Docs need work");
  });

  it("names a mentioned file by its basename", () => {
    expect(titleFromPrompt("refactor @apps/web/src/lib/client.ts")).toBe("Refactor client.ts");
  });

  it("skips code fences and attached blocks", () => {
    expect(titleFromPrompt("```ts\nconst a = 1\n```\nwhy does this fail")).toBe("Why does this fail");
    expect(titleFromPrompt('<file path="a.ts">x</file>\nexplain a.ts')).toBe("Explain a.ts");
  });

  it("cuts long lines at a word boundary", () => {
    const title = titleFromPrompt("please ".repeat(30))!;
    expect(title.length).toBeLessThanOrEqual(SESSION_TITLE_MAX);
    expect(title.endsWith("Please…") || title.endsWith("please…")).toBe(true);
  });

  it("returns null when nothing is left", () => {
    expect(titleFromPrompt("")).toBeNull();
    expect(titleFromPrompt("```\nonly code\n```")).toBeNull();
    expect(titleFromPrompt("https://example.com")).toBeNull();
  });
});

describe("isPlaceholderTitle", () => {
  it("knows the names a session starts with", () => {
    expect(isPlaceholderTitle("Untitled")).toBe(true);
    expect(isPlaceholderTitle("New session")).toBe(true);
    expect(isPlaceholderTitle(" ")).toBe(true);
    expect(isPlaceholderTitle("Fix the build")).toBe(false);
  });
});
