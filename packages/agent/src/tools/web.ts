import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { z } from "zod/v4";
import { defineTool, type ToolResult } from "../tool.js";
import { clamp, describe } from "./format.js";

/** Bytes read from a fetched page before the rest is dropped. */
const MAX_FETCH_BYTES = 2 * 1024 * 1024;

/** Redirects followed. Each hop is revalidated; three is plenty for a page. */
const MAX_REDIRECTS = 3;

const FETCH_TIMEOUT_MS = 20_000;

export const webSearch = defineTool({
  name: "web_search",
  description:
    "Search the web and return an answer with source citations. Use this for anything " +
    "current, or for documentation you do not already know.",
  permission: "read",
  inputSchema: z.strictObject({
    query: z.string().min(1).describe("What to search for, in plain language"),
    max_results: z
      .number()
      .int()
      .min(1)
      .max(10)
      .nullable()
      .describe("How many sources to consult. Null uses the provider default."),
  }),
  async run(input, ctx): Promise<ToolResult> {
    // The sub-call carries no tools, and this refuses to make one from
    // inside another, so a search can never recurse into itself.
    if (ctx.depth > 0) {
      return { content: "web_search cannot be called from inside another tool call.", isError: true };
    }

    let result;
    try {
      result = await ctx.web.search({
        query: input.query,
        maxResults: input.max_results,
        signal: ctx.signal,
      });
    } catch (error) {
      return { content: `Search failed: ${describe(error)}`, isError: true };
    }

    const summary = result.answer?.trim() ?? "";
    if (summary === "" && result.sources.length === 0) {
      return { content: `No results for ${JSON.stringify(input.query)}.`, isError: true };
    }

    const sections = [summary || "(the search returned sources but no summary)"];
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

export const webFetch = defineTool({
  name: "web_fetch",
  description:
    "Fetch a web page and return its text. Only http and https, and only addresses " +
    "outside private networks.",
  permission: "read",
  inputSchema: z.strictObject({
    url: z.string().describe("Absolute http or https URL"),
  }),
  async run(input, ctx): Promise<ToolResult> {
    // One signal for both reasons a fetch should stop: the turn was
    // cancelled, or the page is simply not answering.
    const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)]);

    let target: URL;
    try {
      target = new URL(input.url);
    } catch {
      return { content: `${JSON.stringify(input.url)} is not a valid URL.`, isError: true };
    }

    try {
      let response: Response | null = null;
      for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
        const refusal = await refuseUnsafe(target);
        if (refusal) return { content: refusal, isError: true };

        // Manual redirects, because following them automatically would let a
        // public URL hand back a Location pointing at 169.254.169.254 and
        // walk straight past the check above.
        const hopResponse = await fetch(target, {
          signal,
          redirect: "manual",
          headers: { accept: "text/html,text/plain,application/json;q=0.9", "user-agent": USER_AGENT },
        });

        const location = hopResponse.headers.get("location");
        if (hopResponse.status >= 300 && hopResponse.status < 400 && location) {
          await hopResponse.body?.cancel();
          target = new URL(location, target);
          continue;
        }
        response = hopResponse;
        break;
      }

      if (!response) {
        return { content: `Too many redirects starting from ${input.url}.`, isError: true };
      }
      if (!response.ok) {
        await response.body?.cancel();
        return {
          content: `${target.href} returned ${response.status} ${response.statusText}.`,
          isError: true,
        };
      }

      const contentType = response.headers.get("content-type") ?? "";
      if (!isTextual(contentType)) {
        await response.body?.cancel();
        return {
          content: `${target.href} is ${contentType || "an unknown type"}, which is not text.`,
          isError: true,
        };
      }

      const body = await readCapped(response, MAX_FETCH_BYTES);
      const text = contentType.includes("html") ? htmlToText(body) : body.trim();
      if (text === "") {
        return { content: `${target.href} returned an empty document.`, isError: true };
      }

      return {
        content: clamp(`${target.href}\n\n${text}`),
        display: { title: target.hostname },
      };
    } catch (error) {
      return { content: `Could not fetch ${input.url}: ${describe(error)}`, isError: true };
    }
  },
});

const USER_AGENT = "UCCH-agent/0.1 (+https://github.com/ucch)";

/**
 * Refuses anything that could turn this tool into a probe of the harness's
 * own network.
 *
 * The scheme check rules out `file:`, `gopher:` and the rest. The address
 * check is the one that matters: a public hostname is free to resolve to
 * 127.0.0.1, so the name is not evidence and every resolved address has to
 * be looked at. A rebind between this check and the fetch remains possible,
 * which is why the container is still the real boundary.
 */
export async function refuseUnsafe(url: URL): Promise<string | null> {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return `${url.protocol} is not allowed; web_fetch supports http and https only.`;
  }

  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host)) {
    return isBlocked(host) ? `${host} is a private or loopback address.` : null;
  }

  let addresses: { address: string }[];
  try {
    addresses = await lookup(host, { all: true });
  } catch (error) {
    return `Could not resolve ${host}: ${describe(error)}`;
  }
  if (addresses.length === 0) return `${host} did not resolve to any address.`;

  // Every address, not the first: a name that resolves to one public and one
  // loopback address is exactly the trick this is here to stop.
  for (const { address } of addresses) {
    if (isBlocked(address)) return `${host} resolves to ${address}, a private or loopback address.`;
  }
  return null;
}

/** Loopback, link-local, private, carrier-grade NAT, multicast and reserved. */
export function isBlocked(address: string): boolean {
  const version = isIP(address);
  if (version === 4) return isBlockedV4(address);
  if (version === 6) return isBlockedV6(address.toLowerCase());
  return true;
}

function isBlockedV4(address: string): boolean {
  const octets = address.split(".").map(Number);
  const [a = 0, b = 0] = octets;
  if (octets.length !== 4 || octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return true;
  }
  if (a === 0) return true; // "this network"
  if (a === 10) return true;
  if (a === 127) return true; // loopback
  if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
  if (a === 169 && b === 254) return true; // link-local, and the cloud metadata address
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 192 && b === 0) return true; // IETF protocol assignments
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a >= 224) return true; // multicast and reserved
  return false;
}

function isBlockedV6(address: string): boolean {
  if (address === "::" || address === "::1") return true;
  // An IPv4-mapped address is an IPv4 address wearing a hat.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(address);
  if (mapped?.[1]) return isBlockedV4(mapped[1]);
  if (/^f[cd]/.test(address)) return true; // unique local, fc00::/7
  if (/^fe[89ab]/.test(address)) return true; // link-local, fe80::/10
  if (/^ff/.test(address)) return true; // multicast
  return false;
}

function isTextual(contentType: string): boolean {
  const type = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  return (
    type === "" ||
    type.startsWith("text/") ||
    type === "application/json" ||
    type === "application/xml" ||
    type.endsWith("+json") ||
    type.endsWith("+xml")
  );
}

/** Reads at most `max` bytes, then stops rather than buffering a whole CDN. */
async function readCapped(response: Response, max: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      chunks.push(value);
      size += value.length;
      if (size >= max) break;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }

  return Buffer.concat(chunks).subarray(0, max).toString("utf8");
}

/**
 * HTML to something worth spending context on.
 *
 * Not a parser, and not trying to be: scripts and styles go, block elements
 * become line breaks, and everything else collapses to its text. A page's
 * navigation still comes through, which is the honest cost of not shipping a
 * DOM to do it properly.
 */
export function htmlToText(html: string): string {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.trim();

  const body = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    // `title` is in the list because it is extracted separately above, and
    // leaving it here too printed every page's title twice.
    .replace(/<(script|style|noscript|template|title)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|section|article|header|footer|li|tr|h[1-6]|blockquote|pre)\s*>/gi, "\n")
    .replace(/<[^>]+>/g, " ");

  const text = decodeEntities(body)
    .replace(/[ \t\r\f\v]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return title ? `${decodeEntities(title)}\n\n${text}` : text;
}

function decodeEntities(text: string): string {
  return text
    .replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity: string) => {
      if (entity.startsWith("#x") || entity.startsWith("#X")) {
        return codePoint(parseInt(entity.slice(2), 16)) ?? match;
      }
      if (entity.startsWith("#")) return codePoint(parseInt(entity.slice(1), 10)) ?? match;
      return NAMED[entity.toLowerCase()] ?? match;
    });
}

function codePoint(value: number): string | null {
  return Number.isFinite(value) && value > 0 && value <= 0x10ffff ? String.fromCodePoint(value) : null;
}

const NAMED: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  mdash: "—",
  ndash: "–",
  hellip: "…",
  rsquo: "’",
  lsquo: "‘",
  ldquo: "“",
  rdquo: "”",
};
