import { z } from "zod";
import { failure, runOmpCall } from "../call.js";
import { tool, untrusted } from "./tool.js";

/**
 * `omp_debug`: a debugging session with OMP's `debug` tool (DAP), returning
 * what it found and no fix (solution §10.2). On the workspace's default
 * model: reading a live program's state is not a job for the small one.
 */
export const ompDebug = tool({
  name: "omp_debug",
  description: [
    "Investigates a bug at runtime with a debugger: launches or attaches to a program, sets breakpoints, inspects stacks and variables,",
    "and reports what it observed and the likely cause. Fixes nothing. For bugs that reading the code has not explained.",
  ].join(" "),
  inputSchema: {
    goal: z.string().min(1).describe("What to find out."),
    program: z.string().optional().describe("The program to launch, relative to the project root."),
    args: z.array(z.string()).optional(),
    attachPid: z.number().int().positive().optional().describe("A running process to attach to instead."),
    breakpoints: z
      .array(z.object({ file: z.string(), line: z.number().int().positive(), condition: z.string().optional() }))
      .optional(),
  },
  annotations: { title: "OMP debug", openWorldHint: false },
  run: ({ goal, program, args, attachPid, breakpoints }, ctx) => {
    if (!ctx.config.trusted) return Promise.resolve(failure(untrusted("debugging")));
    const lines = [
      `Using the debug tool, investigate: ${goal}`,
      attachPid ? `Attach to process ${attachPid}.` : program ? `Launch \`${program}\`${args?.length ? ` with arguments ${JSON.stringify(args)}` : ""}.` : "",
      ...(breakpoints ?? []).map((bp) => `Break at \`${bp.file}:${bp.line}\`${bp.condition ? ` when \`${bp.condition}\`` : ""}.`),
      "Report what you observed -- the state at each stop that matters -- and the likely cause. Do not change any file, and terminate the debug session before you answer.",
    ].filter(Boolean);
    return runOmpCall(ctx, { tools: ["debug", "read", "bash", "grep"], model: "@default", prompt: lines.join("\n"), answer: {} });
  },
});
