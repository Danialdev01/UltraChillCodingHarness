import type { Complete } from "./completion.js";
import { citedSources, DEFAULT_MAX_SOURCES, retain, type WebProvider } from "./web.js";

/**
 * How a research turn reaches the web.
 *
 * Three backends in a fixed order of escalation, and the seam is here for
 * the same reason `web.ts` has one: the tools' names and schemas sit in the
 * cached prefix and must not move when a backend does.
 *
 *  1. **Search** is Perplexity Sonar through OpenRouter -- a model whose
 *     whole job is live retrieval, so one call returns an answer, the URLs
 *     it drew on, and a summary of each. It is billed to the person's own
 *     key like every other model call.
 *  2. **Read** is Crawl4AI: a headless-browser crawler that returns a page
 *     as markdown. The high-throughput path -- several pages at once, a few
 *     seconds each -- and the one every URL goes through first.
 *  3. **Browse** is a Browser Use agent: a model driving a real browser. For
 *     what the crawler cannot reach -- a login wall, a bot check, a page
 *     that is nothing until something is clicked. Slow and expensive, which
 *     is why it is the escalation and not the default.
 *
 * Search needs the turn's OpenRouter key and is built per call; the reader
 * and the browser agent are server-level and built once. `ResearchBackends`
 * is what the harness hands the loop; `ResearchProvider` is what the tools
 * see once the search has been bound to a key.
 */

export interface ReadRequest {
  url: string;
  signal: AbortSignal;
}

export type ReadOutcome =
  | {
      ok: true;
      /** The address the crawler ended up at, after redirects. */
      url: string;
      title?: string;
      /** Markdown, as the crawler produced it. */
      text: string;
      statusCode: number | null;
    }
  | {
      ok: false;
      /**
       * True when the page refused the crawler rather than failing outright:
       * a bot check, a login wall, a 403. That is the signal to escalate --
       * a page that timed out or does not exist is no better in a browser.
       */
      gated: boolean;
      reason: string;
      statusCode: number | null;
    };

export interface PageReader {
  read(request: ReadRequest): Promise<ReadOutcome>;
}

export interface BrowseRequest {
  url: string;
  /** What the agent should do once the page is open, in plain language. */
  task: string;
  signal: AbortSignal;
}

export interface BrowseResult {
  /** What the agent reported back, as text. */
  output: string;
  /** Somewhere a person can watch the run, when the backend offers one. */
  liveUrl?: string;
}

export interface BrowserAgent {
  browse(request: BrowseRequest): Promise<BrowseResult>;
}

/** What the harness configures: the search model, and the two optional backends. */
export interface ResearchBackends {
  /** The OpenRouter id of the search model. `perplexity/sonar` by default. */
  searchModel: string;
  reader?: PageReader;
  browser?: BrowserAgent;
}

/** What a research tool is given: search bound to a key, plus the backends. */
export interface ResearchProvider {
  search: WebProvider["search"];
  reader?: PageReader;
  browser?: BrowserAgent;
}

/** The search model when the harness names none. */
export const DEFAULT_RESEARCH_SEARCH_MODEL = "perplexity/sonar";

/**
 * Binds the backends to one turn's key.
 *
 * Search is the only piece that needs the key, because it is the only piece
 * that is a model call. The reader and the browser agent are passed through
 * as they are, absent where they were not configured.
 */
export function bindResearch(
  backends: ResearchBackends,
  options: { apiKey: string; complete: Complete },
): ResearchProvider {
  const search = sonarSearchProvider({
    apiKey: options.apiKey,
    model: backends.searchModel,
    complete: options.complete,
  });
  return {
    search: search.search,
    ...(backends.reader ? { reader: backends.reader } : {}),
    ...(backends.browser ? { browser: backends.browser } : {}),
  };
}

/**
 * Search as a Perplexity Sonar completion.
 *
 * No `web` plugin: Sonar searches on its own and returns what it read as
 * `url_citation` annotations, the same shape the plugin uses, so the result
 * is read the same way. The system prompt asks for the two things a
 * research turn wants from a search and a chat answer does not -- every URL
 * it drew on, and a line on what each one is for -- because the agent's
 * next step is to pick which of them to read in full.
 */
export function sonarSearchProvider(options: {
  apiKey: string;
  model: string;
  complete: Complete;
}): WebProvider {
  return {
    async search(request) {
      const completion = await options.complete(
        {
          apiKey: options.apiKey,
          model: options.model,
          messages: [
            {
              role: "system",
              content:
                "You are the search step of a research pipeline. Answer from live web " +
                "sources. Be factual and specific: include dates, version numbers and " +
                "names as the sources give them. After the answer, list every source you " +
                "used with its URL and one line on what it contains, so the reader can " +
                "decide which pages to open in full. Say what you could not confirm " +
                "rather than filling it in.",
            },
            { role: "user", content: request.query },
          ],
          signal: request.signal,
        },
        () => {},
      );

      return {
        ...(completion.text.trim() ? { answer: completion.text.trim() } : {}),
        ...retain(citedSources(completion.annotations), request.maxResults ?? DEFAULT_MAX_SOURCES),
      };
    },
  };
}

/** How long one crawl may take before it is given up on. */
const CRAWL_TIMEOUT_MS = 60_000;

/**
 * A reader over the Crawl4AI HTTP server (`unclecode/crawl4ai`'s Docker image).
 *
 * One `POST /crawl` per page, cache bypassed: a research turn is asking what
 * a page says now, and a crawler that answers from yesterday is the kind of
 * wrong that looks right. `fit_markdown` is preferred when the server
 * produced one -- it is the page with the chrome stripped -- and the raw
 * markdown is the fallback, never the HTML.
 */
export function crawl4aiReader(options: {
  /** The server's origin, e.g. `http://127.0.0.1:11235`. */
  baseUrl: string;
  /** Sent as a bearer token when the server was started with one. */
  apiToken?: string;
  fetch?: typeof fetch;
}): PageReader {
  const doFetch = options.fetch ?? fetch;
  // Relative, so a server mounted under a path prefix keeps it.
  const endpoint = new URL("crawl", options.baseUrl.replace(/\/?$/, "/")).href;

  return {
    async read(request) {
      const signal = AbortSignal.any([request.signal, AbortSignal.timeout(CRAWL_TIMEOUT_MS)]);
      let response: Response;
      try {
        response = await doFetch(endpoint, {
          method: "POST",
          signal,
          headers: {
            "content-type": "application/json",
            ...(options.apiToken ? { authorization: `Bearer ${options.apiToken}` } : {}),
          },
          body: JSON.stringify({
            urls: [request.url],
            crawler_config: { type: "CrawlerRunConfig", params: { cache_mode: "bypass" } },
          }),
        });
      } catch (error) {
        return failed(`the crawler is not reachable at ${options.baseUrl} (${message(error)})`);
      }

      if (!response.ok) {
        return failed(`the crawler returned ${response.status} ${response.statusText}`.trim());
      }

      let body: CrawlResponse;
      try {
        body = (await response.json()) as CrawlResponse;
      } catch (error) {
        return failed(`the crawler's reply was not JSON (${message(error)})`);
      }

      const result = body.results?.[0];
      if (!result) {
        return failed(body.error ?? body.detail ?? "the crawler returned no result for the page");
      }

      const statusCode = typeof result.status_code === "number" ? result.status_code : null;
      const text = markdownOf(result.markdown).trim();
      const title = result.metadata?.title?.trim();

      if (result.success === false || text === "") {
        const reason =
          result.error_message?.trim() ||
          (statusCode ? `the page returned ${statusCode}` : "the page came back empty");
        return {
          ok: false,
          gated: looksGated(statusCode, text || result.error_message || ""),
          reason,
          statusCode,
        };
      }

      // A page that answered 200 with a bot check is the crawler's most
      // common failure, and it does not report it as one.
      if (looksGated(statusCode, text)) {
        return {
          ok: false,
          gated: true,
          reason: statusCode && statusCode >= 400 ? `the page returned ${statusCode}` : "the page is a bot check or a login wall",
          statusCode,
        };
      }

      return {
        ok: true,
        url: result.url || request.url,
        ...(title ? { title } : {}),
        text,
        statusCode,
      };
    },
  };
}

const failed = (reason: string): ReadOutcome => ({ ok: false, gated: false, reason, statusCode: null });

/** The Crawl4AI server's reply, as much of it as this reads. */
interface CrawlResponse {
  success?: boolean;
  error?: string;
  detail?: string;
  results?: CrawlResult[];
}

interface CrawlResult {
  url?: string;
  success?: boolean;
  status_code?: number | null;
  error_message?: string | null;
  // A string on older servers; an object with the variants on newer ones.
  markdown?: string | { raw_markdown?: string; fit_markdown?: string } | null;
  metadata?: { title?: string | null } | null;
}

function markdownOf(markdown: CrawlResult["markdown"]): string {
  if (!markdown) return "";
  if (typeof markdown === "string") return markdown;
  return markdown.fit_markdown?.trim() || markdown.raw_markdown || "";
}

/** Below this many characters, a 200 is more likely a wall than a page. */
const GATED_TEXT_THRESHOLD = 400;

const GATE_MARKERS = [
  /verify (?:that )?you are (?:a )?human/i,
  /just a moment/i,
  /checking your browser/i,
  /enable javascript and cookies/i,
  /captcha/i,
  /access denied/i,
  /sign in to continue/i,
  /log in to (?:view|continue|see)/i,
  /please log in/i,
  /subscribe to (?:read|continue)/i,
  /are you a robot/i,
  /attention required/i,
  /cloudflare/i,
];

/**
 * Whether a page refused the crawler rather than failing.
 *
 * A status in the refusal range is one; so is a short body carrying the
 * phrases bot checks and login walls use. Short on its own is not evidence
 * -- a redirect stub or a tiny page is a page -- and neither is one of the
 * phrases on a long page, where "captcha" may simply be the topic.
 */
export function looksGated(statusCode: number | null, text: string): boolean {
  if (statusCode === 401 || statusCode === 403 || statusCode === 407 || statusCode === 429) {
    return true;
  }
  if (statusCode === 503 && GATE_MARKERS.some((marker) => marker.test(text))) return true;
  if (text.length > GATED_TEXT_THRESHOLD * 4) return false;
  return GATE_MARKERS.some((marker) => marker.test(text));
}

/** How long a browser run may take end to end. */
const BROWSE_TIMEOUT_MS = 5 * 60_000;

/** How often the run is asked whether it has finished. */
const BROWSE_POLL_MS = 3_000;

/** The most steps one run is allowed: a bound on cost more than on time. */
const BROWSE_MAX_STEPS = 40;

/**
 * The escalation agent, over the Browser Use cloud API (v2).
 *
 * A task is created, polled until it settles, and its output returned. The
 * base URL is configurable so a self-hosted server speaking the same API
 * can stand in for the cloud one. A cancelled turn stops the task rather
 * than abandoning it -- the run costs money for every step it takes after
 * nobody is listening.
 */
export function browserUseAgent(options: {
  /** `https://api.browser-use.com` by default. */
  baseUrl?: string;
  apiKey: string;
  fetch?: typeof fetch;
  /** For tests: how long to wait between polls. */
  pollMs?: number;
}): BrowserAgent {
  const doFetch = options.fetch ?? fetch;
  const base = (options.baseUrl ?? "https://api.browser-use.com").replace(/\/+$/, "");
  const headers = {
    "content-type": "application/json",
    "x-browser-use-api-key": options.apiKey,
  };
  const pollMs = options.pollMs ?? BROWSE_POLL_MS;

  return {
    async browse(request) {
      const signal = AbortSignal.any([request.signal, AbortSignal.timeout(BROWSE_TIMEOUT_MS)]);

      const created = await doFetch(`${base}/api/v2/tasks`, {
        method: "POST",
        signal,
        headers,
        body: JSON.stringify({
          task:
            `Open ${request.url} and do the following: ${request.task}\n\n` +
            "When you are done, report what you found as plain text: the relevant " +
            "content verbatim where it is short, summarised where it is long, and the " +
            "URL of every page you took it from. If you are blocked -- a login you have " +
            "no credentials for, a CAPTCHA you cannot pass -- say exactly where and stop.",
          startUrl: request.url,
          maxSteps: BROWSE_MAX_STEPS,
        }),
      });
      if (!created.ok) {
        throw new Error(
          `the browser agent refused the task: ${created.status} ${await bodyText(created)}`.trim(),
        );
      }
      const { id } = (await created.json()) as { id?: string };
      if (!id) throw new Error("the browser agent returned no task id");

      const stop = () =>
        doFetch(`${base}/api/v2/tasks/${id}`, {
          method: "PATCH",
          headers,
          body: JSON.stringify({ action: "stop" }),
        }).catch(() => {});

      for (;;) {
        if (signal.aborted) {
          await stop();
          throw new Error(
            request.signal.aborted
              ? "the browser run was cancelled"
              : `the browser run did not finish within ${BROWSE_TIMEOUT_MS / 1000}s`,
          );
        }
        await sleep(pollMs, signal);
        if (signal.aborted) continue;

        const polled = await doFetch(`${base}/api/v2/tasks/${id}`, { signal, headers });
        if (!polled.ok) {
          throw new Error(`the browser agent lost the task: ${polled.status} ${await bodyText(polled)}`.trim());
        }
        const task = (await polled.json()) as BrowserUseTask;
        if (task.status === "finished" || task.status === "stopped") {
          const output = (task.output ?? "").trim();
          if (output === "") {
            throw new Error(`the browser run ${task.status} without reporting anything`);
          }
          return { output, ...(task.liveUrl ? { liveUrl: task.liveUrl } : {}) };
        }
      }
    },
  };
}

interface BrowserUseTask {
  status?: "started" | "paused" | "finished" | "stopped" | string;
  output?: string | null;
  liveUrl?: string | null;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      signal.removeEventListener("abort", done);
      clearTimeout(timer);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

async function bodyText(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 300);
  } catch {
    return "";
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
