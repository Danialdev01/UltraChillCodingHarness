import type { Annotation, Complete } from "./completion.js";

/**
 * How this harness reaches the web.
 *
 * One seam with one implementation today, which is worth the indirection for
 * two reasons. The model-facing half -- the `web_search` name, its
 * description, its JSON schema -- sits in the cached tool block, so changing
 * the backend must not be able to change any of those bytes; and the backend
 * is the part most likely to change, because "the same model, asked again,
 * with search switched on" is the cheapest thing to build and nowhere near
 * the best thing to run.
 *
 * Swapping the provider therefore changes what a search costs and how good it
 * is, and changes nothing about how the model asks for one.
 */

export interface WebSource {
  url: string;
  title?: string;
}

export interface WebSearchResult {
  /** A provider that synthesises one. Absent where the provider only ranks. */
  answer?: string;
  sources: WebSource[];
  /** True when sources were dropped to stay inside `maxResults`. */
  truncated: boolean;
  /** How many were dropped. Exact, so the model is not left guessing. */
  omitted: number;
}

export interface WebSearchRequest {
  query: string;
  maxResults: number | null;
  signal: AbortSignal;
}

export interface WebProvider {
  search(request: WebSearchRequest): Promise<WebSearchResult>;
}

/**
 * The default backend: the same provider, asked again with search switched on.
 *
 * The model it asks is deliberately **not** the turn's model. This is a
 * summariser reading search results, which is among the easiest things a
 * language model does, and billing it at the coding model's rate made every
 * search cost about as much as a turn of real work. The caller passes
 * whatever `SEARCH_MODEL` names.
 */
export function openrouterPluginProvider(options: {
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
                "Answer the question from web sources. Be brief and factual, and state " +
                "what you could not confirm rather than filling it in.",
            },
            { role: "user", content: request.query },
          ],
          // The provider runs the search and returns the citations as
          // annotations. No second key, and the agent pays for search only
          // when it asks for one.
          plugins: [
            { id: "web", ...(request.maxResults ? { max_results: request.maxResults } : {}) },
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

/** Sources listed when the call did not say how many it wanted. */
export const DEFAULT_MAX_SOURCES = 10;

/**
 * The citations a completion carried, as sources.
 *
 * Shared with the research seam: Perplexity's models come back through the
 * same annotation shape as the web plugin, so one reading of it serves both.
 */
export function citedSources(annotations: readonly Annotation[]): WebSource[] {
  return annotations
    .filter((annotation) => annotation.type === "url_citation" && annotation.url_citation)
    .map((annotation) => ({
      url: annotation.url_citation!.url,
      ...(annotation.url_citation!.title ? { title: annotation.url_citation!.title } : {}),
    }));
}

/**
 * A head window with an exact count of what it left out.
 *
 * Exact, not "and more": a model told that six sources were dropped can
 * decide to search again more narrowly, and one told "some" cannot.
 */
export function retain(
  sources: readonly WebSource[],
  limit: number,
): { sources: WebSource[]; truncated: boolean; omitted: number } {
  if (sources.length <= limit) {
    return { sources: [...sources], truncated: false, omitted: 0 };
  }
  return {
    sources: sources.slice(0, limit),
    truncated: true,
    omitted: sources.length - limit,
  };
}
