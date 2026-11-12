import { parseToolArguments } from "./arguments.js";
import type { ToolCall } from "./completion.js";
import { bindDocuments } from "./documents.js";
import type { TurnInput } from "./loop.js";
import { toolByName } from "./registry.js";
import { bindResearch } from "./research.js";
import type { ToolContext } from "./tool.js";
import { clamp, describe } from "./tools/format.js";
import { openrouterPluginProvider } from "./web.js";

/**
 * One tool call, run the way a native turn runs it: looked up in the turn's
 * preset, its arguments repaired and checked, approved, given a deadline and
 * the turn's signal, and confined by the turn's executor.
 *
 * Its own module so the native loop and OMP's host-tool runner share it: a
 * host tool an OMP turn calls is the same tool, under the same rules, as the
 * one a native turn calls (documentation/architecture.md §7).
 */

/** A tool that names no timeout of its own still gets one. */
const DEFAULT_TOOL_TIMEOUT_MS = 180_000;

/** What `runTool` reads of a turn: everything a tool's context is built from. */
export type ToolRunInput = Pick<
  TurnInput,
  | "projectId"
  | "threadId"
  | "turnId"
  | "apiKey"
  | "model"
  | "searchModel"
  | "preset"
  | "registry"
  | "executor"
  | "complete"
  | "signal"
  | "uploads"
  | "mode"
  | "research"
  | "documents"
  | "approve"
  | "append"
>;

export interface ToolOutcome {
  toolUseId: string;
  content: string;
  isError: boolean;
  durationMs: number;
}

/**
 * Runs one tool call, and always produces a result.
 *
 * Total by construction: unknown tool, malformed JSON, a schema violation, a
 * throw, a timeout and an abort all come back as `isError: true` with a
 * message the model can act on. `documentation/solutions.md` §7 is explicit that a failed tool
 * returns `is_error` rather than nothing, and there is a wire-level reason
 * too -- an assistant message carrying a `tool_call` with no matching reply
 * is rejected outright.
 */
export async function runTool(call: ToolCall, input: ToolRunInput): Promise<ToolOutcome> {
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

  // Before the deadline starts: time spent waiting for a person is not the
  // tool's. The harness resolves a cancelled turn's question as a deny.
  if (input.approve && tool.permission !== "read") {
    const decision = await input.approve({
      toolUseId: call.id,
      toolName: name,
      permission: tool.permission,
      input: parsed.value,
    });
    if (decision.behavior === "deny") {
      return finish(
        decision.message?.trim() || `The user declined to run ${name}. Do not retry it; ask or take another route.`,
        true,
      );
    }
  }

  const timeoutMs = tool.timeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;
  let timer: NodeJS.Timeout | undefined;

  const ctx: ToolContext = {
    ...(input.registry?.coordination ? { coordination: input.registry.coordination } : {}),
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
    ...(input.mode === "documentation" && input.documents
      ? {
          documents: bindDocuments(input.documents, {
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
