import { z } from "zod/v4";
import type { BrowseResult, ResearchProvider } from "../research.js";
import { defineTool, type ToolContext, type ToolResult } from "../tool.js";
import { clamp, describe } from "./format.js";
import { refuseUnsafe } from "./web.js";

/**
 * The research pipeline, as three tools.
 *
 * Offered only on the `research` preset, where they replace `web_search` and
 * `web_fetch`. The order the prompt asks for -- search, read, then browse --
 * is also built into `research_read`: a page the crawler cannot get past is
 * handed to the browser agent from inside the same call, so the common case
 * of a gated page costs the model one tool call rather than a failed one and
 * a retry.
 */

/** A browser run is a model driving a page; minutes, not seconds. */
const BROWSE_TOOL_TIMEOUT_MS = 6 * 60_000;

export const researchSearch = defineTool({
  name: "research_search",
  description:
    "Search the live web with Perplexity Sonar. Returns a sourced answer and the URLs it " +
    "drew on, each with a line on what it contains. The first step of any research: run " +
    "several focused queries rather than one broad one, then read the pages that matter " +
    "with research_read.",
  permission: "read",
  inputSchema: z.strictObject({
    query: z.string().min(1).describe("What to find out, as a specific question"),
    max_results: z
      .number()
      .int()
      .min(1)
      .max(20)
      .nullable()
      .describe("How many sources to list. Null uses the default of ten."),
  }),
  async run(input, ctx): Promise<ToolResult> {
    const research = configured(ctx);
    if ("error" in research) return research.error;

    let result;
    try {
      result = await research.value.search({
        query: input.query,
        maxResults: input.max_results,
        signal: ctx.signal,
      });
    } catch (error) {
      return { content: `Search failed: ${describe(error)}`, isError: true };
    }

    const answer = result.answer?.trim() ?? "";
    if (answer === "" && result.sources.length === 0) {
      return { content: `No results for ${JSON.stringify(input.query)}.`, isError: true };
    }

    const sections = [answer || "(the search returned sources but no summary)"];
    if (result.sources.length > 0) {
      const listed = result.sources
        .map((source, i) => `[${i + 1}] ${source.title ?? source.url}\n    ${source.url}`)
        .join("\n");
      const more = result.truncated ? `\n(${result.omitted} further sources not listed)` : "";
      sections.push(`Sources:\n${listed}${more}`);
    }
    return { content: clamp(sections.join("\n\n")), display: { title: input.query } };
  },
});

export const researchRead = defineTool({
  name: "research_read",
  description:
    "Read a web page in full, as markdown, with the Crawl4AI crawler. Fast: call it on " +
    "several URLs at once. A page the crawler cannot get past -- a bot check, a login " +
    "wall, a 403 -- is handed to the browser agent automatically, and the result says " +
    "so. Do not state anything as fact from a search summary alone; read the page.",
  permission: "read",
  timeoutMs: BROWSE_TOOL_TIMEOUT_MS,
  inputSchema: z.strictObject({
    url: z.string().describe("Absolute http or https URL"),
    escalate: z
      .boolean()
      .nullable()
      .describe(
        "True skips the crawler and sends the page straight to the browser agent, for a " +
          "page you already know needs one. Null tries the crawler first.",
      ),
  }),
  async run(input, ctx): Promise<ToolResult> {
    const research = configured(ctx);
    if ("error" in research) return research.error;

    const target = parseUrl(input.url);
    if ("error" in target) return target.error;
    const refusal = await refuseUnsafe(target.value);
    if (refusal) return { content: refusal, isError: true };
    const url = target.value.href;

    const { reader, browser } = research.value;

    if (input.escalate) {
      if (!browser) return { content: NO_BROWSER, isError: true };
      return browse(browser, url, READ_TASK, ctx, "Sent straight to the browser agent, as asked.");
    }

    if (!reader) {
      return {
        content:
          "The Crawl4AI reader is not configured on this server (CRAWL4AI_URL). " +
          (browser
            ? "Call research_read again with escalate: true to use the browser agent instead."
            : "Ask the operator to set it up."),
        isError: true,
      };
    }

    let outcome;
    try {
      outcome = await reader.read({ url, signal: ctx.signal });
    } catch (error) {
      return { content: `Could not read ${url}: ${describe(error)}`, isError: true };
    }

    if (outcome.ok) {
      const head = outcome.title ? `${outcome.url}\n# ${outcome.title}` : outcome.url;
      return {
        content: clamp(`${head}\n\n${outcome.text}`),
        display: { title: target.value.hostname },
      };
    }

    if (outcome.gated && browser) {
      return browse(
        browser,
        url,
        READ_TASK,
        ctx,
        `The crawler could not read this page (${outcome.reason}), so it was escalated ` +
          `to the browser agent.`,
      );
    }

    if (outcome.gated) {
      return {
        content:
          `Could not read ${url}: ${outcome.reason}. The page looks gated, and no browser ` +
          `agent is configured to get past it (BROWSER_USE_API_KEY). Try another source.`,
        isError: true,
      };
    }

    return { content: `Could not read ${url}: ${outcome.reason}.`, isError: true };
  },
});

export const researchBrowse = defineTool({
  name: "research_browse",
  description:
    "Send a browser agent to a page to do something the crawler cannot: click through " +
    "an interactive app, page through results, fill a search form, expand collapsed " +
    "sections. Slow and expensive -- minutes, not seconds -- so use research_read for " +
    "anything that is just a page, and describe the task precisely.",
  permission: "read",
  timeoutMs: BROWSE_TOOL_TIMEOUT_MS,
  inputSchema: z.strictObject({
    url: z.string().describe("Where to start: an absolute http or https URL"),
    task: z
      .string()
      .min(1)
      .describe(
        "What to do there and what to bring back, in plain language, e.g. 'open the " +
          "Releases tab, list the last five versions with their dates'",
      ),
  }),
  async run(input, ctx): Promise<ToolResult> {
    const research = configured(ctx);
    if ("error" in research) return research.error;
    if (!research.value.browser) return { content: NO_BROWSER, isError: true };

    const target = parseUrl(input.url);
    if ("error" in target) return target.error;
    const refusal = await refuseUnsafe(target.value);
    if (refusal) return { content: refusal, isError: true };

    return browse(research.value.browser, target.value.href, input.task, ctx, null);
  },
});

/** What the browser agent is asked to do when it stands in for the crawler. */
const READ_TASK =
  "Read the page. If a cookie banner or an interstitial is in the way, dismiss it. " +
  "Return the page's main content in full as text, with its title and the final URL.";

const NO_BROWSER =
  "The browser agent is not configured on this server (BROWSER_USE_API_KEY), so there " +
  "is nothing to escalate to. Try another source for this information.";

async function browse(
  browser: NonNullable<ResearchProvider["browser"]>,
  url: string,
  task: string,
  ctx: ToolContext,
  note: string | null,
): Promise<ToolResult> {
  let result: BrowseResult;
  try {
    result = await browser.browse({ url, task, signal: ctx.signal });
  } catch (error) {
    return { content: `The browser agent failed on ${url}: ${describe(error)}`, isError: true };
  }

  const sections = [
    ...(note ? [note] : []),
    `${url}${result.liveUrl ? `\n(run: ${result.liveUrl})` : ""}`,
    result.output,
  ];
  return {
    content: clamp(sections.join("\n\n")),
    display: { title: new URL(url).hostname },
  };
}

function configured(ctx: ToolContext): { value: ResearchProvider } | { error: ToolResult } {
  // Depth for the same reason `web_search` checks it: a sub-call carries no
  // tools, so this cannot recurse, and saying so keeps it that way.
  if (ctx.depth > 0) {
    return {
      error: {
        content: "Research tools cannot be called from inside another tool call.",
        isError: true,
      },
    };
  }
  if (!ctx.research) {
    return {
      error: {
        content: "Research is not available on this turn: it was not started in research mode.",
        isError: true,
      },
    };
  }
  return { value: ctx.research };
}

function parseUrl(raw: string): { value: URL } | { error: ToolResult } {
  try {
    return { value: new URL(raw) };
  } catch {
    return { error: { content: `${JSON.stringify(raw)} is not a valid URL.`, isError: true } };
  }
}
