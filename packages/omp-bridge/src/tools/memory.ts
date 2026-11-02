import { z } from "zod";
import { failure, runOmpCall } from "../call.js";
import { tool } from "./tool.js";

/**
 * `omp_recall` / `omp_retain`: the project's OMP memory (solution §10.2,
 * §7.3). On `@smol`: 18.14.1 has no `tiny` role (`default, smol, slow,
 * plan, vision, commit`), so `@tiny` would fail as an unknown model.
 *
 * Only when the workspace keeps memory: without `memory.backend`, OMP has
 * no `recall` or `retain`, and refuses to start a session whose `--tools`
 * names them.
 */
const MEMORY_OFF = "OMP memory is off for this workspace, so there is nothing to recall or retain";

export const ompRecall = tool({
  name: "omp_recall",
  description: "Searches the project's long-term memory -- conventions, decisions and lessons kept from earlier sessions -- and returns the matching entries. Use it at the start of unfamiliar work.",
  inputSchema: { query: z.string().min(1) },
  annotations: { title: "OMP recall", readOnlyHint: true, openWorldHint: false },
  run: ({ query }, ctx) => {
    if (!ctx.config.memory) return Promise.resolve(failure(MEMORY_OFF));
    return runOmpCall(ctx, {
      tools: ["recall"],
      model: "@smol",
      prompt: `Using the recall tool, search memory for: ${query}\n\nReturn the matching entries as they are, most relevant first. If nothing matches, say so.`,
      answer: { toolResults: ["recall"] },
    });
  },
});

export const ompRetain = tool({
  name: "omp_retain",
  description: "Keeps a durable fact about this project -- a convention, a decision or a lesson -- in its long-term memory, for later sessions. Not for the state of the current task.",
  inputSchema: {
    fact: z.string().min(1).describe("Self-contained: what, and why."),
    kind: z.enum(["convention", "decision", "lesson"]).optional(),
  },
  annotations: { title: "OMP retain", openWorldHint: false },
  run: ({ fact, kind }, ctx) => {
    if (!ctx.config.memory) return Promise.resolve(failure(MEMORY_OFF));
    return runOmpCall(ctx, {
      tools: ["retain"],
      model: "@smol",
      prompt: `Using the retain tool once, store this ${kind ?? "fact"} with project scope, as written:\n\n${fact}\n\nThen confirm it in one line.`,
      answer: {},
    });
  },
});
