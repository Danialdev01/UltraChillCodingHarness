import type {
  Annotation,
  ChatMessage,
  CompletionRequest,
  CompletionResult,
  ToolCall,
} from "@ucch/agent";
import type { TokenUsage } from "@ucch/protocol";

/**
 * The OpenRouter half of the agent loop.
 *
 * Kept to the two calls the harness actually makes -- list the catalogue, and
 * stream one completion -- rather than wrapping the whole API. Nothing here
 * touches the database or the event log; the reactor decides what to record.
 */

const BASE = "https://openrouter.ai/api/v1";

export interface ModelChoice {
  id: string;
  name: string;
  /** Provider segment of the id, for grouping the picker. */
  provider: string;
  contextLength: number | null;
  /** True when the model bills for reasoning tokens, so effort is meaningful. */
  reasoning: boolean;
  /**
   * True when the model accepts pictures as input.
   *
   * Read from the catalogue rather than guessed from the id: "vision" is not
   * in the name of half the models that have it, and getting it wrong in the
   * optimistic direction costs the whole turn.
   */
  images: boolean;
}

/**
 * What an OpenRouter key has left to spend.
 *
 * Two figures because OpenRouter keeps two: a key may carry its own spending
 * limit, set when it was created, and the account behind it holds a credit
 * balance. Either can be the one that runs out first, so the card shows the
 * tighter of the two and names which it is. `limitUsd` is null on a key
 * with no limit of its own; `credits` is null when the account endpoint is
 * not available to this key.
 */
export interface KeyQuota {
  /** The name given to the key on OpenRouter, for the reader to recognise it. */
  label: string | null;
  /** Spent through this key, in USD, over its lifetime. */
  usageUsd: number;
  /** The key's own spending cap, or null for an unlimited key. */
  limitUsd: number | null;
  /** What the cap leaves, or null where there is no cap. */
  limitRemainingUsd: number | null;
  freeTier: boolean;
  /** The account's balance: credits bought, and credits spent across every key. */
  credits: { totalUsd: number; usedUsd: number } | null;
}

/**
 * The key's standing, from OpenRouter's own two endpoints.
 *
 * The key endpoint is the one that must answer -- without it there is no
 * quota to show. The credits endpoint is allowed to fail: it is account
 * level, some keys cannot read it, and a key limit on its own is still an
 * answer.
 */
export async function keyQuota(apiKey: string, signal?: AbortSignal): Promise<KeyQuota> {
  const headers = { authorization: `Bearer ${apiKey}` };

  const keyResponse = await fetch(`${BASE}/auth/key`, { headers, signal });
  if (!keyResponse.ok) throw new Error(`key lookup failed: ${keyResponse.status}`);
  const key = ((await keyResponse.json()) as { data?: KeyBody }).data ?? {};

  let credits: KeyQuota["credits"] = null;
  try {
    const creditsResponse = await fetch(`${BASE}/credits`, { headers, signal });
    if (creditsResponse.ok) {
      const body = ((await creditsResponse.json()) as { data?: CreditsBody }).data;
      if (body && typeof body.total_credits === "number" && typeof body.total_usage === "number") {
        credits = { totalUsd: body.total_credits, usedUsd: body.total_usage };
      }
    }
  } catch {
    // The account balance is a nicety; the key's own figures are the answer.
  }

  const limit = typeof key.limit === "number" ? key.limit : null;
  const usage = typeof key.usage === "number" ? key.usage : 0;
  return {
    label: typeof key.label === "string" && key.label ? key.label : null,
    usageUsd: usage,
    limitUsd: limit,
    limitRemainingUsd:
      typeof key.limit_remaining === "number"
        ? key.limit_remaining
        : limit === null
          ? null
          : Math.max(0, limit - usage),
    freeTier: key.is_free_tier === true,
    credits,
  };
}

interface KeyBody {
  label?: string;
  usage?: number;
  limit?: number | null;
  limit_remaining?: number | null;
  is_free_tier?: boolean;
}

interface CreditsBody {
  total_credits?: number;
  total_usage?: number;
}

/**
 * The catalogue, for the model picker.
 *
 * Public on OpenRouter's side, so this works before a key is configured and
 * the settings page can offer a real list rather than a guess.
 */
export async function listModels(signal?: AbortSignal): Promise<ModelChoice[]> {
  const response = await fetch(`${BASE}/models`, { signal });
  if (!response.ok) throw new Error(`model list failed: ${response.status}`);

  const body = (await response.json()) as {
    data?: Array<{
      id?: string;
      name?: string;
      context_length?: number | null;
      supported_parameters?: string[];
      architecture?: { input_modalities?: string[] };
    }>;
  };

  return (body.data ?? [])
    .filter((m): m is { id: string } & typeof m => typeof m.id === "string")
    .map((m) => ({
      id: m.id,
      name: m.name ?? m.id,
      provider: m.id.split("/")[0] ?? "other",
      contextLength: m.context_length ?? null,
      reasoning: (m.supported_parameters ?? []).includes("reasoning"),
      images: (m.architecture?.input_modalities ?? []).includes("image"),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * The catalogue, cached.
 *
 * It changes daily at most and two callers want it: the model picker, which
 * is opened often, and the agent, which needs each model's window before
 * every turn to know when to compact. A failed refresh serves the last good
 * list rather than emptying the picker or disabling context management.
 */
let cache: { at: number; models: ModelChoice[] } | null = null;

const CATALOGUE_TTL_MS = 30 * 60_000;

export async function catalogue(): Promise<ModelChoice[]> {
  if (cache && Date.now() - cache.at < CATALOGUE_TTL_MS) return cache.models;
  const models = await listModels();
  cache = { at: Date.now(), models };
  return models;
}

/**
 * Whether this model can be shown a picture.
 *
 * False whenever the catalogue cannot say -- an unknown model, or a fetch
 * that failed. The conversation then describes its attachments instead of
 * showing them, which is the direction that still produces a turn.
 */
export async function supportsImages(model: string): Promise<boolean> {
  try {
    const models = await catalogue();
    return models.find((entry) => entry.id === model)?.images ?? false;
  } catch {
    return cachedCatalogue()?.find((entry) => entry.id === model)?.images ?? false;
  }
}

/** The last good catalogue, without fetching. Null before the first success. */
export function cachedCatalogue(): ModelChoice[] | null {
  return cache?.models ?? null;
}

/**
 * How large a window this model has, or null when nothing can say.
 *
 * Null is a real answer and is treated as one: context management does
 * nothing without a ceiling, because a guessed ceiling either compacts a
 * thread that was fine or fails to compact one that was not. A catalogue
 * that cannot be reached is the same case -- unknown, not unlimited.
 */
export async function contextLengthFor(model: string): Promise<number | null> {
  try {
    const models = await catalogue();
    return models.find((entry) => entry.id === model)?.contextLength ?? null;
  } catch {
    return cachedCatalogue()?.find((entry) => entry.id === model)?.contextLength ?? null;
  }
}

/**
 * The call vocabulary is defined once, in `@ucch/agent`, and re-exported here
 * so every existing importer keeps working. Types only -- this module owns
 * the HTTP, the agent package owns the shapes both sides agree on.
 */
export type {
  Annotation,
  ChatMessage,
  Complete,
  CompletionRequest,
  CompletionResult,
  Plugin,
  ToolCall,
  ToolChoice,
  ToolSchema,
} from "@ucch/agent";

/**
 * Model families that cache only where they are told to.
 *
 * OpenAI-family models cache a long prefix on their own and report it in
 * `prompt_tokens_details.cached_tokens`. Anthropic and Google cache nothing
 * at all unless the request says where the reusable prefix ends -- and until
 * this landed the harness said nothing, anywhere. §6.4's whole stable →
 * volatile prompt layout was being assembled for a cache that was never
 * being asked for, and §10's canary read zero on every request no matter how
 * byte-identical the prefix was. That is the failure mode the canary exists
 * to catch, and it was reading the harness's own omission.
 *
 * Matched by prefix on the OpenRouter id, which is `provider/model`.
 */
const EXPLICIT_CACHE_PROVIDERS = ["anthropic/", "google/"];

function needsExplicitCacheBreakpoints(model: string): boolean {
  return EXPLICIT_CACHE_PROVIDERS.some((prefix) => model.startsWith(prefix));
}

/**
 * How many `cache_control` marks a request may carry.
 *
 * Anthropic's limit, and Google's is not smaller. Spending them is the whole
 * job here, so the budget is named rather than implied: two go to the system
 * prompt, which arrives already marked by `buildPrompt`, and two roll along
 * the end of the conversation.
 */
const MAX_BREAKPOINTS = 4;

/**
 * Marks where the reusable prefixes end, for the providers that require it.
 *
 * The system spans come in pre-marked -- `packages/agent`'s prompt assembly
 * decides where the harness rules stop and the project's own context stops,
 * because that is where it knows what moves and what does not. This function
 * translates those marks and then places the ones only the transport can:
 *
 * **two rolling marks at the end of the conversation.** This is the part that
 * was wrong. The mark used to sit on the last *user* message, which never
 * moves inside a turn -- so iteration two re-bought every tool result
 * iteration one had just paid to write, iteration three bought both, and a
 * long turn spent most of its input budget re-reading its own output. Putting
 * a mark on the final message of every request makes each iteration's prefix
 * readable by the next one, and the second-to-last mark is what the *next*
 * turn reads back after this one's tail has been extended past it.
 *
 * Anthropic returns the longest cached prefix that matches, so a mark that
 * turns out to be redundant costs nothing but a write.
 *
 * Everything else passes through untouched: a message is rewritten into the
 * content-parts form only where a mark actually goes, so a provider that
 * never sees `cache_control` never sees a changed request either. A prefix
 * under the provider's minimum is simply not cached, which is why the tiny
 * `web_search` sub-call needs no special case.
 */
function withCacheBreakpoints(messages: ChatMessage[], model: string): unknown[] {
  if (!needsExplicitCacheBreakpoints(model)) return messages.map(stripMarks);

  // The last two messages that can carry a mark. An assistant message that is
  // nothing but tool calls has `content: null`, and an empty text part is
  // rejected outright, so those are skipped rather than marked in place.
  const markable = messages
    .map((message, index) => (canMark(message) ? index : -1))
    .filter((index) => index >= 0);
  const rolling = new Set(markable.slice(-(MAX_BREAKPOINTS - SYSTEM_BREAKPOINTS)));

  return messages.map((message, index) => {
    if (message.role === "system") return markSystem(message);
    if (!rolling.has(index)) return message;
    return {
      ...message,
      content: [
        { type: "text", text: message.content as string, cache_control: { type: "ephemeral" } },
      ],
    };
  });
}

/** What `buildPrompt` spends before the conversation gets its turn. */
const SYSTEM_BREAKPOINTS = 2;

/**
 * Whether a mark can go on this message.
 *
 * `user` and `assistant` only, and this is a deliberate limit rather than an
 * oversight. OpenRouter documents `cache_control` on system and user content
 * parts; it says nothing about `tool` messages, and a tool result is the one
 * shape where rewriting a string into a content-parts array could plausibly
 * be dropped in translation or refused outright. Breaking every tool result
 * to chase a cache read is not a trade worth making on an undocumented
 * behaviour.
 *
 * What that costs is the most recent iteration's tool results, which the next
 * request pays for once. What it keeps is everything before them -- and it is
 * the *accumulation* that was expensive, not any single iteration. Worth
 * re-testing against a real key: if `tool` marking turns out to be honoured,
 * this predicate is the only thing standing between here and the last of it.
 */
function canMark(message: ChatMessage): boolean {
  if (message.role !== "user" && message.role !== "assistant") return false;
  return typeof message.content === "string" && message.content !== "";
}

/**
 * Turns the harness-side `cacheable` marks into the provider's spelling.
 *
 * An empty span is never emitted and never marked: providers reject an empty
 * text part outright, and a mark on nothing would spend one of four
 * breakpoints on a prefix of zero bytes. A system message that is empty all
 * the way through is passed along as the string it was.
 */
function markSystem(message: ChatMessage & { role: "system" }): unknown {
  if (typeof message.content === "string") {
    if (message.content === "") return message;
    return {
      ...message,
      content: [{ type: "text", text: message.content, cache_control: { type: "ephemeral" } }],
    };
  }

  const parts = message.content
    .filter((part) => part.text !== "")
    .map((part) => ({
      type: "text",
      text: part.text,
      ...(part.cacheable ? { cache_control: { type: "ephemeral" } } : {}),
    }));

  if (parts.length === 0) return { ...message, content: "" };
  return { ...message, content: parts };
}

/**
 * Drops the harness-side marks for a provider that does not want them.
 *
 * `cacheable` is ours, not the wire's. OpenAI-family models cache a long
 * prefix on their own and report it in `prompt_tokens_details.cached_tokens`;
 * sending them a field they do not know is at best ignored and at worst a
 * 400, and either way the spans still have to be rejoined into the string
 * they were before `buildPrompt` split them.
 */
function stripMarks(message: ChatMessage): unknown {
  if (message.role !== "system" || typeof message.content === "string") return message;
  return { ...message, content: message.content.map((part) => part.text).join("\n\n") };
}

/**
 * Streams one completion, handing each fragment to `onDelta` as it arrives
 * and returning the assembled message.
 *
 * The caller gets both: the deltas are what make the UI feel live, and the
 * assembled message is what gets written to the log -- deltas are transient
 * and a resumed thread has to be rebuilt from something durable.
 */
export async function streamCompletion(
  request: CompletionRequest,
  onDelta: (delta: { text?: string; reasoning?: string }) => void,
): Promise<CompletionResult> {
  const tools = request.tools ?? [];
  const plugins = request.plugins ?? [];

  const response = await fetch(`${BASE}/chat/completions`, {
    method: "POST",
    signal: request.signal,
    headers: {
      authorization: `Bearer ${request.apiKey}`,
      "content-type": "application/json",
      // OpenRouter attributes usage to these; they are optional but it asks
      // for them and they cost nothing to send.
      "x-title": "UCCH",
    },
    body: JSON.stringify({
      model: request.model,
      messages: withCacheBreakpoints(request.messages, request.model),
      stream: true,
      // Without a ceiling the reply is bounded by whatever the provider
      // defaults to, and the room the context budget holds back for it is a
      // number nothing enforces.
      ...(request.maxTokens ? { max_tokens: request.maxTokens } : {}),
      // Without this the stream carries no cache or cost figures, and the
      // cache canary in the harness would read zero for ever and call it a
      // tuning problem rather than the missing flag it was.
      usage: { include: true },
      ...(request.effort && request.effort !== "off"
        ? { reasoning: { effort: request.effort } }
        : {}),
      // An empty array is not the same as an absent field: several providers
      // reject `tools: []`, and one that accepts it may still switch to a
      // tool-calling prompt template and change the reply. `tool_choice`
      // without tools is meaningless, so it is nested inside.
      ...(tools.length > 0
        ? {
            tools,
            ...(request.toolChoice ? { tool_choice: request.toolChoice } : {}),
          }
        : {}),
      ...(plugins.length > 0 ? { plugins } : {}),
    }),
  });

  if (!response.ok || !response.body) {
    // The body carries OpenRouter's own explanation -- a bad key, an unknown
    // model, no credit -- which is far more useful than the status alone.
    throw new Error(`openrouter: ${response.status} ${(await response.text()).slice(0, 400)}`);
  }

  const state = new StreamState(onDelta);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // A read can split a frame in half, so only whole frames are consumed
      // and the remainder stays buffered. The separator is a blank line,
      // which the SSE grammar permits to be CRLF -- splitting on "\n\n"
      // alone never matched those at all.
      const frames = buffer.split(FRAME_SEPARATOR);
      buffer = frames.pop() ?? "";
      for (const frame of frames) state.frame(frame);
    }

    // Whatever is left after the last separator. A final frame with no
    // trailing blank line is legal, and it is usually the one carrying usage,
    // so dropping it lost exactly the numbers the harness cares about.
    buffer += decoder.decode();
    for (const frame of buffer.split(FRAME_SEPARATOR)) state.frame(frame);
  } finally {
    // On the error path the response is still open; nothing else will read it.
    await reader.cancel().catch(() => {});
  }

  return state.finish();
}

/** SSE separates events with a blank line, which may be LF or CRLF. */
const FRAME_SEPARATOR = /\r?\n\r?\n/;

/**
 * The accumulator for one streamed response.
 *
 * Kept as a class so the frame handler is the same code on the main loop and
 * on the final flush -- the tail used to be dropped precisely because it went
 * down a different path from every other frame.
 */
class StreamState {
  #text = "";
  #reasoning = "";
  #finishReason: string | null = null;
  #annotations: Annotation[] = [];
  #usage: TokenUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
  };
  #costUsd = 0;

  /**
   * Keyed by the provider's `index`, never by array position: fragments for
   * call 1 can arrive before call 0 exists, and appending in arrival order
   * silently interleaves the arguments of two parallel calls.
   */
  #calls = new Map<number, { id: string; name: string; arguments: string }>();

  constructor(private readonly onDelta: (d: { text?: string; reasoning?: string }) => void) {}

  frame(frame: string): void {
    for (const line of frame.split(/\r?\n/)) {
      // Anything else is an SSE comment (OpenRouter sends
      // ": OPENROUTER PROCESSING" as a keepalive) or a field we do not use.
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "" || data === "[DONE]") continue;

      let chunk: StreamChunk;
      try {
        chunk = JSON.parse(data) as StreamChunk;
      } catch {
        continue;
      }
      this.#chunk(chunk);
    }
  }

  #chunk(chunk: StreamChunk): void {
    // An error can arrive mid-stream with a 200 already sent. Left unread it
    // would surface as an empty reply with no explanation anywhere.
    if (chunk.error) {
      throw new Error(`openrouter: ${chunk.error.message ?? "stream error"}`);
    }

    // The usage-bearing final chunk usually has `choices: []`, so usage is
    // read whether or not there is a choice to go with it.
    if (chunk.usage) {
      this.#usage = readUsage(chunk.usage);
      this.#costUsd = chunk.usage.cost ?? 0;
    }

    const choice = chunk.choices?.[0];
    if (!choice) return;
    if (choice.finish_reason) this.#finishReason = choice.finish_reason;

    const delta = choice.delta;
    if (!delta) return;

    // `content: null` is legitimate, and content interleaves with tool calls
    // in one response rather than excluding them.
    const text = delta.content ?? "";
    const reasoning = delta.reasoning ?? "";
    if (text) this.#text += text;
    if (reasoning) this.#reasoning += reasoning;
    if (text || reasoning) {
      this.onDelta({ text: text || undefined, reasoning: reasoning || undefined });
    }

    if (delta.annotations) this.#annotations.push(...delta.annotations);

    for (const fragment of delta.tool_calls ?? []) {
      const index = fragment.index ?? 0;
      let call = this.#calls.get(index);
      if (!call) {
        call = { id: "", name: "", arguments: "" };
        this.#calls.set(index, call);
      }
      // `id` and `name` arrive once, on the fragment that opens the call;
      // later fragments carry `arguments` alone, and often send the other
      // fields back as empty strings. A field that is already set is kept.
      if (!call.id && fragment.id) call.id = fragment.id;
      if (!call.name && fragment.function?.name) call.name = fragment.function.name;
      // Never parsed here: `arguments` is not valid JSON until the last
      // fragment lands, so this only ever concatenates.
      call.arguments += fragment.function?.arguments ?? "";
    }
  }

  finish(): CompletionResult {
    const toolCalls: ToolCall[] = [...this.#calls.entries()]
      .sort(([a], [b]) => a - b)
      .map(([index, call]) => ({
        // Some providers never send one. The id only has to be unique within
        // the turn and match the `tool` message that answers it.
        id: call.id || `call_${index}`,
        type: "function" as const,
        function: {
          name: call.name,
          // A zero-argument call sends "" or nothing at all, and
          // `JSON.parse("")` throws. Normalised once, here, rather than
          // guarded at every use site.
          arguments: call.arguments === "" ? "{}" : call.arguments,
        },
      }));

    return {
      text: this.#text,
      reasoning: this.#reasoning,
      toolCalls,
      annotations: this.#annotations,
      finishReason: this.#finishReason,
      usage: this.#usage,
      costUsd: this.#costUsd,
    };
  }
}

/**
 * Maps OpenRouter's usage block onto `TokenUsage`.
 *
 * The cache figures were hardcoded to zero, which made the §10 cache canary
 * unfalsifiable -- it would have read zero whether caching worked or not.
 *
 * Where they sit varies by provider, so both the nested and the top-level
 * spellings are accepted. `inputTokens` is `prompt_tokens` exactly as
 * reported: for OpenAI-shaped providers that total already includes the
 * cached prefix, so these four numbers are what the provider said and not a
 * partition to be added up.
 */
function readUsage(usage: RawUsage): TokenUsage {
  const details = usage.prompt_tokens_details ?? {};
  return {
    inputTokens: usage.prompt_tokens ?? 0,
    outputTokens: usage.completion_tokens ?? 0,
    cacheReadInputTokens: details.cached_tokens ?? usage.cached_tokens ?? 0,
    cacheCreationInputTokens:
      details.cache_write_tokens ??
      usage.cache_write_tokens ??
      usage.cache_creation_input_tokens ??
      0,
  };
}

interface RawUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  cost?: number;
  prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
  cached_tokens?: number;
  cache_write_tokens?: number;
  cache_creation_input_tokens?: number;
}

interface StreamChunk {
  choices?: Array<{
    delta?: {
      content?: string | null;
      reasoning?: string | null;
      annotations?: Annotation[];
      tool_calls?: Array<{
        index?: number;
        id?: string;
        type?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason?: string | null;
  }>;
  usage?: RawUsage;
  error?: { message?: string; code?: number | string };
}
