import { isModelImageType, type DomainEvent, type TokenUsage } from "@ucch/protocol";
import { parseToolArguments } from "./arguments.js";
import type { ChatMessage, Complete, ToolCall } from "./completion.js";
import type { Executor } from "./executor.js";
import {
  compact,
  measure,
  pruneToolResults,
  summaryMessage,
  usableTokens,
  COMPACT_RATIO,
  PRUNE_RATIO,
} from "./context.js";
import { buildPrompt } from "./prompt.js";
import { schemasFor, toolByName, type RegistryOptions, type ToolPreset } from "./registry.js";
import { bindResearch, type ResearchBackends } from "./research.js";
import { rebuild } from "./session-log.js";
import { openrouterPluginProvider } from "./web.js";
import { executionModeOf, type AnyTool, type ToolContext } from "./tool.js";
import type { UploadStaging } from "./uploads.js";
import { clamp, describe } from "./tools/format.js";

/** A tool that names no timeout of its own still gets one. */
const DEFAULT_TOOL_TIMEOUT_MS = 180_000;

/**
 * The reply's ceiling, and the room held back for it.
 *
 * The reserve is larger than the ceiling on purpose. It covers the reply, and
 * it covers the token count being an estimate at four characters each -- a
 * heuristic that is close on prose and less close on minified JSON, and the
 * direction it is wrong in has to be the survivable one.
 */
const MAX_OUTPUT_TOKENS = 16_000;

/**
 * Below this, a missed cache says nothing.
 *
 * Every provider has a minimum prefix it will cache at all -- around a
 * thousand tokens -- and a short conversation legitimately falls under it.
 * Warning about those would train whoever reads the log to ignore the
 * warning, which is worse than not having one.
 */
const CACHE_CANARY_MIN_TOKENS = 4_096;
const CONTEXT_RESERVE_TOKENS = 24_000;

export interface TurnInput {
  projectId: string;
  threadId: string;
  turnId: string;
  apiKey: string;
  model: string;
  effort?: "off" | "low" | "medium" | "high";
  /** The thread's durable log, oldest first. The only source of history. */
  history: readonly DomainEvent[];
  /** From `projects.stack`; shapes the prompt only. */
  stack: string | null;
  preset: ToolPreset;
  registry: RegistryOptions;
  /**
   * The model's window, from the catalogue. Null or absent means the
   * catalogue does not publish one, and context management then does
   * nothing rather than guessing a ceiling.
   */
  contextLength?: number | null;
  /**
   * Whether this model accepts pictures.
   *
   * False leaves every attached image described in the message text but not
   * shown: the manifest and `attach_upload` still work, so the turn happens
   * rather than being refused by a provider that was sent a part it does not
   * take. Defaults to false, because assuming vision and being wrong costs
   * the whole turn.
   */
  supportsImages?: boolean;
  /**
   * The model that summarises -- for compaction, and for `web_search`.
   * Neither is the work, and neither should be billed as if it were.
   * Falls back to the turn's own model when unset.
   */
  searchModel?: string;
  maxIterations: number;
  executor: Executor;
  complete: Complete;
  signal: AbortSignal;
  /** Staged attachments, for `attach_upload`. Omitted where there are none. */
  uploads?: UploadStaging;
  /**
   * `research` runs the research pipeline: its prompt addendum, and the
   * `research` preset's tools with `research` below behind them. The
   * caller sets both, since the preset is a separate field; a research mode
   * with the standard preset would be a prompt describing tools it lacks.
   */
  mode?: "research";
  /** The pipeline's backends. Required for a research turn, unused otherwise. */
  research?: ResearchBackends;
  /**
   * False leaves the turn open: no `agent.turn_completed` is appended, and
   * the outcome is returned for the caller to fold into whatever closes the
   * turn. For a phase inside a larger turn -- the research a CLI provider's
   * turn runs first -- where a completion here would move the thread to
   * idle with the real work still to come. Defaults to true.
   */
  conclude?: boolean;
  /** Durable events, appended in one transaction per call. */
  append(events: readonly DomainEvent[]): Promise<void>;
  /** Transient deltas. Not awaited, and never stored. */
  publish(event: DomainEvent): void;
  /**
   * Something the operator should see that is not the person's problem.
   * Optional: a harness with nowhere to log simply does not pass one.
   */
  onDiagnostic?(message: string): void;
}

export interface TurnOutcome {
  stopReason: string | null;
  usage: TokenUsage;
  costUsd: number;
  iterations: number;
  /** The model's final prose -- the reply that made no tool calls. Empty if it never got there. */
  text: string;
}

/**
 * One turn: model, tools, model, until it stops asking.
 *
 * Four things inside are easy to get wrong and are load-bearing:
 *
 * `agent.message` is durable **before** any tool runs. A crash between the
 * model call and the tool results would otherwise leave a conversation that
 * cannot be replayed at all; writing it first means any prefix of the log
 * rebuilds. N iterations produce N `agent.message` events sharing one turn.
 *
 * Every `agent.tool_use` for one iteration goes in a single append, so their
 * order in the log is the order the model asked for and not a race between
 * writers.
 *
 * All results come back before the next model call, in one batch.
 * `plan.md` §6.4: splitting tool results across messages trains the model out
 * of parallel calls.
 *
 * And results are ordered by the assistant's `tool_calls` array, never by
 * which finished first. Parallel tools land nondeterministically; the
 * conversation must not.
 */
export async function runTurn(input: TurnInput): Promise<TurnOutcome> {
  const { threadId, turnId, signal } = input;

  const prompt = await buildPrompt({
    executor: input.executor,
    stack: input.stack,
    ...(input.mode ? { mode: input.mode } : {}),
    signal,
  });

  // Recorded before it is used, so the log says exactly what the model was
  // shown rather than approximately.
  await input.append(
    prompt.parts.map((part) => ({
      type: "context.injected" as const,
      threadId,
      source: part.source,
      content: part.content,
    })),
  );

  const images = await loadImages(input);

  const messages: ChatMessage[] = [
    // Spans, not one joined string: the file tree moves whenever anybody adds
    // a file, and joined it dragged the harness rules and `AGENTS.md` down
    // with it on every turn that it changed.
    { role: "system", content: prompt.segments },
    ...rebuild(input.history, images),
  ];

  // The frozen per-preset array, passed straight through: the same object
  // every request is what keeps the cached prefix byte-identical.
  const tools = schemasFor(input.preset, input.registry);

  const usage: TokenUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
  };
  let costUsd = 0;
  let stopReason: string | null = "max_iterations";
  let iterations = 0;
  let text = "";

  /** Failed calls this turn, by tool and verbatim arguments. See below. */
  const repeated = new Map<string, number>();

  for (let i = 0; i < input.maxIterations; i++) {
    if (signal.aborted) {
      stopReason = "cancelled";
      break;
    }
    iterations++;

    // Before the request, not after it: the tool results from the previous
    // iteration are already in `messages`, and they are what pushes a long
    // turn over the edge.
    const fitted = await fit(messages, input);
    if (fitted.usage) {
      usage.inputTokens += fitted.usage.inputTokens;
      usage.outputTokens += fitted.usage.outputTokens;
      usage.cacheReadInputTokens += fitted.usage.cacheReadInputTokens;
      usage.cacheCreationInputTokens += fitted.usage.cacheCreationInputTokens;
      costUsd += fitted.costUsd;
    }

    // Thrown rather than stopped, and only after the summary it bought has
    // been billed: the reactor turns this into `agent.turn_failed`, which is
    // what it is -- the turn did not happen.
    if (fitted.error) throw new Error(fitted.error);

    let completion;
    try {
      completion = await input.complete(
        {
          apiKey: input.apiKey,
          model: input.model,
          messages,
          maxTokens: MAX_OUTPUT_TOKENS,
          ...(input.effort ? { effort: input.effort } : {}),
          tools,
          signal,
        },
        (delta) => {
          // Fire and forget: a delta is transient, so it is published to
          // subscribers without a database round trip. Awaiting each one
          // would serialise the stream behind the event loop's I/O.
          if (delta.text) {
            input.publish({ type: "agent.text_delta", threadId, turnId, text: delta.text });
          }
          if (delta.reasoning) {
            input.publish({
              type: "agent.thinking_delta",
              threadId,
              turnId,
              text: delta.reasoning,
            });
          }
        },
      );
    } catch (error) {
      // A cancelled turn aborts the stream, and that is not a failure.
      if (signal.aborted) {
        stopReason = "cancelled";
        break;
      }
      throw error;
    }

    // The cache canary (`plan.md` §10), and the reason it is here rather than
    // in a test: a prompt cache fails silently. Every reply still looks
    // right, the turn just costs several times what it should, and the only
    // symptom is a number nobody is reading. From the second iteration on,
    // the whole conversation up to the previous request is a byte-identical
    // prefix -- if none of it came back cached, something in the prefix moved
    // and the layout is not doing what it was built to do.
    if (iterations > 1 && completion.usage.cacheReadInputTokens === 0) {
      if (completion.usage.inputTokens > CACHE_CANARY_MIN_TOKENS) {
        input.onDiagnostic?.(
          `prompt cache missed on iteration ${iterations} of turn ${turnId} ` +
            `(${completion.usage.inputTokens} input tokens, none cached) -- ` +
            `something in the prefix is changing between requests: check the system ` +
            `prompt for interpolated values, the tool schemas for reordering, and ` +
            `whether the conversation was pruned or compacted this turn`,
        );
      }
    }

    usage.inputTokens += completion.usage.inputTokens;
    usage.outputTokens += completion.usage.outputTokens;
    usage.cacheReadInputTokens += completion.usage.cacheReadInputTokens;
    usage.cacheCreationInputTokens += completion.usage.cacheCreationInputTokens;
    costUsd += completion.costUsd;

    const calls = completion.toolCalls;
    await input.append([
      {
        type: "agent.message",
        threadId,
        turnId,
        content: [
          ...(completion.text ? [{ type: "text", text: completion.text }] : []),
          ...calls.map((call) => ({
            type: "tool_use",
            id: call.id,
            name: call.function.name,
            input: parseInput(call.function.arguments),
            // Stored verbatim alongside the parsed input: `input` is for the
            // event payload and the UI, `arguments` is what goes back on the
            // wire when this turn is replayed.
            arguments: call.function.arguments,
          })),
        ],
      },
    ]);

    messages.push({
      role: "assistant",
      content: completion.text || null,
      ...(calls.length > 0 ? { tool_calls: calls } : {}),
    });

    // Branching on the calls rather than on `finish_reason`: some providers
    // report "stop" with tool calls present, and believing them ends the
    // turn with the work undone.
    if (calls.length === 0) {
      stopReason = completion.finishReason;
      text = completion.text;
      break;
    }

    await input.append(
      calls.map((call) => ({
        type: "agent.tool_use" as const,
        threadId,
        turnId,
        toolUseId: call.id,
        name: call.function.name,
        input: parseInput(call.function.arguments),
      })),
    );

    // `runTool` never rejects, so this cannot reject and no sibling result
    // can be lost to another's failure.
    const results = await dispatch(calls, input);

    // A model that cannot see why a call failed will often send it again
    // unchanged, and again, until the iteration cap ends the turn with
    // nothing done and the whole thing billed. Saying so plainly is what
    // breaks the cycle -- the failure text on its own evidently does not.
    for (const [index, result] of results.entries()) {
      if (!result.isError) continue;
      const call = calls[index]!;
      const key = `${call.function.name}:${call.function.arguments}`;
      const attempts = (repeated.get(key) ?? 0) + 1;
      repeated.set(key, attempts);
      if (attempts > 1) {
        result.content = clamp(
          `${result.content}\n\nThis is attempt ${attempts} at ${call.function.name} with ` +
            `these exact arguments, and it has failed every time. Repeating it will fail ` +
            `again: change the arguments, or reach the goal another way.`,
        );
      }
    }

    for (const result of results) {
      await input.append([
        {
          type: "agent.tool_result",
          threadId,
          turnId,
          toolUseId: result.toolUseId,
          content: result.content,
          isError: result.isError,
          durationMs: result.durationMs,
        },
      ]);
    }

    for (const result of results) {
      messages.push({ role: "tool", tool_call_id: result.toolUseId, content: result.content });
    }

    if (signal.aborted) {
      stopReason = "cancelled";
      break;
    }
  }

  if (input.conclude ?? true) {
    await input.append([
      {
        type: "agent.turn_completed",
        threadId,
        turnId,
        // "cancelled" and "max_iterations" both come through here rather than
        // through `turn_failed`, so the thread projects back to idle instead
        // of error. Neither is a failure.
        stopReason,
        usage,
        costUsd,
      },
    ]);
  }

  return { stopReason, usage, costUsd, iterations, text };
}

interface ToolOutcome {
  toolUseId: string;
  content: string;
  isError: boolean;
  durationMs: number;
}

/**
 * Brings a conversation back inside the model's window, in place.
 *
 * Two escalations, cheapest first, and each one gated on whether it actually
 * reclaims anything -- both rewrite the middle of the prefix, so both cost
 * the prompt cache from the point they touch, and paying that to save a few
 * hundred tokens would be a straight loss.
 *
 * Mutates `messages` rather than returning a new array because the caller's
 * array *is* the conversation: the loop pushes onto it for the rest of the
 * turn, and handing back a copy would silently fork the two.
 *
 * Returns the compaction's own usage when it ran, so the turn is billed for
 * the summary it bought rather than quietly absorbing it.
 */
async function fit(
  messages: ChatMessage[],
  input: TurnInput,
): Promise<{ usage?: TokenUsage; costUsd: number; error?: string }> {
  const limit = usableTokens({
    contextLength: input.contextLength ?? null,
    reserveTokens: CONTEXT_RESERVE_TOKENS,
  });
  if (limit === null) return { costUsd: 0 };

  let tokens = measure(messages);
  if (tokens <= limit * PRUNE_RATIO) return { costUsd: 0 };

  const pruned = pruneToolResults(messages, Math.floor(limit * PRUNE_RATIO));
  if (pruned.reclaimed > 0) {
    messages.splice(0, messages.length, ...pruned.messages);
    tokens -= pruned.reclaimed;
  }

  if (tokens <= limit * COMPACT_RATIO) return { costUsd: 0 };

  const outcome = await compact({
    messages,
    apiKey: input.apiKey,
    model: input.searchModel ?? input.model,
    signal: input.signal,
    complete: input.complete,
  });

  // Nothing to fold: the conversation is one enormous message rather than
  // many, so there is no older half to summarise.
  if (!outcome) return tokens > limit ? { costUsd: 0, error: OVER_BUDGET } : { costUsd: 0 };

  // The checkpoint is durable before it is used, so a restart replays the
  // same folded conversation rather than the unfolded one.
  await input.append([
    {
      type: "context.injected",
      threadId: input.threadId,
      source: "compaction",
      content: outcome.summary,
      tokens: measure([summaryMessage(outcome.summary)]),
    },
  ]);

  const head = messages[0]?.role === "system" ? [messages[0]!] : [];
  messages.splice(
    0,
    messages.length,
    ...head,
    summaryMessage(outcome.summary),
    ...messages.slice(outcome.replacedThrough),
  );

  // Both escalations have run and it still does not fit, which means the
  // recent tail alone is over the window: a small model and a few large
  // files. The results being protected are a preference, not a floor, so
  // give that up before giving up the turn -- a cut-down file the model can
  // re-read beats an error it cannot do anything with.
  if (measure(messages) > limit) {
    const last = pruneToolResults(messages, limit, 1);
    if (last.reclaimed > 0) messages.splice(0, messages.length, ...last.messages);
  }

  if (measure(messages) > limit) {
    return { usage: outcome.usage, costUsd: outcome.costUsd, error: OVER_BUDGET };
  }

  return { usage: outcome.usage, costUsd: outcome.costUsd };
}

/** What a turn says when neither escalation could make room. */
const OVER_BUDGET =
  "This conversation no longer fits in the model's context window, even after summarising it. " +
  "Start a new thread, or switch to a model with a larger window.";

/**
 * The pictures this thread's messages showed, as `data:` URLs.
 *
 * Read from staging on every turn rather than held anywhere: the log records
 * which upload a message referred to, and the bytes are looked up when they
 * are needed. Each one is retained as it is read, which is what stops the
 * staging sweeper from collecting an image the conversation still depends on
 * -- the read and the promise to keep it are the same act.
 *
 * Everything here fails soft. No staging, a model that cannot see, an id
 * that has been swept: each yields a conversation that describes the
 * attachment instead of showing it, which is a worse answer than the picture
 * and a much better one than a failed turn.
 */
async function loadImages(input: TurnInput): Promise<ReadonlyMap<string, string>> {
  const found = new Map<string, string>();
  const staging = input.uploads;
  if (!staging || !input.supportsImages) return found;

  const wanted = new Map<string, string>();
  for (const event of input.history) {
    if (event.type !== "user.message") continue;
    for (const image of event.images ?? []) {
      if (isModelImageType(image.type)) wanted.set(image.uploadId, image.type);
    }
  }
  if (wanted.size === 0) return found;

  await Promise.all(
    [...wanted.keys()].map(async (uploadId) => {
      try {
        await staging.retain(input.projectId, uploadId);
        const file = await staging.readBytes(input.projectId, uploadId);
        if (!file) return;
        // The stored type wins over the one the message recorded: the bytes
        // are what the provider decodes, and the browser's guess is not.
        if (!isModelImageType(file.contentType)) return;
        found.set(
          uploadId,
          `data:${file.contentType};base64,${file.bytes.toString("base64")}`,
        );
      } catch {
        // Unreadable is the same as absent here, and `rebuild` says so in
        // the message rather than pretending the picture was shown.
      }
    }),
  );

  return found;
}

/** At most this many reads in flight at once. */
const MAX_PARALLEL_CALLS = 10;

/**
 * Runs one iteration's tool calls, overlapping only what may overlap.
 *
 * Reads go together; a write or a shell command waits for the pool to drain,
 * runs alone, and finishes before anything after it starts. That is the whole
 * of the ordering guarantee, and it is the one the model's own `tool_calls`
 * array already implied: it asks for a read and an edit in that order because
 * it means them in that order.
 *
 * `results` is filled by index, never by arrival, so the array this returns is
 * in the assistant's order whatever happens underneath. The loop then appends
 * and replays it in that order -- splitting or reordering tool results trains
 * the model out of asking for parallel calls at all (`plan.md` §6.4).
 *
 * The cap drains the whole pool rather than freeing one slot at a time. With
 * a ceiling of ten and a model that asks for a handful, the branch is close to
 * unreachable; a fair queue would be more machinery than the case deserves.
 */
async function dispatch(
  calls: readonly ToolCall[],
  input: TurnInput,
): Promise<ToolOutcome[]> {
  const results: ToolOutcome[] = new Array(calls.length);
  let inFlight: Promise<void>[] = [];

  const drain = async (): Promise<void> => {
    if (inFlight.length === 0) return;
    const pending = inFlight;
    inFlight = [];
    await Promise.all(pending);
  };

  for (const [index, call] of calls.entries()) {
    const tool: AnyTool | undefined = toolByName(input.preset, call.function.name, input.registry);
    if (executionModeOf(tool) === "exclusive") {
      await drain();
      results[index] = await runTool(call, input);
      continue;
    }

    if (inFlight.length >= MAX_PARALLEL_CALLS) await drain();
    inFlight.push(
      runTool(call, input).then((result) => {
        results[index] = result;
      }),
    );
  }

  await drain();
  return results;
}

/**
 * Runs one tool call, and always produces a result.
 *
 * Total by construction: unknown tool, malformed JSON, a schema violation, a
 * throw, a timeout and an abort all come back as `isError: true` with a
 * message the model can act on. `plan.md` §6.4 is explicit that a failed tool
 * returns `is_error` rather than nothing, and there is a wire-level reason
 * too -- an assistant message carrying a `tool_call` with no matching reply
 * is rejected outright.
 */
export async function runTool(call: ToolCall, input: TurnInput): Promise<ToolOutcome> {
  const started = Date.now();
  const name = call.function.name;

  const finish = (content: string, isError: boolean): ToolOutcome => ({
    toolUseId: call.id,
    // Never empty and never unbounded: several providers reject an empty
    // tool result, and one `bash` producing 40 MB would end the turn.
    content: clamp(content.trim() === "" ? "(the tool returned no output)" : content),
    isError,
    durationMs: Date.now() - started,
  });

  // Checked before dispatch, which is what satisfies §6.4's "cancellation
  // must interrupt between tool calls". A sibling already dispatched still
  // records its own result rather than being dropped.
  if (input.signal.aborted) return finish(`${name} was not run: the turn was cancelled.`, true);

  const tool = toolByName(input.preset, name, input.registry);
  if (!tool) {
    return finish(
      `There is no tool called ${JSON.stringify(name)}. Use one of the tools you were given.`,
      true,
    );
  }

  let raw: unknown;
  try {
    raw = JSON.parse(call.function.arguments);
  } catch (error) {
    return finish(
      `The arguments for ${name} were not valid JSON (${describe(error)}). Send the ` +
        `arguments again as a JSON object.`,
      true,
    );
  }

  // Repaired rather than merely validated: a smaller model quoting a number
  // or omitting a nullable property is the single most common way a turn
  // stalls, and the harness knows what type it asked for. See arguments.ts.
  const parsed = parseToolArguments(name, tool.inputSchema, raw);
  if (!parsed.ok) return finish(parsed.message, true);

  const timeoutMs = tool.timeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;
  let timer: NodeJS.Timeout | undefined;

  const ctx: ToolContext = {
    projectId: input.projectId,
    threadId: input.threadId,
    turnId: input.turnId,
    toolUseId: call.id,
    executor: input.executor,
    // The turn's cancellation and this tool's own deadline, as one signal, so
    // a tool that respects it stops on either.
    signal: AbortSignal.any([input.signal, AbortSignal.timeout(timeoutMs)]),
    emit: async (event) => input.append([event]),
    apiKey: input.apiKey,
    model: input.model,
    depth: 0,
    // Built per call rather than per turn: it is three closed-over fields,
    // and threading a longer-lived object through would buy nothing.
    web: openrouterPluginProvider({
      apiKey: input.apiKey,
      // A search is a summariser reading result pages. Billing that at the
      // coding model's rate made every search cost about as much as a turn.
      model: input.searchModel ?? input.model,
      complete: input.complete,
    }),
    complete: input.complete,
    ...(input.uploads ? { uploads: input.uploads } : {}),
    // Bound here for the same reason `web` is: the key is the turn's, and
    // the tools should not have to know which turn they are in.
    ...(input.mode === "research" && input.research
      ? {
          research: bindResearch(input.research, {
            apiKey: input.apiKey,
            complete: input.complete,
          }),
        }
      : {}),
  };

  try {
    // The race is the backstop for a tool that ignores its signal: without
    // it, one hung tool holds the whole turn open indefinitely.
    const deadline = new Promise<{ content: string; isError: true }>((resolve) => {
      timer = setTimeout(
        () => resolve({ content: `${name} did not finish within ${timeoutMs}ms.`, isError: true }),
        timeoutMs,
      );
    });

    const result = await Promise.race([tool.run(parsed.value, ctx), deadline]);
    return finish(result.content, result.isError ?? false);
  } catch (error) {
    if (input.signal.aborted) return finish(`${name} was cancelled.`, true);
    return finish(`${name} failed: ${describe(error)}`, true);
  } finally {
    clearTimeout(timer);
  }
}

/** For the event payload and the UI. The wire always gets the raw string. */
function parseInput(args: string): unknown {
  try {
    return JSON.parse(args);
  } catch {
    return null;
  }
}
