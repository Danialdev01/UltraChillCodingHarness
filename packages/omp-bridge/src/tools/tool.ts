import { createHash } from "node:crypto";
import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import type { z } from "zod";
import type { CallContext } from "../call.js";
import { ompEnv } from "../config.js";

/** One bridge tool: its MCP face and what it runs (solution §10.2). */
export interface BridgeTool<Shape extends z.ZodRawShape = z.ZodRawShape> {
  name: string;
  description: string;
  inputSchema: Shape;
  annotations: ToolAnnotations;
  run(input: z.objectOutputType<Shape, z.ZodTypeAny>, ctx: CallContext): Promise<CallToolResult>;
}

export function tool<Shape extends z.ZodRawShape>(definition: BridgeTool<Shape>): BridgeTool<Shape> {
  return definition;
}

/** A result with its text parts rewritten. */
export function withText(result: CallToolResult, change: (text: string) => string): CallToolResult {
  return { ...result, content: result.content.map((part) => (part.type === "text" ? { ...part, text: change(part.text) } : part)) };
}

/** A position in a file, as a prompt names it. */
export function where(file: string | undefined, line: number | undefined): string {
  if (!file) return "";
  return line ? ` in \`${file}\` at line ${line}` : ` in \`${file}\``;
}

/** A git command in the worktree, its stdout, or null when it fails (not a repository, a bad ref). */
export async function git(ctx: CallContext, args: readonly string[]): Promise<string | null> {
  try {
    const result = await ctx.host.run(
      { argv: ["git", "-C", ctx.config.worktree, ...args], cwd: ctx.config.worktree, env: ompEnv(ctx.config, ctx.parentEnv) },
      { timeoutMs: 30_000 },
    );
    return result.code === 0 ? result.stdout : null;
  } catch {
    return null;
  }
}

/**
 * What the worktree holds, as a hash of its status and its diff: compared
 * before and after a call that must change nothing, so one that did anyway
 * is reported rather than passed off as a preview. Null outside a git
 * repository, where there is nothing to compare.
 */
export async function worktreeState(ctx: CallContext): Promise<string | null> {
  const status = await git(ctx, ["status", "--porcelain=v1", "-uall"]);
  const diff = await git(ctx, ["diff", "--no-ext-diff", "HEAD"]);
  if (status === null || diff === null) return null;
  return createHash("sha256").update(status).update("\0").update(diff).digest("hex");
}
