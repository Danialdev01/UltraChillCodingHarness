import { z } from "zod";
import { runOmpCall } from "../call.js";
import { tool } from "./tool.js";

/**
 * `omp_handoff_brief`: a handoff brief written from the calling CLI's own
 * account of its session (solution §10.2). The bridge cannot read the CLI's
 * transcript, so the CLI passes it in. No tools: the brief is written from
 * what it is given, as the server's brief is (§5.4).
 */
export const ompHandoffBrief = tool({
  name: "omp_handoff_brief",
  description: [
    "Writes a handoff brief another agent can carry on from: the work done so far, the decisions that matter, and the next steps.",
    "Pass your own summary of this session as `transcript`.",
  ].join(" "),
  inputSchema: {
    transcript: z.string().min(1).describe("This session so far, in your words: what was asked, what was done, what is left."),
    focus: z.string().optional().describe("What the next agent should concentrate on."),
  },
  annotations: { title: "OMP handoff brief", readOnlyHint: true, openWorldHint: false },
  run: ({ transcript, focus }, ctx) => {
    const prompt = [
      "Write a handoff brief for another coding agent that will carry this work on in the same files, from the session below.",
      "Cover the work completed so far, the decisions that matter and why, and the next steps, in that order.",
      "Name files and commands exactly. Leave out anything the next agent can see for itself in the code.",
      ...(focus ? [`Focus on: ${focus}`] : []),
      "",
      "<session>",
      transcript,
      "</session>",
    ].join("\n");
    return runOmpCall(ctx, { tools: [], model: "@smol", prompt, answer: {} });
  },
});
