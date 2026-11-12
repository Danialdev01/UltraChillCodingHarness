import { z } from "zod/v4";
import { defineTool } from "../tool.js";

export const coordinationTools = [
  defineTool({ name: "ucch_agent", description: "Start a subagent on a requested model across harnesses. Use background=true to coordinate while it works. Subscription usage above 90% falls back to the same model on OMP/OpenRouter.", permission: "exec", timeoutMs: 3_600_000,
    inputSchema: z.strictObject({ description: z.string().min(1).max(200), task: z.string().min(1).max(60_000), model: z.string().max(200).nullable(), background: z.boolean().nullable() }),
    run: (args, ctx) => ctx.coordination!("ucch_agent", args, ctx) }),
  defineTool({ name: "ucch_sessions", description: "Discover authorized sessions and child agents in this project, with IDs, models and status.", permission: "read",
    inputSchema: z.strictObject({}), run: (args, ctx) => ctx.coordination!("ucch_sessions", args, ctx) }),
  defineTool({ name: "ucch_message", description: "Send task data to a project session ID. Supply replyTo when answering an incoming message. Messages wake idle recipients; active sessions receive them on a follow-up turn.", permission: "exec",
    inputSchema: z.strictObject({ sessionId: z.string().uuid(), text: z.string().min(1).max(60_000), replyTo: z.string().uuid().nullable() }),
    run: (args, ctx) => ctx.coordination!("ucch_message", args, ctx) }),
  defineTool({ name: "ucch_inbox", description: "Read the persistent inbox. Use the returned cursor for subsequent pages.", permission: "read",
    inputSchema: z.strictObject({ cursor: z.string().uuid().nullable() }), run: (args, ctx) => ctx.coordination!("ucch_inbox", args, ctx) }),
  ...["ucch_agent_status", "ucch_agent_cancel"].map((name) => defineTool({ name,
    description: name.endsWith("status") ? "Inspect a child agent's current status and result. End your turn while waiting; completion resumes you." : "Stop one of this session's child agents.",
    permission: name.endsWith("status") ? "read" as const : "exec" as const,
    inputSchema: z.strictObject({ sessionId: z.string().uuid() }), run: (args, ctx) => ctx.coordination!(name, args, ctx) })),
];
