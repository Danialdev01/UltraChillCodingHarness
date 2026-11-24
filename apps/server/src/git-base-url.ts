import { lookup as dnsLookup } from "node:dns";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP, type LookupFunction } from "node:net";

/**
 * Where a connected git host lives, and the one way the harness calls it.
 *
 * GitLab and Gitea are self-hosted, so the address is the person's to type
 * and a token goes to it. Two rules follow. Plain http is accepted only for a
 * host whose every address is loopback or private, and that is checked inside
 * the socket's own lookup, so a name cannot answer one thing to the check and
 * another to the connection. And no redirect is followed: the token is for
 * the host that was named, not for wherever it points.
 */

export class BaseUrlError extends Error {}

type Resolve = (host: string) => Promise<string[]>;

const resolveDns: Resolve = (host) =>
  new Promise((done, fail) =>
    dnsLookup(host, { all: true }, (error, results) => (error ? fail(error) : done(results.map((r) => r.address)))),
  );

const bare = (hostname: string) => hostname.replace(/^\[|\]$/g, "");

/** `https://Host/path/` as `https://host/path`, or a reason it cannot be one. */
export function normalizeBaseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new BaseUrlError("That isn't a valid URL. It should look like https://git.example.com.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new BaseUrlError("The server URL must start with https:// or http://.");
  }
  if (url.username || url.password) throw new BaseUrlError("Leave credentials out of the server URL.");
  if (url.search || url.hash) throw new BaseUrlError("The server URL can't have a query or a fragment.");
  // `%2e%2e` and the like: a prefix that compares one way and resolves another.
  if (/%|\\|\/\//.test(url.pathname)) throw new BaseUrlError("That server path isn't supported.");
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

/** Loopback or a private network. Not link-local: that is where cloud metadata is. */
export function isPrivateAddress(address: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  const ip = mapped?.[1] ?? address.toLowerCase();
  if (isIP(ip) === 4) {
    const [a = 0, b = 0] = ip.split(".").map(Number);
    return (
      a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)
    );
  }
  return isIP(ip) === 6 && (ip === "::1" || /^f[cd]/.test(ip));
}

function isLinkLocal(address: string): boolean {
  const ip = address.toLowerCase().replace(/^::ffff:/, "");
  return ip.startsWith("169.254.") || /^fe[89ab]/.test(ip);
}

/** Why a resolved address may not be called over this scheme, or null. */
function refusal(protocol: string, host: string, addresses: string[]): string | null {
  if (addresses.length === 0) return `${host} did not resolve.`;
  if (addresses.some(isLinkLocal)) return `${host} is a link-local address, which can't be a git server.`;
  if (protocol === "http:" && !addresses.every(isPrivateAddress)) {
    return `http:// is only allowed for servers on this machine or a private network. Use https:// for ${host}.`;
  }
  return null;
}

/** The addresses a URL's host has, refused when the scheme may not reach them. */
export async function checkedAddresses(url: URL, resolve: Resolve = resolveDns): Promise<string[]> {
  const host = bare(url.hostname);
  let addresses: string[];
  try {
    addresses = isIP(host) ? [host] : await resolve(host);
  } catch {
    throw new BaseUrlError(`${host} did not resolve.`);
  }
  const reason = refusal(url.protocol, host, addresses);
  if (reason) throw new BaseUrlError(reason);
  return addresses;
}

function guardedLookup(protocol: string, resolve: Resolve): LookupFunction {
  return (hostname, options, callback) => {
    resolve(hostname).then(
      (addresses) => {
        const reason = refusal(protocol, hostname, addresses);
        if (reason) return callback(new BaseUrlError(reason) as NodeJS.ErrnoException, "", 4);
        const entries = addresses.map((address) => ({ address, family: isIP(address) }));
        if ((options as { all?: boolean }).all) {
          return (callback as unknown as (e: null, a: typeof entries) => void)(null, entries);
        }
        callback(null, entries[0]!.address, entries[0]!.family);
      },
      (error: NodeJS.ErrnoException) => callback(error, "", 4),
    );
  };
}

const TIMEOUT_MS = 15_000;
const MAX_BODY = 8 * 1024 * 1024;

/** `fetch` for a git host: guarded lookup, no redirects, a deadline and a size cap. */
export function createHostFetch(resolve: Resolve = resolveDns) {
  return async (raw: string, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(raw);
    // Node never calls `lookup` for an address literal.
    if (isIP(bare(url.hostname))) await checkedAddresses(url, resolve);
    const body = typeof init.body === "string" ? init.body : undefined;
    return new Promise<Response>((done, fail) => {
      const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(
        url,
        {
          method: init.method ?? "GET",
          headers: {
            ...(init.headers as Record<string, string> | undefined),
            ...(body !== undefined ? { "content-length": String(Buffer.byteLength(body)) } : {}),
          },
          lookup: guardedLookup(url.protocol, resolve),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        },
        (response) => {
          const chunks: Buffer[] = [];
          let total = 0;
          response.on("data", (chunk: Buffer) => {
            total += chunk.length;
            if (total > MAX_BODY) response.destroy(new Error("the answer is too large"));
            else chunks.push(chunk);
          });
          response.on("error", fail);
          response.on("end", () => {
            const status = response.statusCode ?? 502;
            const headers = new Headers();
            for (const [name, value] of Object.entries(response.headers)) {
              if (typeof value === "string") headers.set(name, value);
            }
            const empty = status === 204 || status === 205 || status === 304;
            done(new Response(empty ? null : Buffer.concat(chunks), { status: status < 200 ? 502 : status, headers }));
          });
        },
      );
      request.on("error", fail);
      request.end(body);
    });
  };
}

export const hostFetch = createHostFetch();
