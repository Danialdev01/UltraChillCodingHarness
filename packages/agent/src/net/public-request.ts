import { lookup as dnsLookup } from "node:dns";
import { request as httpRequest, type IncomingMessage, type OutgoingHttpHeaders } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import { pipeline, type Readable } from "node:stream";
import { isBlocked } from "./address.js";

/** A name or address that is not public. */
export class BlockedAddressError extends Error {}

export interface PublicRequestOptions {
  signal: AbortSignal;
  headers: OutgoingHttpHeaders;
  /** For tests: resolve names without DNS. */
  resolve?: ((host: string) => Promise<string[]>) | undefined;
  /** For tests: which addresses are refused. Defaults to every non-public one. */
  blocked?: ((address: string) => boolean) | undefined;
}

/**
 * One GET to a public address, redirects left to the caller to check again.
 *
 * The address checked is the address dialled: the check runs inside the
 * socket's own `lookup`, so a name cannot resolve to a public address for
 * the check and a private one for the connection. An address written
 * literally never reaches `lookup`, so it is checked here.
 */
export async function publicRequest(url: URL, options: PublicRequestOptions): Promise<IncomingMessage> {
  const blocked = options.blocked ?? isBlocked;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host) && blocked(host)) throw new BlockedAddressError(`${host} is a private or loopback address`);
  return new Promise((done, fail) => {
    const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(
      url,
      {
        method: "GET",
        signal: options.signal,
        lookup: guardedLookup(blocked, options.resolve),
        headers: options.headers,
        // A kept-alive socket would skip `lookup`, and the check with it.
        agent: false,
      },
      done,
    );
    request.on("error", fail);
    request.end();
  });
}

/** The response's body with its content encoding undone. */
export function decodedBody(response: IncomingMessage): Readable {
  const encoding = String(response.headers["content-encoding"] ?? "").toLowerCase();
  const decoder =
    encoding === "gzip" || encoding === "x-gzip"
      ? createGunzip()
      : encoding === "deflate"
        ? createInflate()
        : encoding === "br"
          ? createBrotliDecompress()
          : null;
  // The reader sees the error on the decoder; this only stops it being uncaught.
  return decoder ? pipeline(response, decoder, () => {}) : response;
}

/** A lookup that refuses to hand the socket a private address. */
export function guardedLookup(blocked: (address: string) => boolean, resolve?: (host: string) => Promise<string[]>): LookupFunction {
  return (hostname, options, callback) => {
    const done = (error: Error | null, addresses: string[]) => {
      if (error) return callback(error as NodeJS.ErrnoException, "", 4);
      if (addresses.length === 0) return callback(new BlockedAddressError(`${hostname} did not resolve`) as NodeJS.ErrnoException, "", 4);
      const refused = addresses.find((address) => blocked(address));
      if (refused) return callback(new BlockedAddressError(`${hostname} resolves to ${refused}, a private or loopback address`) as NodeJS.ErrnoException, "", 4);
      const entries = addresses.map((address) => ({ address, family: isIP(address) }));
      if ((options as { all?: boolean }).all) return (callback as unknown as (e: null, a: typeof entries) => void)(null, entries);
      callback(null, entries[0]!.address, entries[0]!.family);
    };
    if (resolve) {
      resolve(hostname).then((addresses) => done(null, addresses), (error: Error) => done(error, []));
      return;
    }
    dnsLookup(hostname, { all: true }, (error, results) => done(error, (results ?? []).map((r) => r.address)));
  };
}
