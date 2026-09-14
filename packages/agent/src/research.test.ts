import { describe, expect, it, vi } from "vitest";
import type { Complete, CompletionResult } from "./completion.js";
import {
  bindResearch,
  browserUseAgent,
  crawl4aiReader,
  looksGated,
  sonarSearchProvider,
} from "./research.js";

const completion = (over: Partial<CompletionResult>): CompletionResult => ({
  text: "",
  reasoning: "",
  toolCalls: [],
  annotations: [],
  finishReason: "stop",
  usage: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
  costUsd: 0,
  ...over,
});

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const signal = () => new AbortController().signal;

describe("sonarSearchProvider", () => {
  it("asks the search model with no plugin and reads its citations", async () => {
    const requests: Parameters<Complete>[0][] = [];
    const complete: Complete = async (request) => {
      requests.push(request);
      return completion({
        text: "Next 15 shipped in October.",
        annotations: [
          { type: "url_citation", url_citation: { url: "https://nextjs.org/blog/next-15", title: "Next.js 15" } },
          { type: "url_citation", url_citation: { url: "https://github.com/vercel/next.js/releases" } },
          { type: "other" },
        ],
      });
    };

    const result = await sonarSearchProvider({
      apiKey: "key",
      model: "perplexity/sonar",
      complete,
    }).search({ query: "next 15 release", maxResults: null, signal: signal() });

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ apiKey: "key", model: "perplexity/sonar" });
    // Sonar searches on its own; the OpenRouter web plugin would be a second search.
    expect(requests[0]!.plugins).toBeUndefined();
    expect(requests[0]!.tools).toBeUndefined();
    expect(result).toEqual({
      answer: "Next 15 shipped in October.",
      sources: [
        { url: "https://nextjs.org/blog/next-15", title: "Next.js 15" },
        { url: "https://github.com/vercel/next.js/releases" },
      ],
      truncated: false,
      omitted: 0,
    });
  });

  it("caps the sources and says how many it dropped", async () => {
    const complete: Complete = async () =>
      completion({
        annotations: [1, 2, 3, 4].map((n) => ({
          type: "url_citation",
          url_citation: { url: `https://example.com/${n}` },
        })),
      });
    const result = await sonarSearchProvider({ apiKey: "k", model: "m", complete }).search({
      query: "x",
      maxResults: 2,
      signal: signal(),
    });
    expect(result.sources.map((s) => s.url)).toEqual([
      "https://example.com/1",
      "https://example.com/2",
    ]);
    expect(result).toMatchObject({ truncated: true, omitted: 2 });
  });
});

describe("bindResearch", () => {
  it("binds search to the key and passes the backends through as they are", async () => {
    const reader = { read: vi.fn() };
    const browser = { browse: vi.fn() };
    const complete: Complete = async (request) =>
      completion({ text: `searched with ${request.apiKey} on ${request.model}` });

    const bound = bindResearch(
      { searchModel: "perplexity/sonar-pro", reader, browser },
      { apiKey: "turn-key", complete },
    );
    const result = await bound.search({ query: "q", maxResults: null, signal: signal() });
    expect(result.answer).toBe("searched with turn-key on perplexity/sonar-pro");
    expect(bound.reader).toBe(reader);
    expect(bound.browser).toBe(browser);

    const bare = bindResearch({ searchModel: "m" }, { apiKey: "k", complete });
    expect(bare).not.toHaveProperty("reader");
    expect(bare).not.toHaveProperty("browser");
  });
});

describe("crawl4aiReader", () => {
  const crawl = (results: unknown[], status = 200) =>
    vi.fn(async (_url: string, _init?: RequestInit) => json({ success: true, results }, status));

  it("posts the URL to /crawl with the cache bypassed and returns the markdown", async () => {
    const fetch = crawl([
      {
        url: "https://example.com/docs/",
        success: true,
        status_code: 200,
        markdown: { raw_markdown: "# Docs\n\nnav nav nav\n\nThe content.", fit_markdown: "# Docs\n\nThe content." },
        metadata: { title: "Docs" },
      },
    ]);
    const reader = crawl4aiReader({
      baseUrl: "http://crawler:11235/",
      apiToken: "secret",
      fetch: fetch as unknown as typeof globalThis.fetch,
    });

    const outcome = await reader.read({ url: "https://example.com/docs", signal: signal() });

    expect(fetch).toHaveBeenCalledTimes(1);
    const [endpoint, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(endpoint).toBe("http://crawler:11235/crawl");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer secret");
    expect(JSON.parse(init.body as string)).toEqual({
      urls: ["https://example.com/docs"],
      crawler_config: { type: "CrawlerRunConfig", params: { cache_mode: "bypass" } },
    });
    // The fitted markdown over the raw one: the page without its chrome.
    expect(outcome).toEqual({
      ok: true,
      url: "https://example.com/docs/",
      title: "Docs",
      text: "# Docs\n\nThe content.",
      statusCode: 200,
    });
  });

  it("keeps a path prefix on the base URL", async () => {
    const fetch = crawl([{ success: true, markdown: "hi", status_code: 200 }]);
    await crawl4aiReader({
      baseUrl: "http://gateway/crawl4ai",
      fetch: fetch as unknown as typeof globalThis.fetch,
    }).read({ url: "https://example.com", signal: signal() });
    expect(fetch.mock.calls[0]![0]).toBe("http://gateway/crawl4ai/crawl");
  });

  it("accepts a plain-string markdown from an older server", async () => {
    const fetch = crawl([{ success: true, markdown: "plain", status_code: 200 }]);
    const outcome = await crawl4aiReader({
      baseUrl: "http://c",
      fetch: fetch as unknown as typeof globalThis.fetch,
    }).read({ url: "https://example.com", signal: signal() });
    expect(outcome).toMatchObject({ ok: true, text: "plain" });
  });

  it("reports a 403 as gated, which is the escalation signal", async () => {
    const fetch = crawl([
      { success: false, status_code: 403, error_message: "403 Forbidden", markdown: "" },
    ]);
    const outcome = await crawl4aiReader({
      baseUrl: "http://c",
      fetch: fetch as unknown as typeof globalThis.fetch,
    }).read({ url: "https://example.com", signal: signal() });
    expect(outcome).toEqual({ ok: false, gated: true, reason: "403 Forbidden", statusCode: 403 });
  });

  it("reports a bot check that answered 200 as gated", async () => {
    const fetch = crawl([
      {
        success: true,
        status_code: 200,
        markdown: "Just a moment...\n\nChecking your browser before accessing example.com.",
      },
    ]);
    const outcome = await crawl4aiReader({
      baseUrl: "http://c",
      fetch: fetch as unknown as typeof globalThis.fetch,
    }).read({ url: "https://example.com", signal: signal() });
    expect(outcome).toMatchObject({ ok: false, gated: true });
  });

  it("reports a timeout or a missing page as not gated", async () => {
    const fetch = crawl([
      { success: false, status_code: 404, error_message: "404 Not Found", markdown: "" },
    ]);
    const outcome = await crawl4aiReader({
      baseUrl: "http://c",
      fetch: fetch as unknown as typeof globalThis.fetch,
    }).read({ url: "https://example.com/gone", signal: signal() });
    expect(outcome).toEqual({ ok: false, gated: false, reason: "404 Not Found", statusCode: 404 });
  });

  it("names the crawler when it is not there, rather than the page", async () => {
    const fetch = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    const outcome = await crawl4aiReader({
      baseUrl: "http://127.0.0.1:11235",
      fetch: fetch as unknown as typeof globalThis.fetch,
    }).read({ url: "https://example.com", signal: signal() });
    expect(outcome).toMatchObject({ ok: false, gated: false });
    expect((outcome as { reason: string }).reason).toMatch(/not reachable at http:\/\/127\.0\.0\.1:11235/);
  });
});

describe("looksGated", () => {
  it("treats the refusal statuses as gates whatever the body says", () => {
    for (const status of [401, 403, 407, 429]) expect(looksGated(status, "a real page")).toBe(true);
  });

  it("treats a short page with a wall's phrasing as a gate", () => {
    expect(looksGated(200, "Please verify you are human to continue.")).toBe(true);
    expect(looksGated(200, "Sign in to continue reading this article.")).toBe(true);
    expect(looksGated(503, "Attention Required! Cloudflare")).toBe(true);
  });

  it("does not treat a long page mentioning captchas as a gate", () => {
    const article = "How CAPTCHA works. ".repeat(200);
    expect(looksGated(200, article)).toBe(false);
  });

  it("does not treat a short ordinary page as a gate", () => {
    expect(looksGated(200, "# Hello\n\nA tiny page.")).toBe(false);
    expect(looksGated(null, "")).toBe(false);
  });
});

describe("browserUseAgent", () => {
  it("creates a task, polls it to completion, and returns the output", async () => {
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    let polls = 0;
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (init?.method === "POST") return json({ id: "task-1" });
      polls++;
      return json(
        polls < 2
          ? { status: "started", output: null }
          : { status: "finished", output: "Five releases: ...", liveUrl: "https://live/1" },
      );
    });

    const result = await browserUseAgent({
      apiKey: "bu-key",
      fetch: fetch as unknown as typeof globalThis.fetch,
      pollMs: 1,
    }).browse({
      url: "https://github.com/vercel/next.js",
      task: "open Releases and list the last five",
      signal: signal(),
    });

    expect(result).toEqual({ output: "Five releases: ...", liveUrl: "https://live/1" });

    const created = calls[0]!;
    expect(created.url).toBe("https://api.browser-use.com/api/v2/tasks");
    expect((created.init!.headers as Record<string, string>)["x-browser-use-api-key"]).toBe("bu-key");
    const body = JSON.parse(created.init!.body as string) as Record<string, unknown>;
    expect(body.startUrl).toBe("https://github.com/vercel/next.js");
    expect(body.task).toContain("open Releases and list the last five");
    expect(calls.slice(1).every((c) => c.url === "https://api.browser-use.com/api/v2/tasks/task-1")).toBe(true);
  });

  it("uses the configured base URL", async () => {
    const fetch = vi.fn(async (_url: string, init?: RequestInit) =>
      init?.method === "POST" ? json({ id: "t" }) : json({ status: "finished", output: "done" }),
    );
    await browserUseAgent({
      apiKey: "k",
      baseUrl: "http://browser.internal/",
      fetch: fetch as unknown as typeof globalThis.fetch,
      pollMs: 1,
    }).browse({ url: "https://example.com", task: "read it", signal: signal() });
    expect(fetch.mock.calls[0]![0]).toBe("http://browser.internal/api/v2/tasks");
  });

  it("stops the task and fails when the turn is cancelled", async () => {
    const controller = new AbortController();
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (init?.method === "POST") return json({ id: "t" });
      if (init?.method === "PATCH") return json({});
      // Still running; the caller gives up before it finishes.
      controller.abort();
      return json({ status: "started", output: null });
    });

    await expect(
      browserUseAgent({
        apiKey: "k",
        fetch: fetch as unknown as typeof globalThis.fetch,
        pollMs: 1,
      }).browse({ url: "https://example.com", task: "t", signal: controller.signal }),
    ).rejects.toThrow(/cancelled/);

    const stop = calls.find((c) => c.init?.method === "PATCH");
    expect(stop?.url).toBe("https://api.browser-use.com/api/v2/tasks/t");
    expect(JSON.parse(stop!.init!.body as string)).toEqual({ action: "stop" });
  });

  it("fails plainly when the task is refused or finishes with nothing", async () => {
    const refused = vi.fn(async () => new Response("no credits", { status: 402 }));
    await expect(
      browserUseAgent({ apiKey: "k", fetch: refused as unknown as typeof globalThis.fetch, pollMs: 1 }).browse({
        url: "https://example.com",
        task: "t",
        signal: signal(),
      }),
    ).rejects.toThrow(/refused the task: 402 no credits/);

    const empty = vi.fn(async (_url: string, init?: RequestInit) =>
      init?.method === "POST" ? json({ id: "t" }) : json({ status: "stopped", output: "" }),
    );
    await expect(
      browserUseAgent({ apiKey: "k", fetch: empty as unknown as typeof globalThis.fetch, pollMs: 1 }).browse({
        url: "https://example.com",
        task: "t",
        signal: signal(),
      }),
    ).rejects.toThrow(/stopped without reporting anything/);
  });
});
