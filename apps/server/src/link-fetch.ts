import type { IncomingMessage } from "node:http";
import { BlockedAddressError, decodedBody, publicRequest } from "@ucch/agent";

/**
 * Fetches a link the person put in the chat, so it can be staged like any
 * other attachment and read by whichever model answers.
 *
 * The server fetches, never the model's own tools: not every harness has a
 * web tool, the ones that do differ in what they can read (a PDF behind a
 * link is text to this and nothing to most of them), and a page fetched once
 * here is the same page for every turn and every model that reads it.
 *
 * It is a request from inside the harness's network on someone else's
 * behalf, so it is held to the native `web_fetch` tool's rules and one more:
 * http and https only; every address a name resolves to must be public; each
 * redirect is checked again. And the address checked is the address dialled
 * -- the check runs inside the socket's own `lookup`, so a name cannot
 * resolve to a public address for the check and a private one for the
 * connection.
 */

export class LinkError extends Error {}

export interface FetchedLink {
  /** The address asked for. */
  url: string;
  /** Where it ended up after redirects. */
  finalUrl: string;
  /** A filename for the staged copy, with an extension that says what it is. */
  name: string;
  contentType: string;
  bytes: Buffer;
}

export interface FetchLinkOptions {
  maxBytes?: number;
  timeoutMs?: number;
  /** For tests: resolve names without DNS. */
  resolve?: (host: string) => Promise<string[]>;
  /** For tests: which addresses are refused. Defaults to every non-public one. */
  blocked?: (address: string) => boolean;
}

const MAX_REDIRECTS = 5;

/**
 * A browser-like user agent. Plenty of sites refuse an obvious bot outright;
 * this one still says what it is.
 */
const USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 UCCH-link-reader";

/** Shared with the composer, which offers each pasted link as an attachment. */
export { findLinks } from "@ucch/protocol/plain";

/**
 * The address worth fetching for a link: GitHub's rendered file view becomes
 * the raw file, which is what anyone pasting it means.
 */
export function rewriteLink(url: URL): URL {
  if (url.hostname === "github.com") {
    const blob = /^\/([^/]+)\/([^/]+)\/blob\/(.+)$/.exec(url.pathname);
    if (blob) return new URL(`https://raw.githubusercontent.com/${blob[1]}/${blob[2]}/${blob[3]}`);
  }
  return url;
}

export async function fetchLink(raw: string, options: FetchLinkOptions = {}): Promise<FetchedLink> {
  const maxBytes = options.maxBytes ?? 20 * 1024 * 1024;
  const deadline = AbortSignal.timeout(options.timeoutMs ?? 20_000);

  let target: URL;
  try {
    target = rewriteLink(new URL(raw.trim()));
  } catch {
    throw new LinkError("that is not a valid URL");
  }

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (target.protocol !== "http:" && target.protocol !== "https:") {
      throw new LinkError(`${target.protocol} links cannot be fetched; only http and https`);
    }
    if (target.username || target.password) throw new LinkError("links with credentials in them are not fetched");
    const response = await get(target, deadline, options);
    const status = response.statusCode ?? 0;
    const location = response.headers.location;
    if (status >= 300 && status < 400 && location) {
      response.resume();
      target = new URL(location, target);
      continue;
    }
    if (status < 200 || status >= 300) {
      response.resume();
      throw new LinkError(`${target.host} answered ${status}${response.statusMessage ? ` ${response.statusMessage}` : ""}`);
    }

    const declared = Number(response.headers["content-length"] ?? 0);
    if (declared > maxBytes) {
      response.resume();
      throw new LinkError(`the page is larger than ${Math.round(maxBytes / (1024 * 1024))} MB`);
    }
    const bytes = await readBody(response, maxBytes);
    const contentType = (response.headers["content-type"] ?? "application/octet-stream").split(";")[0]!.trim().toLowerCase();
    if (bytes.length === 0) throw new LinkError(`${target.host} returned an empty response`);
    return { url: raw, finalUrl: target.href, name: nameFor(target, contentType), contentType, bytes };
  }
  throw new LinkError("too many redirects");
}

async function get(url: URL, signal: AbortSignal, options: FetchLinkOptions): Promise<IncomingMessage> {
  try {
    return await publicRequest(url, {
      signal,
      resolve: options.resolve,
      blocked: options.blocked,
      headers: {
        "user-agent": USER_AGENT,
        accept: "text/html,application/xhtml+xml,application/pdf;q=0.9,text/plain;q=0.9,*/*;q=0.8",
        "accept-encoding": "gzip, deflate, br",
        "accept-language": "en;q=0.9,*;q=0.5",
      },
    });
  } catch (error) {
    if (error instanceof BlockedAddressError) throw new LinkError(error.message);
    if (signal.aborted) throw new LinkError(`${url.host} took too long to answer`);
    throw new LinkError(`could not reach ${url.host}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function readBody(response: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const stream = decodedBody(response);
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream as AsyncIterable<Buffer>) {
    total += chunk.length;
    if (total > maxBytes) {
      response.destroy();
      throw new LinkError(`the page is larger than ${Math.round(maxBytes / (1024 * 1024))} MB`);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

const EXTENSIONS: Record<string, string> = {
  "text/html": "html",
  "application/xhtml+xml": "html",
  "application/pdf": "pdf",
  "text/plain": "txt",
  "text/markdown": "md",
  "text/csv": "csv",
  "application/json": "json",
  "application/xml": "xml",
  "text/xml": "xml",
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
  "application/msword": "doc",
  "application/vnd.ms-excel": "xls",
  "application/vnd.ms-powerpoint": "ppt",
  "application/epub+zip": "epub",
};

/**
 * A filename for a fetched link: the URL's own file name when it has one
 * that agrees with what came back, else the host and path as a slug, with
 * the extension the content type implies.
 */
export function nameFor(url: URL, contentType: string): string {
  const ext = EXTENSIONS[contentType];
  const last = decodeURIComponent(url.pathname.split("/").filter(Boolean).pop() ?? "");
  const lastExt = /\.([a-z0-9]{1,8})$/i.exec(last)?.[1]?.toLowerCase();
  if (last && lastExt && (!ext || lastExt === ext || (ext === "html" && lastExt === "htm") || (ext === "txt" && contentType === "text/plain"))) {
    return last.slice(0, 120);
  }
  const slug = `${url.hostname.replace(/^www\./, "")}${url.pathname}`
    .replace(/\/+$/, "")
    .replace(/[^a-z0-9]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100);
  return `${slug || "link"}.${ext ?? lastExt ?? "bin"}`;
}
