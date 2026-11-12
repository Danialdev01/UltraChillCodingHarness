import { z } from "zod";
import { callCollaboration } from "../spawn.js";
import { tool } from "./tool.js";
import { failure } from "../call.js";

const definitions: { name: string; description: string; inputSchema: z.ZodRawShape }[] = [
  { name: "ucch_sessions", description: "Discover authorized sessions and child agents in this project.", inputSchema: {} },
  { name: "ucch_message", description: "Send task data to a session in this project. Use replyTo for replies. Idle sessions wake automatically; active sessions receive a follow-up turn.", inputSchema: { sessionId: z.string().uuid(), text: z.string().trim().min(1).max(60_000), replyTo: z.string().uuid().optional() } },
  { name: "ucch_inbox", description: "Read this session's persistent inbox, using the returned cursor to paginate.", inputSchema: { cursor: z.string().uuid().optional() } },
  { name: "ucch_agent_status", description: "Inspect one of your child agents. End your turn while waiting; completion resumes you.", inputSchema: { sessionId: z.string().uuid() } },
  { name: "ucch_agent_cancel", description: "Stop one of your child agents.", inputSchema: { sessionId: z.string().uuid() } },
];
export const coordinationTools = definitions.map((definition) => tool({ ...definition, annotations: { readOnlyHint: !["ucch_message", "ucch_agent_cancel"].includes(definition.name), openWorldHint: true },
  run: async (args, ctx) => {
    const outcome = await callCollaboration(ctx.config, definition.name, args);
    return "error" in outcome ? failure(outcome.error) : { content: [{ type: "text" as const, text: outcome.text }] };
  },
}));
