import { z } from "zod";
import { runOmpCall } from "../call.js";
import { tool } from "./tool.js";

/**
 * `omp_task`: one of OMP's bundled agents on an assignment, its result
 * returned (solution §10.2). Bundled agents only: UCCH runs `--no-extensions`,
 * under which no other agent file loads (§6.4).
 */
export const ompTask = tool({
  name: "omp_task",
  description: [
    "Hands an assignment to one of OMP's subagents and returns what it found.",
    "`scout` explores and summarises (read-only, cheap): use it before reading more than about ten files yourself.",
    "`reviewer` and `security-reviewer` review code and report findings without changing it.",
    "`sonic` makes a small, well-specified change itself.",
    "Takes 10-60 s and costs tokens; not for small lookups.",
  ].join(" "),
  inputSchema: {
    agent: z.enum(["scout", "reviewer", "security-reviewer", "sonic"]),
    assignment: z.string().min(1).describe("What the subagent should do, self-contained: it cannot see this conversation."),
    files: z.array(z.string()).optional().describe("Files to start from, relative to the project root."),
  },
  annotations: { title: "OMP subagent", openWorldHint: false },
  run: ({ agent, assignment, files }, ctx) => {
    const tools = ["read", "grep", "glob", "lsp", "task"];
    if (agent === "sonic") tools.push("edit", "write");
    if (agent === "scout" && ctx.config.webSearch) tools.push("web_search");
    const start = files?.length ? `\n\nStart from these files: ${files.map((file) => `\`${file}\``).join(", ")}.` : "";
    return runOmpCall(ctx, {
      tools,
      model: "@smol",
      prompt: `Use the \`${agent}\` subagent: ${assignment}${start}\n\nReturn the subagent's result as it gave it.`,
      answer: { subagents: true },
    });
  },
});
