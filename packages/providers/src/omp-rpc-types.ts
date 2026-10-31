/**
 * The frames of OMP's RPC protocol ([rpc](https://omp.sh/docs/rpc)), as the
 * pinned version (18.14.1) sends them. Field names are the ones recorded in
 * `fixtures/omp-*.jsonl`, not guesses from the docs.
 *
 * Every frame keeps an open index: OMP adds fields between versions, and a
 * field this file does not name is passed along, never an error (solution
 * §2 rule 5). Only what UCCH reads is spelled out.
 */

/** Anything on OMP's stdout, after `rpc_chunk` reassembly. */
export interface OmpFrame {
  type: string;
  [key: string]: unknown;
}

/** The first frame; nothing may be sent before it. */
export interface OmpReady extends OmpFrame {
  type: "ready";
  protocolVersion: number;
  supportedProtocolVersions?: number[];
  /** The largest frame either side may send unchunked (1 MiB in v1). */
  maxFrameBytes?: number;
  /** The largest frame `rpc_chunk` slices may add up to (64 MiB). */
  maxReassembledFrameBytes?: number;
}

/** The answer to a command, matched to it by `id`, never by order. */
export interface OmpResponse<T = unknown> extends OmpFrame {
  type: "response";
  id?: string;
  command: string;
  success: boolean;
  data?: T;
  error?: string;
}

/**
 * One slice of a frame too large to send whole (protocol v2). `data` is
 * base64 of a slice of the UTF-8 frame; `byteLength` is the whole frame's
 * length, the same on every slice; slices arrive in `index` order.
 */
export interface OmpChunk extends OmpFrame {
  type: "rpc_chunk";
  chunkId: string;
  index: number;
  count: number;
  byteLength: number;
  data: string;
}

/**
 * Not OMP's: what the client hands on when a chunked frame cannot be put
 * back together, so the provider can fail the turn with a reason instead of
 * waiting for a frame that will never come.
 */
export interface OmpFrameError extends OmpFrame {
  type: "rpc_frame_error";
  chunkId: string;
  error: string;
}

/** A prompt has been taken; `isTerminal: false` means background work is still running. */
export interface OmpAgentEnd extends OmpFrame {
  type: "agent_end";
  isTerminal?: boolean;
  messages?: unknown[];
}

/** How a prompt ended; `status: "error"` is a failed turn even though OMP exits 0. */
export interface OmpPromptResult extends OmpFrame {
  type: "prompt_result";
  id?: string;
  agentInvoked?: boolean;
  status?: "completed" | "error" | string;
  error?: { message?: string; provider?: string; model?: string; retryable?: boolean; httpStatus?: number };
  sessionSettled?: boolean;
}

export interface OmpToolExecutionStart extends OmpFrame {
  type: "tool_execution_start";
  toolCallId: string;
  toolName: string;
  args?: Record<string, unknown>;
  intent?: string;
}

export interface OmpToolResult {
  content?: { type: string; text?: string; [key: string]: unknown }[];
  details?: unknown;
  [key: string]: unknown;
}

export interface OmpToolExecutionEnd extends OmpFrame {
  type: "tool_execution_end";
  toolCallId: string;
  toolName: string;
  result?: OmpToolResult;
  isError?: boolean;
}

/**
 * A question for the host. Approvals are `method: "select"` with a title
 * starting `Allow tool:`; `setWidget` and the like need no answer.
 */
export interface OmpUiRequest extends OmpFrame {
  type: "extension_ui_request";
  id: string;
  method: string;
  title?: string;
  options?: string[];
}

/** A call to one of the tools UCCH registered with `set_host_tools`. */
export interface OmpHostToolCall extends OmpFrame {
  type: "host_tool_call";
  id: string;
  toolCallId: string;
  toolName: string;
  arguments: Record<string, unknown>;
}

/** A command; the client adds the `id`. */
export type OmpCommand =
  | { type: "prompt"; message: string; [key: string]: unknown }
  | { type: "abort" }
  | { type: "get_state" }
  | { type: "get_session_stats" }
  | { type: "get_messages" }
  | { type: "get_subagents" }
  | { type: "compact"; customInstructions?: string }
  | { type: "handoff"; customInstructions?: string }
  | { type: "new_session" }
  | { type: "switch_session"; sessionPath: string }
  | { type: "negotiate_protocol"; protocolVersion: number }
  | { type: "set_subagent_subscription"; level: "off" | "lifecycle" | "progress" | string }
  | { type: "set_host_tools"; tools: OmpHostToolSpec[] }
  | { type: string; [key: string]: unknown };

/** A host tool as `set_host_tools` takes it: JSON Schema parameters. */
export interface OmpHostToolSpec {
  name: string;
  label: string;
  description: string;
  parameters: Record<string, unknown>;
}

/** Frames the host sends that are answers, not commands: no `id` of the client's own. */
export type OmpClientFrame =
  | { type: "extension_ui_response"; id: string; value?: string; cancelled?: boolean; [key: string]: unknown }
  | { type: "host_tool_result"; id: string; result: OmpToolResult; isError?: boolean }
  | { type: "host_tool_update"; id: string; partialResult: OmpToolResult };
