import { describe, expect, it } from "vitest";
import { VERIFIER_CONTEXT, ompVerifierPrompt, parseVerifierReply } from "./omp-roles.js";

const fenced = (value: unknown) => "```json\n" + JSON.stringify(value) + "\n```";

describe("ompVerifierPrompt (solution §6.4)", () => {
  it("asks for one bundled `task` worker, the role in `context`, the brief and the reply format as its task", () => {
    const prompt = ompVerifierPrompt("# Task: Add a toggle\n\nAcceptance: it persists.");
    expect(prompt).toContain('Set `agent: "task"` inside the `tasks[]` item');
    expect(prompt).toContain("exactly **1 task**");
    expect(prompt).toContain(`\`context\` to: ${VERIFIER_CONTEXT}`);
    expect(prompt).toContain("Acceptance: it persists.");
    expect(prompt).toMatch(/"passed": true \| false, "reason": .*"findings": \[\{ "file"/);
    // The brief is before the format, both between the markers.
    expect(prompt.indexOf("Acceptance")).toBeLessThan(prompt.indexOf("```json"));
  });
});

describe("parseVerifierReply", () => {
  it("reads the last fenced verdict, with its findings", () => {
    const reply = [
      "An example of the format:",
      fenced({ passed: true, reason: "example", findings: [] }),
      "My verdict:",
      fenced({ passed: false, reason: "Not persisted.", findings: [{ file: "./src/a.ts", line: 3, note: "No storage." }] }),
    ].join("\n");
    expect(parseVerifierReply(reply)).toEqual({
      passed: false,
      reason: "Not persisted.",
      findings: [{ file: "src/a.ts", line: 3, note: "No storage." }],
    });
  });

  it("reads a bare object at the end, and findings without a line", () => {
    const reply = `Done.\n${JSON.stringify({ passed: false, reason: "", findings: [{ file: "README.md", note: "Not documented." }] })}`;
    expect(parseVerifierReply(reply)).toEqual({
      passed: false,
      reason: "Not documented.",
      findings: [{ file: "README.md", line: null, note: "Not documented." }],
    });
  });

  it("drops a finding that is not one, and keeps the verdict", () => {
    const reply = fenced({ passed: false, reason: "r", findings: [{ file: "a.ts", line: 1, note: "x" }, { note: "no file" }, "text"] });
    expect(parseVerifierReply(reply)?.findings).toEqual([{ file: "a.ts", line: 1, note: "x" }]);
  });

  it("is null without a verdict", () => {
    expect(parseVerifierReply("It looks fine to me.")).toBeNull();
    expect(parseVerifierReply(fenced({ passed: "yes", reason: "r" }))).toBeNull();
    expect(parseVerifierReply("```json\n{ not json\n```")).toBeNull();
  });
});
