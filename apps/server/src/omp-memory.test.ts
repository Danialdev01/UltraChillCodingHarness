import { describe, expect, it } from "vitest";
import { messageText, RETAIN_ANSWER_CHARS, RETAIN_PROMPT, retainStdin } from "./omp-memory.js";

describe("end-of-turn retention (solution §7.3)", () => {
  it("reads a message's text blocks and nothing else", () => {
    expect(messageText([{ type: "text", text: "A." }, { type: "tool_use", name: "Bash", input: { command: "ls" } }, { type: "text", text: "B." }])).toBe("A.\n\nB.");
    expect(messageText([{ type: "tool_use", name: "Bash" }])).toBeNull();
    expect(messageText([{ type: "text", text: "  " }, { type: "thinking", thinking: "hm" }, null, "x"])).toBeNull();
  });

  it("hands the answer over whole, or cut at its limit", () => {
    expect(retainStdin("Use pnpm.")).toBe("<answer>\nUse pnpm.\n</answer>\n");
    const long = retainStdin("x".repeat(RETAIN_ANSWER_CHARS + 10));
    expect(long).toBe(`<answer>\n${"x".repeat(RETAIN_ANSWER_CHARS)}\n[… cut]\n</answer>\n`);
  });

  it("asks for durable project facts only, and never secrets", () => {
    expect(RETAIN_PROMPT).toContain("retain tool once, with project scope");
    expect(RETAIN_PROMPT).toContain("Never retain secrets");
  });
});
