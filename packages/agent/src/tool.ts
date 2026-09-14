import type { DomainEvent } from "@ucch/protocol";
import type { z } from "zod/v4";
import type { Complete } from "./completion.js";
import type { Executor } from "./executor.js";
import type { ResearchProvider } from "./research.js";
import type { UploadStaging } from "./uploads.js";
import type { WebProvider } from "./web.js";

/**
 * What a tool is and what it is given.
 *
 * Separate from the registry so the two can refer to each other without a
 * cycle: every tool module imports `defineTool` from here, and the registry
 * imports the tools. Putting both halves in one file made the registry
 * import its own importers, which is fragile even where it happens to work.
 */

/** What a tool is given when it runs. */
export interface ToolContext {
  projectId: string;
  threadId: string;
  turnId: string;
  toolUseId: string;
  executor: Executor;
  /** Aborted when the turn is cancelled. Threaded into every subprocess. */
  signal: AbortSignal;
  /** For `file.changed` and `terminal.output`, which tools produce as they act. */
  emit(event: DomainEvent): Promise<void>;
  /** For `web_search`, which is a sub-call to the same provider. */
  apiKey: string;
  model: string;
  /**
   * The model call itself, injected rather than imported: the provider's
   * HTTP client lives on the server side of the package boundary.
   */
  complete: Complete;
  /** Sub-calls run with no tools, so this can never recurse past 1. */
  depth: number;
  /**
   * How `web_search` reaches the web. Injected so the backend can be swapped
   * without touching the tool's schema, which is in the cached prefix.
   */
  web: WebProvider;
  /**
   * The research pipeline -- search, read, browse -- bound to this turn's
   * key. Present only on a research turn; the research tools say so when it
   * is not, which cannot happen through the registry but can through a test.
   */
  research?: ResearchProvider;
  /**
   * Files the person attached, staged outside the workspace until placed.
   * Absent when the harness has no staging configured, which `attach_upload`
   * reports rather than assuming.
   */
  uploads?: UploadStaging;
}

export interface ToolResult {
  /** Exactly what the model sees. Never empty -- several providers reject that. */
  content: string;
  isError?: boolean;
  /** For the chat UI only. Never sent to the model. */
  display?: { title?: string; path?: string; language?: string };
}

/**
 * Whether a call may overlap its siblings.
 *
 * The model asks for several tools at once and the loop has always run them
 * all together, which is right for reads and wrong for everything else: two
 * `edit_file` calls on one path interleave, and the file that lands is
 * whichever finished second. `exclusive` drains the in-flight pool, runs
 * alone, and holds the barrier until its result is committed.
 */
export type ExecutionMode = "safe" | "exclusive";

export interface Tool<I> {
  name: string;
  description: string;
  inputSchema: z.ZodType<I>;
  permission: "read" | "write" | "exec";
  /**
   * Defaults from `permission`: reads overlap, writes and shell commands do
   * not. Set it only where a tool contradicts its own permission -- a read
   * that mutates a cache, a write that is genuinely independent.
   */
  executionMode?: ExecutionMode;
  timeoutMs?: number;
  run(input: I, ctx: ToolContext): Promise<ToolResult>;
}

/** A tool's mode, or the conservative answer for a tool that is not there. */
export function executionModeOf(tool: Tool<unknown> | undefined): ExecutionMode {
  if (!tool) return "exclusive";
  return tool.executionMode ?? (tool.permission === "read" ? "safe" : "exclusive");
}

/**
 * A tool whose input type is not known at the use site.
 *
 * The loop parses arguments as `unknown` and hands them to the tool's own
 * schema, so `Tool<unknown>` would be wrong in the other direction: the tool
 * body legitimately knows its input type. `any` is confined to this alias.
 */
export type AnyTool = Tool<any>;

/** Identity, but it infers `I` from the schema so `run` is typed for free. */
export function defineTool<I>(tool: Tool<I>): Tool<I> {
  return tool;
}

