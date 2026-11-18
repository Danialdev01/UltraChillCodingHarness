import { z } from "zod";
import { callCollaboration } from "../spawn.js";
import { tool } from "./tool.js";
import { failure } from "../call.js";

const definitions: { name: string; description: string; inputSchema: z.ZodRawShape }[] = [
  { name: "ucch_sessions", description: "List every session in this workspace -- across all its projects, whether active, archived or settled -- with IDs, titles, projects, state and status. Pass query to match titles and project names.", inputSchema: { query: z.string().max(200).optional() } },
  { name: "ucch_session_read", description: "Read a workspace session's latest conversation: its last turns' prompts and replies. Works on active, archived and settled sessions.", inputSchema: { sessionId: z.string().uuid(), turns: z.number().int().min(1).max(10).optional() } },
  { name: "ucch_message", description: "Send a prompt or task data to any session in this workspace. An archived or settled session becomes active again and runs it. Use replyTo for replies. Idle sessions wake automatically; busy sessions receive a follow-up turn.", inputSchema: { sessionId: z.string().uuid(), text: z.string().trim().min(1).max(60_000), replyTo: z.string().uuid().optional() } },
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
