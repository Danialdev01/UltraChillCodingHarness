import { describe, expect, it } from "vitest";
import { withResearchUsage } from "./agent.js";
import { loadConfig } from "./config.js";
import { briefedPrompt, EMPTY_BRIEF, researchAsk, researchBackends } from "./research.js";

const base = {
  DATABASE_URL: "postgres://u:p@localhost:5432/db",
  DEV_AUTH_BYPASS: "true",
};

describe("researchBackends", () => {
  it("builds only what is configured", () => {
    const bare = researchBackends(loadConfig({ ...base }));
    expect(bare.searchModel).toBe("perplexity/sonar");
    expect(bare).not.toHaveProperty("reader");
    expect(bare).not.toHaveProperty("browser");

    const full = researchBackends(
      loadConfig({
        ...base,
        RESEARCH_SEARCH_MODEL: "perplexity/sonar-pro",
        CRAWL4AI_URL: "http://127.0.0.1:11235",
        BROWSER_USE_API_KEY: "bu",
      }),
    );
    expect(full.searchModel).toBe("perplexity/sonar-pro");
    expect(full.reader).toBeDefined();
    expect(full.browser).toBeDefined();
  });

  it("treats a blank URL or key as absent", () => {
    const blank = researchBackends(
      loadConfig({ ...base, CRAWL4AI_URL: "  ", BROWSER_USE_API_KEY: "" }),
    );
    expect(blank).not.toHaveProperty("reader");
    expect(blank).not.toHaveProperty("browser");
  });
});

describe("researchAsk", () => {
  it("frames the message as a brief for an agent, with no earlier context", () => {
    const ask = researchAsk("  what changed in next 15?  ", []);
    expect(ask.startsWith("what changed in next 15?\n\n")).toBe(true);
    expect(ask).not.toContain("Earlier in this conversation");
    expect(ask).toMatch(/Do not write code/);
  });

  it("carries the earlier asks as a list, one line each", () => {
    const ask = researchAsk("and the app router?", ["what changed\nin next 15?", "  is turbopack stable? "]);
    expect(ask).toContain(
      "Earlier in this conversation the developer asked:\n- what changed in next 15?\n- is turbopack stable?\n\nNow they ask:\n\nand the app router?",
    );
  });
});

describe("briefedPrompt", () => {
  it("puts the message first and the labelled brief after a rule", () => {
    const prompt = briefedPrompt("add the new API\n", "## Findings\n\n- x [1](https://a)\n", "anthropic/claude-sonnet-4.5");
    expect(prompt.startsWith("add the new API\n\n---\n\nResearch brief, gathered just now by anthropic/claude-sonnet-4.5 via OpenRouter")).toBe(true);
    expect(prompt.endsWith("## Findings\n\n- x [1](https://a)")).toBe(true);
    expect(prompt).toMatch(/verify it against this repository/);
  });

  it("has something to say when the research produced nothing", () => {
    expect(briefedPrompt("q", EMPTY_BRIEF, "m")).toContain("finished without writing a brief");
  });
});

describe("withResearchUsage", () => {
  it("adds the phase's tokens and cost to the CLI's completion, and changes nothing else", () => {
    const event = {
      type: "agent.turn_completed" as const,
      threadId: "44444444-4444-4444-4444-444444444444",
      turnId: "55555555-5555-5555-5555-555555555555",
      stopReason: "end_turn",
      usage: { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 2, cacheCreationInputTokens: 1 },
      costUsd: 0.01,
    };
    const merged = withResearchUsage(event, {
      usage: { inputTokens: 100, outputTokens: 50, cacheReadInputTokens: 20, cacheCreationInputTokens: 10 },
      costUsd: 0.2,
    });
    expect(merged).toMatchObject({
      ...event,
      usage: { inputTokens: 110, outputTokens: 55, cacheReadInputTokens: 22, cacheCreationInputTokens: 11 },
      costUsd: expect.closeTo(0.21, 10),
    });
    // The original is not touched: it is the provider's event.
    expect(event.usage.inputTokens).toBe(10);
  });
});
