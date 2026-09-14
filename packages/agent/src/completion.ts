import type { TokenUsage } from "@ucch/protocol";
import type { ToolSchema } from "./schema.js";

/**
 * The vocabulary of one model call.
 *
 * These types live here rather than in the server's transport module because
 * two things inside this package need them and neither may reach into
 * `apps/server`: `web_search`, which is a sub-call to the same provider, and
 * the loop, which is handed a completion function rather than importing one.
 * `apps/server/src/openrouter.ts` re-exports them, so there is exactly one
 * definition and nothing to drift.
 */

/**
 * One tool call as the wire carries it.
 *
 * `arguments` is a JSON *string* and stays one the whole way through:
 * re-stringifying a parsed object reorders keys and respaces separators, and
 * a replayed conversation one byte different from the original loses the
 * prompt cache for the whole turn.
 */
export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

/**
 * One span of a system message.
 *
 * `cacheable` is a harness-side marker, not wire format: it says "a reusable
 * prefix ends here", and the transport decides what that means for the
 * provider it is talking to. Splitting the system prompt into spans is the
 * whole point -- a volatile span at the end then costs only itself, where a
 * single joined string made the file tree re-bill the harness rules.
 */
export interface TextPart {
  type: "text";
  text: string;
  cacheable?: boolean;
}

/**
 * A picture in a message, in the shape the API accepts.
 *
 * `url` is a `data:` URL rather than a link back to this harness. A provider
 * fetching an image would have to reach a host that is not public, with a
 * credential it does not have, and the bytes are already here.
 */
export interface ImagePart {
  type: "image_url";
  image_url: { url: string };
}

/** What a user message may be made of: text, and pictures. */
export type UserContentPart = TextPart | ImagePart;

/** The conversation, in exactly the shape the API accepts. */
export type ChatMessage =
  | { role: "system"; content: string | TextPart[] }
  | { role: "user"; content: string | UserContentPart[] }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

export type ToolChoice =
  | "auto"
  | "none"
  | "required"
  | { type: "function"; function: { name: string } };

/** A provider plugin, such as `{ id: "web" }` for the search tool. */
export interface Plugin {
  id: string;
  [option: string]: unknown;
}

/** A citation the web plugin attached to a reply. */
export interface Annotation {
  type: string;
  url_citation?: {
    url: string;
    title?: string;
    content?: string;
    start_index?: number;
    end_index?: number;
  };
}

export interface CompletionRequest {
  apiKey: string;
  model: string;
  messages: ChatMessage[];
  /** "off" omits the reasoning parameter entirely. */
  effort?: "off" | "low" | "medium" | "high";
  /**
   * The reply's ceiling. Always set by the loop: without it the ceiling is
   * whatever the provider defaults to, and the reserve the context budget
   * holds back is then a number nothing enforces.
   */
  maxTokens?: number;
  tools?: readonly ToolSchema[];
  toolChoice?: ToolChoice;
  plugins?: Plugin[];
  signal?: AbortSignal;
}

export interface CompletionResult {
  text: string;
  reasoning: string;
  /** In the order the provider indexed them, never completion order. */
  toolCalls: ToolCall[];
  annotations: Annotation[];
  finishReason: string | null;
  usage: TokenUsage;
  costUsd: number;
}

/**
 * How this package reaches the model.
 *
 * Injected rather than imported: it is what lets the loop be driven by a
 * scripted fake in tests, and it keeps the provider's HTTP client on the
 * server side of the package boundary where it belongs.
 */
export type Complete = (
  request: CompletionRequest,
  onDelta: (delta: { text?: string; reasoning?: string }) => void,
) => Promise<CompletionResult>;
