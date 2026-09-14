import { describe, expect, it } from "vitest";
import { codeChatPrompt, codeReference } from "./code-chat.js";

describe("the :chat prompt", () => {
  it("names the line and the file before the command", () => {
    expect(codeChatPrompt({ path: "src/app.ts", from: 12, to: 12 }, "rename this")).toBe(
      "refer line 12 inside file src/app.ts, rename this",
    );
  });

  it("writes a selection of several lines as a range", () => {
    expect(codeChatPrompt({ path: "src/app.ts", from: 3, to: 9 }, "explain")).toBe(
      "refer line 3-9 inside file src/app.ts, explain",
    );
  });

  it("trims the command", () => {
    expect(codeChatPrompt({ path: "a.md", from: 1, to: 1 }, "  fix the typo \n")).toBe(
      "refer line 1 inside file a.md, fix the typo",
    );
  });
});

describe("the reference", () => {
  it("orders the lines whichever end the cursor was on", () => {
    expect(codeReference("a.ts", 20, 5)).toEqual({ path: "a.ts", from: 5, to: 20 });
    expect(codeReference("a.ts", 5, 20)).toEqual({ path: "a.ts", from: 5, to: 20 });
  });
});
