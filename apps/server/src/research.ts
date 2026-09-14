import { browserUseAgent, crawl4aiReader, type ResearchBackends } from "@ucch/agent";
import type { Config } from "./config.js";

/**
 * The research pipeline's backends, from configuration.
 *
 * Decided once at boot rather than per turn, so a misconfigured URL fails
 * here in the log rather than as a tool error in somebody's conversation.
 * Both backends are optional and each is absent rather than broken when
 * unset: the tools tell the model what is missing, and a research turn
 * with search alone is still a research turn.
 */
export function researchBackends(config: Config): ResearchBackends {
  const crawlerUrl = config.CRAWL4AI_URL?.trim();
  const browserKey = config.BROWSER_USE_API_KEY?.trim();

  return {
    searchModel: config.RESEARCH_SEARCH_MODEL,
    ...(crawlerUrl
      ? {
          reader: crawl4aiReader({
            baseUrl: crawlerUrl,
            ...(config.CRAWL4AI_API_TOKEN ? { apiToken: config.CRAWL4AI_API_TOKEN } : {}),
          }),
        }
      : {}),
    ...(browserKey
      ? {
          browser: browserUseAgent({
            apiKey: browserKey,
            ...(config.BROWSER_USE_API_URL ? { baseUrl: config.BROWSER_USE_API_URL } : {}),
          }),
        }
      : {}),
  };
}

/**
 * What the research phase of a CLI provider's turn is asked.
 *
 * One synthesised message rather than the thread's history: the CLI's own
 * session holds the conversation, and its events are not in a shape the
 * native loop can replay. The earlier asks travel as text so a follow-up
 * ("and what about the App Router?") still has something to be a follow-up
 * to, and the framing tells the researcher who reads its answer -- a coding
 * agent, not the person -- so it writes a brief rather than a reply.
 */
export function researchAsk(text: string, earlierAsks: readonly string[]): string {
  const context =
    earlierAsks.length > 0
      ? `Earlier in this conversation the developer asked:\n${earlierAsks
          .map((ask) => `- ${ask.trim().replace(/\s+/g, " ")}`)
          .join("\n")}\n\nNow they ask:\n\n`
      : "";
  return (
    `${context}${text.trim()}\n\n` +
    "Research this for the coding agent that will act on it next. Do not write code and " +
    "do not change any files: your answer is a brief the agent will read as source material. " +
    "Lead with the findings that decide what it should do; quote the exact names, versions, " +
    "signatures and snippets it will need, verbatim from the pages you read; cite the URL " +
    "beside each; and keep what the sources confirm separate from what you inferred."
  );
}

/**
 * The prompt the CLI is given: the person's message, then the brief.
 *
 * The message first and untouched, so the CLI answers what was asked and
 * not what was found. The brief is labelled with where it came from, and
 * with the one instruction that keeps it honest -- it is source material,
 * to be checked against the repository, not a plan already approved.
 */
export function briefedPrompt(text: string, brief: string, model: string): string {
  return (
    `${text.trim()}\n\n---\n\n` +
    `Research brief, gathered just now by ${model} via OpenRouter (Perplexity Sonar to ` +
    `search; pages read with Crawl4AI, or a browser agent where the crawler was blocked). ` +
    `Treat it as source material: verify it against this repository before acting on it, ` +
    `and keep its citations in anything you write.\n\n${brief.trim()}`
  );
}

/** What a research phase that produced nothing is turned into. */
export const EMPTY_BRIEF =
  "(the research phase finished without writing a brief; proceed from your own knowledge " +
  "and say so)";
