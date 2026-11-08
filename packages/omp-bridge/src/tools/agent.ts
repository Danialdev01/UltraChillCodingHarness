import { UCCH_AGENT_ARGS, UCCH_AGENT_DESCRIPTION, UCCH_AGENT_TOOL } from "@ucch/protocol";
import { z } from "zod";
import { failure } from "../call.js";
import { spawnSubagent } from "../spawn.js";
import { tool } from "./tool.js";

/**
 * `ucch_agent`: a subagent on any harness or model, run by the UCCH server
 * as a session of its own (`spawn.ts`), its final answer returned.
 */
export const ucchAgent = tool({
  name: UCCH_AGENT_TOOL,
  description: UCCH_AGENT_DESCRIPTION,
  inputSchema: {
    description: z.string().min(1).max(200).describe(UCCH_AGENT_ARGS.description),
    task: z.string().min(1).max(60_000).describe(UCCH_AGENT_ARGS.task),
    model: z.string().max(200).optional().describe(UCCH_AGENT_ARGS.model),
  },
  annotations: { title: "Subagent (any harness)", openWorldHint: true },
  run: async ({ description, task, model }, ctx) => {
    const outcome = await spawnSubagent(ctx.config, { description, task, model });
    if ("error" in outcome) return failure(`ucch_agent: ${outcome.error}`);
    return { content: [{ type: "text", text: outcome.text || "(the subagent finished without a reply)" }] };
  },
});
