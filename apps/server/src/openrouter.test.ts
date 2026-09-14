import { afterEach, describe, expect, it, vi } from "vitest";
import { streamCompletion, type ChatMessage } from "./openrouter.js";

/**
 * Serves a fixed byte sequence as the response body.
 *
 * The pieces are handed to the reader exactly as given, so a test can put a
 * frame boundary -- or the middle of a JSON token -- anywhere it likes. That
 * split is the whole point: every parser bug fixed here was a boundary
 * landing somewhere the old reader did not expect.
 */
function serve(...pieces: string[]): { calls: { body: any }[] } {
  const calls: { body: any }[] = [];
  const encoder = new TextEncoder();

  vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
    calls.push({ body: JSON.parse(String(init.body)) });
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const piece of pieces) controller.enqueue(encoder.encode(piece));
        controller.close();
      },
    });
    return new Response(body, { status: 200 });
  });

  return { calls };
}

const run = (deltas: { text?: string; reasoning?: string }[] = []) =>
  streamCompletion(
    { apiKey: "k", model: "m", messages: [{ role: "user", content: "hi" }] },
    (d) => deltas.push(d),
  );

/** One `data:` frame, terminated. */
const frame = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`;

/** A chunk carrying one tool-call fragment. */
const toolFragment = (fragment: Record<string, unknown>) =>
  frame({ choices: [{ index: 0, delta: { tool_calls: [fragment] } }] });

afterEach(() => vi.unstubAllGlobals());

describe("frame splitting", () => {
  it("reassembles a frame split across reads", async () => {
    serve('data: {"choices":[{"delta":{"cont', 'ent":"hello"}}]}\n\n');
    expect((await run()).text).toBe("hello");
  });

  // The old reader split on "\n\n" alone, so a CRLF stream produced one
  // enormous frame that never matched and yielded an empty reply.
  it("splits CRLF frames", async () => {
    serve(
      'data: {"choices":[{"delta":{"content":"a"}}]}\r\n\r\n',
      'data: {"choices":[{"delta":{"content":"b"}}]}\r\n\r\n',
    );
    expect((await run()).text).toBe("ab");
  });

  // A final frame with no trailing blank line was silently dropped, and it is
  // usually the one carrying usage.
  it("keeps a final frame that has no trailing blank line", async () => {
    serve(
      frame({ choices: [{ delta: { content: "answer" } }] }),
      'data: {"choices":[],"usage":{"prompt_tokens":11,"completion_tokens":3}}',
    );

    const result = await run();
    expect(result.text).toBe("answer");
    expect(result.usage.inputTokens).toBe(11);
    expect(result.usage.outputTokens).toBe(3);
  });

  it("ignores keepalive comments and [DONE]", async () => {
    serve(
      ": OPENROUTER PROCESSING\n\n",
      frame({ choices: [{ delta: { content: "x" } }] }),
      "data: [DONE]\n\n",
    );
    expect((await run()).text).toBe("x");
  });
});

describe("streamed tool calls", () => {
  it("concatenates arguments split mid-token", async () => {
    serve(
      toolFragment({ index: 0, id: "call_a", type: "function", function: { name: "read_file", arguments: "" } }),
      toolFragment({ index: 0, function: { arguments: '{"pa' } }),
      toolFragment({ index: 0, function: { arguments: 'th":"src/in' } }),
      toolFragment({ index: 0, function: { arguments: 'dex.ts"}' } }),
      frame({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }),
    );

    const { toolCalls } = await run();
    expect(toolCalls).toEqual([
      {
        id: "call_a",
        type: "function",
        function: { name: "read_file", arguments: '{"path":"src/index.ts"}' },
      },
    ]);
  });

  // Arrival order is not call order. Appending to an array as fragments land
  // would have put call 1 at position 0 and then fed call 0's arguments into
  // it -- two corrupted calls out of two.
  it("orders by index even when index 1 arrives first", async () => {
    serve(
      toolFragment({ index: 1, id: "call_b", function: { name: "second", arguments: '{"b":2}' } }),
      toolFragment({ index: 0, id: "call_a", function: { name: "first", arguments: '{"a":1}' } }),
    );

    const { toolCalls } = await run();
    expect(toolCalls.map((c) => c.function.name)).toEqual(["first", "second"]);
    expect(toolCalls.map((c) => c.function.arguments)).toEqual(['{"a":1}', '{"b":2}']);
  });

  it("keeps an id that arrives after the arguments", async () => {
    serve(
      toolFragment({ index: 0, function: { name: "grep", arguments: '{"pattern":"x"}' } }),
      toolFragment({ index: 0, id: "call_late" }),
    );
    expect((await run()).toolCalls[0]!.id).toBe("call_late");
  });

  // Later fragments routinely repeat these as empty strings.
  it("never overwrites a set field with an empty one", async () => {
    serve(
      toolFragment({ index: 0, id: "call_a", function: { name: "grep", arguments: "" } }),
      toolFragment({ index: 0, id: "", function: { name: "", arguments: '{"pattern":"x"}' } }),
    );

    expect((await run()).toolCalls[0]).toMatchObject({
      id: "call_a",
      function: { name: "grep", arguments: '{"pattern":"x"}' },
    });
  });

  it("synthesises an id when the provider sends none", async () => {
    serve(toolFragment({ index: 2, function: { name: "current_time", arguments: "{}" } }));
    expect((await run()).toolCalls[0]!.id).toBe("call_2");
  });

  // `JSON.parse("")` throws, so a zero-argument call would otherwise take out
  // the whole turn.
  it("normalises empty arguments to an empty object", async () => {
    serve(toolFragment({ index: 0, id: "call_a", function: { name: "current_time", arguments: "" } }));

    const call = (await run()).toolCalls[0]!;
    expect(call.function.arguments).toBe("{}");
    expect(JSON.parse(call.function.arguments)).toEqual({});
  });

  // Some providers finish with "stop" even when calls are present, which is
  // why the loop must branch on toolCalls.length rather than on this.
  it("reports tool calls alongside a plain stop", async () => {
    serve(
      toolFragment({ index: 0, id: "call_a", function: { name: "glob", arguments: '{"pattern":"*"}' } }),
      frame({ choices: [{ delta: {}, finish_reason: "stop" }] }),
    );

    const result = await run();
    expect(result.finishReason).toBe("stop");
    expect(result.toolCalls).toHaveLength(1);
  });

  it("keeps text that interleaves with tool calls, and tolerates a null content", async () => {
    serve(
      frame({ choices: [{ delta: { content: "Looking… " } }] }),
      frame({ choices: [{ delta: { content: null } }] }),
      toolFragment({ index: 0, id: "call_a", function: { name: "list_dir", arguments: "{}" } }),
    );

    const deltas: { text?: string }[] = [];
    const result = await run(deltas);
    expect(result.text).toBe("Looking… ");
    expect(result.toolCalls).toHaveLength(1);
    // A null content is not a delta anyone should be shown.
    expect(deltas).toEqual([{ text: "Looking… ", reasoning: undefined }]);
  });
});

describe("a recorded two-call parallel response", () => {
  // Shaped like a real OpenRouter stream: both calls opened in one chunk,
  // then their arguments interleaved fragment by fragment, then a usage
  // chunk with no choices and no trailing blank line.
  const fixture = [
    'data: {"id":"gen-1","choices":[{"index":0,"delta":{"role":"assistant","content":""}}]}\n\n',
    'data: {"id":"gen-1","choices":[{"index":0,"delta":{"tool_calls":[' +
      '{"index":0,"id":"call_0_read","type":"function","function":{"name":"read_file","arguments":""}},' +
      '{"index":1,"id":"call_1_grep","type":"function","function":{"name":"grep","arguments":""}}]}}]}\n\n',
    'data: {"id":"gen-1","choices":[{"index":0,"delta":{"tool_calls":[{"index":1,"function":{"arguments":"{\\"pat"}}]}}]}\n\n',
    'data: {"id":"gen-1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"path\\":\\"src/"}}]}}]}\n\n',
    'data: {"id":"gen-1","choices":[{"index":0,"delta":{"tool_calls":[{"index":1,"function":{"arguments":"tern\\":\\"normalizeWorkspacePath\\"}"}}]}}]}\n\n',
    'data: {"id":"gen-1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"decide.ts\\"}"}}]}}]}\n\n',
    'data: {"id":"gen-1","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n',
    'data: {"id":"gen-1","choices":[],"usage":{"prompt_tokens":1284,"completion_tokens":62,' +
      '"prompt_tokens_details":{"cached_tokens":1024},"cost":0.0031}}',
  ];

  it("reconstructs both calls byte for byte", async () => {
    // One read per line, then again with the whole stream as a single read:
    // the result must not depend on where the network happened to split.
    for (const pieces of [fixture, [fixture.join("")]]) {
      serve(...pieces);
      const result = await run();

      expect(result.toolCalls).toEqual([
        {
          id: "call_0_read",
          type: "function",
          function: { name: "read_file", arguments: '{"path":"src/decide.ts"}' },
        },
        {
          id: "call_1_grep",
          type: "function",
          function: {
            name: "grep",
            arguments: '{"pattern":"normalizeWorkspacePath"}',
          },
        },
      ]);
      expect(result.finishReason).toBe("tool_calls");
      expect(result.usage).toEqual({
        inputTokens: 1284,
        outputTokens: 62,
        cacheReadInputTokens: 1024,
        cacheCreationInputTokens: 0,
      });
      expect(result.costUsd).toBeCloseTo(0.0031);
      vi.unstubAllGlobals();
    }
  });
});

describe("usage", () => {
  it("maps the cache figures the canary reads", async () => {
    serve(
      frame({
        choices: [],
        usage: {
          prompt_tokens: 900,
          completion_tokens: 40,
          prompt_tokens_details: { cached_tokens: 850, cache_write_tokens: 50 },
        },
      }),
    );

    expect((await run()).usage).toEqual({
      inputTokens: 900,
      outputTokens: 40,
      cacheReadInputTokens: 850,
      cacheCreationInputTokens: 50,
    });
  });

  // Providers differ on where they hang the cache-write count.
  it("accepts the top-level spellings too", async () => {
    serve(
      frame({
        choices: [],
        usage: { prompt_tokens: 1, completion_tokens: 1, cache_creation_input_tokens: 7 },
      }),
    );
    expect((await run()).usage.cacheCreationInputTokens).toBe(7);
  });

  it("reports zeroes rather than guessing when nothing is reported", async () => {
    serve(frame({ choices: [{ delta: { content: "x" } }] }));
    expect((await run()).usage).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    });
  });
});

describe("the request body", () => {
  it("omits tools and tool_choice entirely when there are none", async () => {
    const { calls } = serve(frame({ choices: [{ delta: { content: "x" } }] }));
    await streamCompletion(
      { apiKey: "k", model: "m", messages: [], tools: [], toolChoice: "auto", plugins: [] },
      () => {},
    );

    expect(calls[0]!.body).not.toHaveProperty("tools");
    expect(calls[0]!.body).not.toHaveProperty("tool_choice");
    expect(calls[0]!.body).not.toHaveProperty("plugins");
    // Usage accounting is what makes the cache figures arrive at all.
    expect(calls[0]!.body.usage).toEqual({ include: true });
  });

  it("sends tools, tool_choice and plugins when they are given", async () => {
    const { calls } = serve(frame({ choices: [{ delta: { content: "x" } }] }));
    await streamCompletion(
      {
        apiKey: "k",
        model: "m",
        messages: [],
        tools: [
          {
            type: "function",
            function: { name: "grep", description: "search", parameters: {}, strict: true },
          },
        ],
        toolChoice: "required",
        plugins: [{ id: "web" }],
      },
      () => {},
    );

    expect(calls[0]!.body.tools).toHaveLength(1);
    expect(calls[0]!.body.tool_choice).toBe("required");
    expect(calls[0]!.body.plugins).toEqual([{ id: "web" }]);
  });

  // The union is the wire shape, so the conversation goes out untransformed.
  it("sends the messages through untouched", async () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "rules" },
      { role: "user", content: "read a file" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "call_a", type: "function", function: { name: "read_file", arguments: '{"path":"a"}' } },
        ],
      },
      { role: "tool", tool_call_id: "call_a", content: "1| hello" },
    ];

    const { calls } = serve(frame({ choices: [{ delta: { content: "x" } }] }));
    await streamCompletion({ apiKey: "k", model: "m", messages }, () => {});

    expect(calls[0]!.body.messages).toEqual(messages);
  });
});

describe("web plugin annotations", () => {
  it("collects url citations in the order they stream", async () => {
    const citation = (url: string) => ({
      type: "url_citation",
      url_citation: { url, title: url },
    });

    serve(
      frame({ choices: [{ delta: { annotations: [citation("https://a.example")] } }] }),
      frame({ choices: [{ delta: { annotations: [citation("https://b.example")] } }] }),
    );

    expect((await run()).annotations.map((a) => a.url_citation?.url)).toEqual([
      "https://a.example",
      "https://b.example",
    ]);
  });
});

describe("failures", () => {
  it("reports an error that arrives mid-stream instead of returning an empty reply", async () => {
    serve(
      frame({ choices: [{ delta: { content: "partial" } }] }),
      frame({ error: { code: 429, message: "rate limited upstream" } }),
    );

    await expect(run()).rejects.toThrow(/rate limited upstream/);
  });

  it("carries the provider's explanation on a failed request", async () => {
    vi.stubGlobal("fetch", async () =>
      new Response("no credit remaining", { status: 402 }),
    );
    await expect(run()).rejects.toThrow(/402 no credit remaining/);
  });
});

/**
 * The §10 canary read zero on every request for a reason that had nothing to
 * do with prompt stability: Anthropic and Google cache only what a request
 * marks, and the harness marked nothing.
 */
describe("prompt cache breakpoints", () => {
  const conversation: ChatMessage[] = [
    { role: "system", content: "rules" },
    { role: "user", content: "first" },
    {
      role: "assistant",
      content: null,
      tool_calls: [
        { id: "call_a", type: "function", function: { name: "read_file", arguments: "{}" } },
      ],
    },
    { role: "tool", tool_call_id: "call_a", content: "1| hello" },
    { role: "user", content: "second" },
  ];

  const bodyFor = async (model: string, messages = conversation) => {
    const { calls } = serve(frame({ choices: [{ delta: { content: "x" } }] }));
    await streamCompletion({ apiKey: "k", model, messages }, () => {});
    return calls[0]!.body;
  };

  it("marks the system prompt and rolls two marks along the tail", async () => {
    const body = await bodyFor("anthropic/claude-sonnet-4.5");
    const marked = { type: "text", cache_control: { type: "ephemeral" } };

    expect(body.messages[0].content).toEqual([{ ...marked, text: "rules" }]);
    // The last markable messages, not the last *user* message. A mark that
    // never moves inside a turn is a mark the next iteration cannot read
    // from -- which is what made a long turn re-buy its own tool output.
    expect(body.messages[1].content).toEqual([{ ...marked, text: "first" }]);
    expect(body.messages[4].content).toEqual([{ ...marked, text: "second" }]);
    // `content: null` carries no text part, so it can hold no mark.
    expect(body.messages[2]).toEqual(conversation[2]);
  });

  it("never rewrites a tool result", async () => {
    // OpenRouter documents `cache_control` on system and user content parts
    // and says nothing about tool messages. Breaking every tool result to
    // chase a cache read is not a trade worth making on a guess.
    const body = await bodyFor("anthropic/claude-sonnet-4.5");
    expect(body.messages[3]).toEqual(conversation[3]);
  });

  it("moves the marks as the conversation grows", async () => {
    // One more assistant turn: the mark that was on the tail is now
    // mid-prefix, which is exactly what the next request reads back rather
    // than paying for again.
    const body = await bodyFor("anthropic/claude-sonnet-4.5", [
      ...conversation,
      { role: "assistant", content: "and here is why" },
    ]);
    expect(body.messages[1]).toEqual({ role: "user", content: "first" });
    expect(body.messages[4].content[0].cache_control).toEqual({ type: "ephemeral" });
    expect(body.messages[5].content[0].cache_control).toEqual({ type: "ephemeral" });
  });

  it("rejoins the system spans for a provider that caches on its own", async () => {
    // The spans are a harness-side device. A provider that was never told
    // about them must not be sent a `cacheable` field it does not know.
    const body = await bodyFor("openai/gpt-5", [
      {
        role: "system",
        content: [
          { type: "text", text: "rules", cacheable: true },
          { type: "text", text: "tree" },
        ],
      },
      { role: "user", content: "hi" },
    ]);
    expect(body.messages[0]).toEqual({ role: "system", content: "rules\n\ntree" });
  });

  it("marks each cacheable span of a segmented system prompt", async () => {
    const body = await bodyFor("anthropic/claude-sonnet-4.5", [
      {
        role: "system",
        content: [
          { type: "text", text: "rules", cacheable: true },
          { type: "text", text: "agents", cacheable: true },
          { type: "text", text: "tree" },
        ],
      },
      { role: "user", content: "hi" },
    ]);
    // The tree is the volatile tail: unmarked on purpose, so a repository
    // that gained a file re-buys the tree and nothing ahead of it.
    expect(body.messages[0].content).toEqual([
      { type: "text", text: "rules", cache_control: { type: "ephemeral" } },
      { type: "text", text: "agents", cache_control: { type: "ephemeral" } },
      { type: "text", text: "tree" },
    ]);
  });

  it("marks google the same way", async () => {
    const body = await bodyFor("google/gemini-2.5-pro");
    expect(body.messages[0].content[0].cache_control).toEqual({ type: "ephemeral" });
  });

  it("leaves a provider that caches on its own untouched", async () => {
    // OpenAI reports `cached_tokens` without being asked, and a request it
    // does not recognise is a request that could be refused.
    expect(await bodyFor("openai/gpt-5").then((b) => b.messages)).toEqual(conversation);
  });

  it("marks the system prompt even when there is no user message yet", async () => {
    const body = await bodyFor("anthropic/claude-sonnet-4.5", [
      { role: "system", content: "rules" },
    ]);
    expect(body.messages[0].content[0].text).toBe("rules");
  });

  it("never sends an empty text part", async () => {
    // A provider rejects one outright, so an empty message stays a string.
    const body = await bodyFor("anthropic/claude-sonnet-4.5", [
      { role: "system", content: "" },
      { role: "user", content: "hi" },
    ]);
    expect(body.messages[0]).toEqual({ role: "system", content: "" });
  });
});

describe("keyQuota", () => {
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  it("reads the key's figures and the account's credits, authenticated as the key", async () => {
    const seen: { url: string; auth: string | undefined }[] = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      seen.push({ url, auth: (init?.headers as Record<string, string>)?.authorization });
      if (url.endsWith("/auth/key")) {
        return json({
          data: { label: "harness", usage: 12.5, limit: 50, limit_remaining: 37.5, is_free_tier: false },
        });
      }
      return json({ data: { total_credits: 100, total_usage: 40 } });
    });

    const { keyQuota } = await import("./openrouter.js");
    const quota = await keyQuota("sk-or-test");

    expect(seen.map((s) => s.url)).toEqual([
      "https://openrouter.ai/api/v1/auth/key",
      "https://openrouter.ai/api/v1/credits",
    ]);
    expect(seen.every((s) => s.auth === "Bearer sk-or-test")).toBe(true);
    expect(quota).toEqual({
      label: "harness",
      usageUsd: 12.5,
      limitUsd: 50,
      limitRemainingUsd: 37.5,
      freeTier: false,
      credits: { totalUsd: 100, usedUsd: 40 },
    });
  });

  it("derives what is left of a limit when OpenRouter does not say, and treats no limit as null", async () => {
    vi.stubGlobal("fetch", async (url: string) =>
      url.endsWith("/auth/key")
        ? json({ data: { usage: 60, limit: 50 } })
        : new Response("forbidden", { status: 403 }),
    );
    const { keyQuota } = await import("./openrouter.js");
    const over = await keyQuota("k");
    expect(over).toMatchObject({ limitUsd: 50, limitRemainingUsd: 0, credits: null, label: null });

    vi.stubGlobal("fetch", async (url: string) =>
      url.endsWith("/auth/key") ? json({ data: { usage: 3, limit: null } }) : json({ data: {} }),
    );
    const unlimited = await keyQuota("k");
    expect(unlimited).toMatchObject({ limitUsd: null, limitRemainingUsd: null, credits: null });
  });

  it("fails when the key endpoint does, whatever credits say", async () => {
    vi.stubGlobal("fetch", async (url: string) =>
      url.endsWith("/auth/key") ? new Response("nope", { status: 401 }) : json({ data: {} }),
    );
    const { keyQuota } = await import("./openrouter.js");
    await expect(keyQuota("bad")).rejects.toThrow(/key lookup failed: 401/);
  });
});
