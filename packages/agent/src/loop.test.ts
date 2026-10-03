import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DomainEvent } from "@ucch/protocol";
import type { Complete, CompletionRequest, CompletionResult, ToolCall } from "./completion.js";
import { HostExecutor } from "./executors/host.js";
import { runTool, runTurn, type TurnInput } from "./loop.js";

const PROJECT = "33333333-3333-3333-3333-333333333333";
const THREAD = "44444444-4444-4444-4444-444444444444";
const TURN = "55555555-5555-5555-5555-555555555555";

let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "ucch-loop-"));
  await writeFile(join(root, "index.ts"), "export const port = 3000;\n", "utf8");
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

const reply = (over: Partial<CompletionResult> = {}): CompletionResult => ({
  text: "",
  reasoning: "",
  toolCalls: [],
  annotations: [],
  finishReason: "stop",
  usage: {
    inputTokens: 10,
    outputTokens: 5,
    cacheReadInputTokens: 2,
    cacheCreationInputTokens: 1,
  },
  costUsd: 0.001,
  ...over,
});

const call = (id: string, name: string, args: string): ToolCall => ({
  id,
  type: "function",
  function: { name, arguments: args },
});

/** A `Complete` that plays a fixed script and records what it was asked. */
function scripted(...replies: CompletionResult[]) {
  const requests: CompletionRequest[] = [];
  let turn = 0;

  const complete: Complete = async (request) => {
    requests.push(structuredClone({ ...request, signal: undefined }) as CompletionRequest);
    const next = replies[turn++];
    if (!next) throw new Error(`the script ran out after ${turn - 1} calls`);
    return next;
  };

  return { complete, requests };
}

function harness(over: Partial<TurnInput> = {}) {
  const appended: DomainEvent[] = [];
  const published: DomainEvent[] = [];
  const batches: DomainEvent[][] = [];

  const input: TurnInput = {
    projectId: PROJECT,
    threadId: THREAD,
    turnId: TURN,
    apiKey: "key",
    model: "test/model",
    history: [],
    stack: "nextjs",
    preset: "standard",
    registry: {},
    maxIterations: 25,
    executor: new HostExecutor(root),
    complete: async () => reply(),
    signal: new AbortController().signal,
    append: async (events) => {
      batches.push([...events]);
      appended.push(...events);
    },
    publish: (event) => {
      published.push(event);
    },
    ...over,
  };

  return { input, appended, published, batches };
}

const types = (events: readonly DomainEvent[]) => events.map((event) => event.type);

describe("a two-iteration tool conversation", () => {
  it("drives through to turn_completed, with the whole sequence recorded", async () => {
    const script = scripted(
      reply({
        text: "Let me look at the file.",
        toolCalls: [call("call_0", "read_file", '{"path":"index.ts","offset":null,"limit":null}')],
        finishReason: "tool_calls",
      }),
      reply({ text: "The port is 3000.", finishReason: "stop" }),
    );
    const { input, appended } = harness({ complete: script.complete });

    const outcome = await runTurn(input);

    expect(types(appended)).toEqual([
      // Recorded before it is used, so the log says what the model was shown.
      "context.injected",
      "context.injected",
      "context.injected",
      // Durable before any tool runs: any prefix of this log rebuilds.
      "agent.message",
      "agent.tool_use",
      "agent.tool_result",
      "agent.message",
      "agent.turn_completed",
    ]);

    const toolResult = appended.find((e) => e.type === "agent.tool_result");
    expect(toolResult).toMatchObject({ toolUseId: "call_0", isError: false });
    expect(toolResult).toHaveProperty("content", expect.stringContaining("export const port"));

    // The second call carries the whole conversation so far, in order.
    expect(script.requests[1]!.messages.map((m) => m.role)).toEqual([
      "system",
      "assistant",
      "tool",
    ]);
    expect(script.requests[1]!.messages[1]).toMatchObject({
      role: "assistant",
      content: "Let me look at the file.",
      tool_calls: [{ id: "call_0", function: { name: "read_file" } }],
    });

    expect(outcome).toMatchObject({ stopReason: "stop", iterations: 2 });
    // Usage accumulates across both calls rather than reporting the last.
    expect(outcome.usage).toEqual({
      inputTokens: 20,
      outputTokens: 10,
      cacheReadInputTokens: 4,
      cacheCreationInputTokens: 2,
    });
    expect(outcome.costUsd).toBeCloseTo(0.002);
  });

  it("stores the raw arguments alongside the parsed input", async () => {
    const raw = '{ "path": "index.ts",  "offset": null, "limit": null }';
    const script = scripted(
      reply({ toolCalls: [call("call_0", "read_file", raw)] }),
      reply({ text: "done" }),
    );
    const { input, appended } = harness({ complete: script.complete });
    await runTurn(input);

    const message = appended.find((e) => e.type === "agent.message");
    expect(message).toMatchObject({
      content: [
        {
          type: "tool_use",
          id: "call_0",
          name: "read_file",
          input: { path: "index.ts", offset: null, limit: null },
          arguments: raw,
        },
      ],
    });
  });

  it("publishes deltas without storing them", async () => {
    const complete: Complete = async (_request, onDelta) => {
      onDelta({ text: "hel" });
      onDelta({ text: "lo" });
      onDelta({ reasoning: "thinking" });
      return reply({ text: "hello" });
    };
    const { input, appended, published } = harness({ complete });
    await runTurn(input);

    expect(types(published)).toEqual([
      "agent.text_delta",
      "agent.text_delta",
      "agent.thinking_delta",
    ]);
    expect(types(appended)).not.toContain("agent.text_delta");
  });
});

describe("parallel calls", () => {
  it("appends every tool_use in one batch, and results in call order", async () => {
    // The slow one is asked for first. current_time will finish long before
    // it, and the conversation must still show them the other way round.
    const script = scripted(
      reply({
        toolCalls: [
          call("call_0", "bash", '{"command":"sleep 0.4; echo slow","timeout_ms":null}'),
          call("call_1", "current_time", '{"timezone":"UTC"}'),
        ],
      }),
      reply({ text: "both done" }),
    );
    const { input, batches, appended } = harness({ complete: script.complete });

    await runTurn(input);

    // One append, so their order in the log is the model's order rather than
    // a race between writers.
    const useBatch = batches.find((batch) => batch[0]?.type === "agent.tool_use");
    expect(useBatch).toHaveLength(2);
    expect(useBatch!.map((e) => (e.type === "agent.tool_use" ? e.toolUseId : ""))).toEqual([
      "call_0",
      "call_1",
    ]);

    const results = appended.filter((e) => e.type === "agent.tool_result");
    expect(results.map((e) => (e.type === "agent.tool_result" ? e.toolUseId : ""))).toEqual([
      "call_0",
      "call_1",
    ]);

    // And the messages the next model call sees, which is what actually
    // matters: splitting or reordering these trains the model out of
    // calling tools in parallel at all.
    const replies = script.requests[1]!.messages.filter((m) => m.role === "tool");
    expect(replies.map((m) => ("tool_call_id" in m ? m.tool_call_id : ""))).toEqual([
      "call_0",
      "call_1",
    ]);
    expect(replies[0]).toHaveProperty("content", expect.stringContaining("slow"));
  });
});

describe("stopping", () => {
  it("reports max_iterations rather than looping for ever", async () => {
    const forever: Complete = async () =>
      reply({ toolCalls: [call("call_0", "current_time", '{"timezone":null}')] });

    const { input, appended } = harness({ complete: forever, maxIterations: 3 });
    const outcome = await runTurn(input);

    expect(outcome).toMatchObject({ stopReason: "max_iterations", iterations: 3 });
    expect(appended.filter((e) => e.type === "agent.message")).toHaveLength(3);
    // A cap is not a failure: the thread projects back to idle.
    expect(types(appended).at(-1)).toBe("agent.turn_completed");
  });

  it("stops between tool calls when the turn is cancelled, and still records every result", async () => {
    const controller = new AbortController();
    const script = scripted(
      reply({
        toolCalls: [
          call("call_0", "current_time", '{"timezone":null}'),
          call("call_1", "current_time", '{"timezone":"UTC"}'),
        ],
      }),
      reply({ text: "never reached" }),
    );

    const { input, appended } = harness({
      complete: async (request, onDelta) => {
        const result = await script.complete(request, onDelta);
        // Cancelled while the model was answering, which is the realistic
        // moment: the user pressed stop mid-stream.
        controller.abort();
        return result;
      },
      signal: controller.signal,
    });

    const outcome = await runTurn(input);

    expect(outcome.stopReason).toBe("cancelled");
    // Both calls were dispatched, so both have a result -- an assistant
    // message with an unanswered tool_call cannot be replayed.
    const results = appended.filter((e) => e.type === "agent.tool_result");
    expect(results).toHaveLength(2);
    expect(types(appended).at(-1)).toBe("agent.turn_completed");
    // The second model call never happened.
    expect(script.requests).toHaveLength(1);
  });

  it("does not start at all when the signal is already aborted", async () => {
    const { input, appended } = harness({ signal: AbortSignal.abort() });
    const outcome = await runTurn(input);

    expect(outcome).toMatchObject({ stopReason: "cancelled", iterations: 0 });
    expect(types(appended).filter((t) => t.startsWith("agent."))).toEqual(["agent.turn_completed"]);
  });

  it("lets an unexpected failure out, for the reactor to record", async () => {
    const { input } = harness({
      complete: async () => {
        throw new Error("no credit remaining");
      },
    });
    await expect(runTurn(input)).rejects.toThrow(/no credit remaining/);
  });
});

describe("the prompt", () => {
  it("is assembled stable first, and carries no timestamp", async () => {
    const script = scripted(reply({ text: "hi" }));
    const { input, appended } = harness({ complete: script.complete });
    await runTurn(input);

    const injected = appended.filter((e) => e.type === "context.injected");
    expect(injected.map((e) => (e.type === "context.injected" ? e.source : ""))).toEqual([
      "system_prompt",
      "project_context",
      "file_tree",
    ]);

    const system = script.requests[0]!.messages[0]!;
    expect(system.role).toBe("system");
    // The system prompt is spans now, not one string: the file tree moves on
    // its own and must not drag the rules and `AGENTS.md` with it.
    const text =
      system.role === "system" && Array.isArray(system.content)
        ? system.content.map((part) => part.text).join("\n\n")
        : String(system.content);
    expect(text).toContain("nextjs");
    expect(text).toContain("index.ts");
    // A timestamp here would cost the whole prefix on every single turn,
    // and nothing about the reply would look wrong.
    expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    // The old prompt told the model it could not run commands or edit files.
    expect(text).not.toMatch(/cannot run commands/i);
  });

  it("offers the frozen schema array, byte for byte, on every call", async () => {
    const script = scripted(
      reply({ toolCalls: [call("call_0", "current_time", "{}")] }),
      reply({ text: "done" }),
    );
    const { input } = harness({ complete: script.complete });
    await runTurn(input);

    expect(JSON.stringify(script.requests[0]!.tools)).toBe(
      JSON.stringify(script.requests[1]!.tools),
    );
    expect(script.requests[0]!.tools).toHaveLength(13);
  });

  it("withholds the shell when the deployment has not allowed it", async () => {
    const script = scripted(reply({ text: "hi" }));
    const { input } = harness({
      complete: script.complete,
      registry: { allowHostShell: false },
    });
    await runTurn(input);

    const names = script.requests[0]!.tools!.map((t) => t.function.name);
    expect(names).not.toContain("bash");
    expect(names).toHaveLength(12);
  });

  it("does not mention research on an ordinary turn", async () => {
    const script = scripted(reply({ text: "hi" }));
    const { input, appended } = harness({ complete: script.complete });
    await runTurn(input);

    const injected = appended.filter((e) => e.type === "context.injected");
    expect(injected).toHaveLength(3);
    expect(JSON.stringify(script.requests[0]!.messages[0])).not.toContain("research_search");
  });
});

describe("a research turn", () => {
  it("adds the pipeline's rules after the harness's own, and offers its tools", async () => {
    const script = scripted(reply({ text: "found" }));
    const { input, appended } = harness({
      complete: script.complete,
      preset: "research",
      mode: "research",
      research: { searchModel: "perplexity/sonar" },
    });
    await runTurn(input);

    const injected = appended.filter((e) => e.type === "context.injected");
    expect(injected.map((e) => (e.type === "context.injected" ? e.source : ""))).toEqual([
      "system_prompt",
      "system_prompt",
      "project_context",
      "file_tree",
    ]);
    const rules = injected[1]!;
    expect(rules.type === "context.injected" ? rules.content : "").toMatch(
      /research_search first[\s\S]*research_read next[\s\S]*research_browse only/,
    );

    const names = script.requests[0]!.tools!.map((t) => t.function.name);
    expect(names).toEqual(expect.arrayContaining(["research_search", "research_read", "research_browse"]));
    expect(names).not.toContain("web_search");
    expect(names).not.toContain("bash");
  });

  it("can be left open, returning its final text for the caller to hand on", async () => {
    const script = scripted(
      reply({ toolCalls: [call("call_0", "current_time", "{}")] }),
      reply({ text: "## Brief\n\nNext 15 is out." }),
    );
    const { input, appended } = harness({
      complete: script.complete,
      preset: "research",
      mode: "research",
      research: { searchModel: "perplexity/sonar" },
      conclude: false,
    });
    const outcome = await runTurn(input);

    expect(outcome.text).toBe("## Brief\n\nNext 15 is out.");
    expect(outcome.usage.inputTokens).toBe(20);
    // Everything but the closing event: the caller's turn is still going.
    expect(types(appended)).not.toContain("agent.turn_completed");
    expect(types(appended)).toContain("agent.tool_result");
  });

  it("concludes by default, and reports the final text either way", async () => {
    const script = scripted(reply({ text: "done" }));
    const { input, appended } = harness({ complete: script.complete });
    const outcome = await runTurn(input);
    expect(outcome.text).toBe("done");
    expect(types(appended)).toContain("agent.turn_completed");
  });

  it("runs the search through the configured model on the turn's key", async () => {
    const script = scripted(
      reply({ toolCalls: [call("call_0", "research_search", '{"query":"next 15","max_results":null}')] }),
      reply({ text: "done" }),
    );
    // The search is a sub-call through the same `complete`: the third
    // request in the script is the one the tool makes.
    const searches: CompletionRequest[] = [];
    const complete: Complete = async (request, onDelta) => {
      if (request.model === "perplexity/sonar") {
        searches.push(request);
        return reply({
          text: "Sonar says.",
          annotations: [{ type: "url_citation", url_citation: { url: "https://nextjs.org/blog" } }],
        });
      }
      return script.complete(request, onDelta);
    };
    const { input, appended } = harness({
      complete,
      preset: "research",
      mode: "research",
      research: { searchModel: "perplexity/sonar" },
      apiKey: "the-turn-key",
    });
    await runTurn(input);

    expect(searches).toHaveLength(1);
    expect(searches[0]).toMatchObject({ apiKey: "the-turn-key", model: "perplexity/sonar" });
    const result = appended.find((e) => e.type === "agent.tool_result");
    expect(result?.type === "agent.tool_result" ? result.content : "").toContain("Sonar says.");
    expect(result?.type === "agent.tool_result" ? result.content : "").toContain("https://nextjs.org/blog");
  });
});

describe("repairing a model's arguments", () => {
  // The failure this exists for: a cheaper model quotes its numbers, omits
  // the nullable property it has no use for, and then repeats the identical
  // call until the iteration cap ends the turn with nothing done.
  it("accepts a number sent as a string", async () => {
    const { input } = harness();
    const result = await runTool(
      call("c", "read_file", '{"path":"index.ts","offset":"1","limit":"1"}'),
      input,
    );

    expect(result.isError).toBe(false);
    expect(result.content).toMatch(/port = 3000/);
  });

  it("treats an omitted nullable property as null", async () => {
    const { input } = harness();
    const result = await runTool(call("c", "read_file", '{"path":"index.ts"}'), input);

    expect(result.isError).toBe(false);
    expect(result.content).toMatch(/port = 3000/);
  });

  it("accepts a boolean sent as a string", async () => {
    const { input } = harness();
    await runTool(call("w", "write_file", '{"path":"dup.txt","content":"x x"}'), input);

    // Two occurrences, so this only succeeds if "true" became true: the
    // edit is refused as ambiguous otherwise.
    const result = await runTool(
      call(
        "c",
        "edit_file",
        '{"path":"dup.txt","old_string":"x","new_string":"y","replace_all":"true"}',
      ),
      input,
    );

    expect(result.isError).toBe(false);
    expect(result.content).toMatch(/2/);
  });

  it("accepts the whole argument object sent as a JSON string", async () => {
    const { input } = harness();
    const result = await runTool(
      call("c", "read_file", JSON.stringify('{"path":"index.ts","offset":null,"limit":null}')),
      input,
    );

    expect(result.isError).toBe(false);
    expect(result.content).toMatch(/port = 3000/);
  });

  it("runs the shell call that used to be refused outright", async () => {
    // Verbatim the shape a smaller model sends: the timeout quoted. It is
    // the call that stalled a real turn, so it is the call that is tested.
    const { input } = harness();
    await runTool(call("w", "write_file", '{"path":"index.html","content":"<h1>x</h1>"}'), input);

    const result = await runTool(
      call("c", "bash", '{"command":"rm index.html && echo gone","timeout_ms":"5000"}'),
      input,
    );

    expect(result.isError).toBe(false);
    expect(result.content).toMatch(/gone/);
  });

  it("does not invent an argument that was never sent", async () => {
    const { input } = harness();
    // `path` has no default and is not nullable, so there is nothing to
    // repair it to -- this must stay an error rather than become read("").
    const result = await runTool(call("c", "read_file", "{}"), input);

    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/do not match its schema/);
  });

  it("tells a model that keeps sending the same broken call", async () => {
    const broken = '{"path":{"file":"a.ts"},"offset":null,"limit":null}';
    const script = scripted(
      reply({ toolCalls: [call("c0", "read_file", broken)], finishReason: "tool_calls" }),
      reply({ toolCalls: [call("c1", "read_file", broken)], finishReason: "tool_calls" }),
      reply({ text: "I will try something else.", finishReason: "stop" }),
    );
    const { input, appended } = harness({ complete: script.complete });
    await runTurn(input);

    const results = appended.filter((event) => event.type === "agent.tool_result");
    expect(results[0]).toMatchObject({ isError: true });
    expect((results[0] as { content: string }).content).not.toMatch(/attempt 2/);
    expect((results[1] as { content: string }).content).toMatch(/attempt 2 at read_file/);
  });
});

describe("runTool", () => {
  // Total by construction: every one of these is a result the model can act
  // on, and none of them is a dropped reply.
  const cases: [string, ToolCall, RegExp][] = [
    ["an unknown tool", call("c", "no_such_tool", "{}"), /no tool called/],
    ["malformed JSON arguments", call("c", "read_file", "{not json"), /not valid JSON/],
    [
      // A slip no coercion can undo: an object is not a path. The quoted
      // number and the omitted nullable that used to sit here are repaired
      // now rather than refused -- see "repairing a model's arguments".
      "a schema violation",
      call("c", "read_file", '{"path":{"file":"a.ts"},"offset":null,"limit":null}'),
      /do not match its schema/,
    ],
    [
      "a tool that throws",
      call("c", "read_file", '{"path":"nope.ts","offset":null,"limit":null}'),
      /failed/,
    ],
    [
      "a path outside the workspace",
      call("c", "read_file", '{"path":"../../etc/passwd","offset":null,"limit":null}'),
      /escapes the workspace/,
    ],
  ];

  it.each(cases)("turns %s into an error result", async (_label, toolCall, expected) => {
    const { input } = harness();
    const result = await runTool(toolCall, input);

    expect(result).toMatchObject({ toolUseId: "c", isError: true });
    expect(result.content).toMatch(expected);
    expect(result.content.length).toBeGreaterThan(0);
  });

  it("says what the call should have looked like, not just what was wrong", async () => {
    const { input } = harness();
    const result = await runTool(call("c", "read_file", '{"path":[1,2]}'), input);

    // The shape of the call, restated: a model that has just miscalled a
    // tool is the one least likely to re-derive it from the schema.
    expect(result.content).toMatch(/path \(string\)/);
    expect(result.content).toMatch(/offset \(integer or null\)/);
    expect(result.content).toMatch(/unquoted/);
  });

  it("refuses to dispatch once the turn is cancelled", async () => {
    const { input } = harness({ signal: AbortSignal.abort() });
    const result = await runTool(call("c", "current_time", '{"timezone":null}'), input);

    expect(result).toMatchObject({ isError: true });
    expect(result.content).toMatch(/cancelled/);
  });

  it("reports a tool that outruns its own timeout", async () => {
    const { input } = harness();
    const result = await runTool(
      // The tool's cap is respected by bash itself; this checks the loop's
      // backstop by giving it a command that outlives its budget.
      call("c", "bash", '{"command":"sleep 5","timeout_ms":1000}'),
      input,
    );

    expect(result).toMatchObject({ isError: true });
    expect(result.content).toMatch(/timed out/);
  });

  it("succeeds, and times what it did", async () => {
    const { input } = harness();
    const result = await runTool(call("c", "current_time", '{"timezone":"UTC"}'), input);

    expect(result.isError).toBe(false);
    expect(result.content).toContain("ISO 8601");
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("never returns an empty result, whatever the tool did", async () => {
    const { input } = harness();
    for (const [, toolCall] of cases) {
      const result = await runTool(toolCall, input);
      expect(result.content.trim()).not.toBe("");
    }
  });
});

describe("safe and exclusive dispatch", () => {
  /**
   * Runs one iteration of tool calls and reports the interleaving.
   *
   * Each tool is timed rather than instrumented, because the property under
   * test is about overlap and the only honest way to see overlap is to watch
   * two things be in flight at once.
   */
  const trace = async (...calls: ToolCall[]) => {
    const order: string[] = [];
    const script = scripted(
      reply({ toolCalls: calls, finishReason: "tool_calls" }),
      reply({ text: "done", finishReason: "stop" }),
    );
    const { input, appended } = harness({ complete: script.complete });

    await runTurn(input);
    for (const event of appended) {
      if (event.type === "agent.tool_result") order.push(event.toolUseId);
    }
    return { order, requests: script.requests };
  };

  it("returns results in the assistant's order, whatever finishes first", async () => {
    // Splitting or reordering tool results trains the model out of asking
    // for parallel calls at all (`plan.md` §6.4), so this is load-bearing.
    const { order } = await trace(
      call("call_0", "read_file", '{"path":"index.ts","offset":null,"limit":null}'),
      call("call_1", "current_time", '{"timezone":null}'),
      call("call_2", "glob", '{"pattern":"*.ts","path":null}'),
    );
    expect(order).toEqual(["call_0", "call_1", "call_2"]);
  });

  it("lands the second of two writes to one path", async () => {
    // Weaker than it looks on its own -- two writes started in order usually
    // finish in order even unscheduled. It is here as a regression guard on
    // the result ordering; the test below is the one that catches the race.
    const { order, requests } = await trace(
      call("call_0", "write_file", '{"path":"race.txt","content":"first"}'),
      call("call_1", "write_file", '{"path":"race.txt","content":"second"}'),
    );
    expect(order).toEqual(["call_0", "call_1"]);

    const results = requests[1]!.messages.filter((message) => message.role === "tool");
    expect(results).toHaveLength(2);
    const written = await readFile(join(root, "race.txt"), "utf8");
    expect(written).toBe("second");
  });

  it("keeps a read behind the write the model asked for first", async () => {
    const { order, requests } = await trace(
      call("call_0", "write_file", '{"path":"ordered.txt","content":"written"}'),
      call("call_1", "read_file", '{"path":"ordered.txt","offset":null,"limit":null}'),
    );
    expect(order).toEqual(["call_0", "call_1"]);
    const results = requests[1]!.messages.filter((message) => message.role === "tool");
    expect(String(results[1]!.content)).toContain("written");
  });

  it("still runs an unknown tool through the same ordering", async () => {
    const { order } = await trace(
      call("call_0", "not_a_tool", "{}"),
      call("call_1", "current_time", '{"timezone":null}'),
    );
    expect(order).toEqual(["call_0", "call_1"]);
  });
});

describe("the segmented system prompt", () => {
  it("carries the volatile file tree in its own unmarked span", async () => {
    const script = scripted(reply({ text: "hi", finishReason: "stop" }));
    const { input } = harness({ complete: script.complete });
    await runTurn(input);

    const system = script.requests[0]!.messages[0]!;
    expect(system.role).toBe("system");
    const spans = system.content as { text: string; cacheable?: boolean }[];
    expect(Array.isArray(spans)).toBe(true);

    // The rules are first and marked; the tree is last and is not.
    expect(spans[0]!.cacheable).toBe(true);
    expect(spans[0]!.text).toContain("coding agent inside UCCH");
    expect(spans.at(-1)!.text).toContain("Files in this project:");
    expect(spans.at(-1)!.cacheable).toBeUndefined();
  });

  it("marks the project context as the second reusable prefix", async () => {
    const script = scripted(reply({ text: "hi", finishReason: "stop" }));
    const { input } = harness({ complete: script.complete, stack: "nextjs" });
    await runTurn(input);

    const spans = script.requests[0]!.messages[0]!.content as {
      text: string;
      cacheable?: boolean;
    }[];
    const marked = spans.filter((span) => span.cacheable);
    expect(marked).toHaveLength(2);
    expect(marked[1]!.text).toContain("nextjs");
  });
});

describe("the cache canary", () => {
  it("says so when a second iteration reads nothing back", async () => {
    // A prompt cache fails silently: every reply still looks right and the
    // turn just costs several times what it should.
    const heavy = { inputTokens: 50_000, outputTokens: 5, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 };
    const script = scripted(
      reply({ toolCalls: [call("call_0", "current_time", '{"timezone":null}')], finishReason: "tool_calls", usage: heavy }),
      reply({ text: "done", finishReason: "stop", usage: heavy }),
    );
    const diagnostics: string[] = [];
    const { input } = harness({
      complete: script.complete,
      onDiagnostic: (message) => diagnostics.push(message),
    });

    await runTurn(input);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toContain("prompt cache missed on iteration 2");
  });

  it("stays quiet on a conversation too short for any provider to cache", async () => {
    const light = { inputTokens: 400, outputTokens: 5, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 };
    const script = scripted(
      reply({ toolCalls: [call("call_0", "current_time", '{"timezone":null}')], finishReason: "tool_calls", usage: light }),
      reply({ text: "done", finishReason: "stop", usage: light }),
    );
    const diagnostics: string[] = [];
    const { input } = harness({
      complete: script.complete,
      onDiagnostic: (message) => diagnostics.push(message),
    });

    await runTurn(input);
    expect(diagnostics).toEqual([]);
  });
});

describe("keeping a turn inside the context window", () => {
  /** A history heavy enough to trip the escalations, as durable events. */
  const heavyHistory = (turns: number, bytes: number): DomainEvent[] =>
    Array.from({ length: turns }, (_, i) => [
      { type: "user.message" as const, threadId: THREAD, text: `ask ${i}` },
      {
        type: "agent.message" as const,
        threadId: THREAD,
        turnId: TURN,
        content: [
          {
            type: "tool_use",
            id: `call_${i}`,
            name: "read_file",
            input: { path: "index.ts", offset: null, limit: null },
            arguments: '{"path":"index.ts","offset":null,"limit":null}',
          },
        ],
      },
      {
        type: "agent.tool_result" as const,
        threadId: THREAD,
        turnId: TURN,
        toolUseId: `call_${i}`,
        content: "x".repeat(bytes),
        isError: false,
        durationMs: 1,
      },
    ]).flat();

  it("does nothing at all when the catalogue publishes no window", async () => {
    // A guessed ceiling either compacts a thread that was fine or fails to
    // compact one that was not, so an unknown window disables the machinery.
    const script = scripted(reply({ text: "done", finishReason: "stop" }));
    const { input } = harness({
      complete: script.complete,
      history: heavyHistory(20, 40_000),
      contextLength: null,
    });

    await runTurn(input);
    expect(script.requests).toHaveLength(1);
    const results = script.requests[0]!.messages.filter((m) => m.role === "tool");
    expect(String(results[0]!.content)).toHaveLength(40_000);
  });

  it("prunes the oldest tool results before it spends a model call", async () => {
    const script = scripted(reply({ text: "done", finishReason: "stop" }));
    const { input, appended } = harness({
      complete: script.complete,
      history: heavyHistory(20, 40_000),
      contextLength: 120_000,
    });

    await runTurn(input);
    // One request: the turn's own. Compaction was not reached.
    expect(script.requests).toHaveLength(1);
    expect(appended.some((event) => event.type === "context.injected" && event.source === "compaction")).toBe(false);

    const results = script.requests[0]!.messages.filter((m) => m.role === "tool");
    expect(String(results[0]!.content)).toContain("call the tool again");
    // And the recent ones are whole.
    expect(String(results.at(-1)!.content)).toHaveLength(40_000);
  });

  it("compacts to a durable checkpoint, and bills what the summary cost", async () => {
    const summariser = reply({
      text: "Read index.ts twenty times; nothing changed.",
      finishReason: "stop",
      usage: { inputTokens: 900, outputTokens: 60, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
      costUsd: 0.004,
    });
    const script = scripted(summariser, reply({ text: "done", finishReason: "stop" }));
    const { input, appended } = harness({
      complete: script.complete,
      history: heavyHistory(40, 40_000),
      contextLength: 60_000,
      searchModel: "cheap/model",
    });

    const outcome = await runTurn(input);

    // The summary went to the cheap model; the turn went to the turn's model.
    expect(script.requests[0]!.model).toBe("cheap/model");
    expect(script.requests[1]!.model).toBe("test/model");

    // Durable before it was used, so a restart replays the folded thread.
    const checkpoint = appended.find(
      (event) => event.type === "context.injected" && event.source === "compaction",
    );
    expect(checkpoint).toBeDefined();

    // Billed, not absorbed.
    expect(outcome.costUsd).toBeCloseTo(0.005, 5);
    expect(outcome.usage.outputTokens).toBe(65);

    // And the request that followed carries the summary, not the history.
    const folded = script.requests[1]!.messages;
    expect(String(folded[1]!.content)).toContain("Read index.ts twenty times");
  });

  it("says so plainly when neither escalation can make room", async () => {
    // One tool result larger than the whole window: nothing to fold, and a
    // provider length error nobody can act on if it went out as it is.
    const script = scripted(reply({ text: "done", finishReason: "stop" }));
    const { input } = harness({
      complete: script.complete,
      history: heavyHistory(1, 400_000),
      contextLength: 30_000,
    });

    await expect(runTurn(input)).rejects.toThrow(/no longer fits/);
  });
});

describe("approval", () => {
  it("asks before a write and not before a read", async () => {
    const { input } = harness();
    const asked: string[] = [];
    input.approve = async (request) => {
      asked.push(`${request.toolName}:${request.permission}`);
      return { behavior: "allow" };
    };

    await runTool(call("r", "read_file", '{"path":"index.ts"}'), input);
    const written = await runTool(
      call("w", "write_file", '{"path":"approved.txt","content":"ok"}'),
      input,
    );

    expect(asked).toEqual(["write_file:write"]);
    expect(written.isError).toBe(false);
  });

  it("turns a deny into the tool's error, with the person's reason", async () => {
    const { input } = harness();
    input.approve = async () => ({ behavior: "deny", message: "use a branch instead" });

    const result = await runTool(
      call("w", "write_file", '{"path":"denied.txt","content":"no"}'),
      input,
    );

    expect(result).toMatchObject({ isError: true, content: "use a branch instead" });
    await expect(readFile(join(root, "denied.txt"), "utf8")).rejects.toThrow();
  });
});
