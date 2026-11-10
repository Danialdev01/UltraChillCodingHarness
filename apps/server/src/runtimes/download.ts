import { createWriteStream } from "node:fs";
import { rm } from "node:fs/promises";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

/**
 * Downloads `url` to `file`, streaming, refusing anything over `maxBytes`
 * whatever the server claims. Shared by every runtime provider: each one is
 * "fetch an archive, unpack it, check the binary".
 */
export async function downloadTo(
  url: string,
  file: string,
  options: { maxBytes: number; signal?: AbortSignal; onProgress?(received: number, total: number | null): void },
): Promise<void> {
  const response = await fetch(url, { signal: options.signal, redirect: "follow" });
  if (!response.ok || !response.body) throw new Error(`download failed: HTTP ${response.status} for ${url}`);
  const header = Number(response.headers.get("content-length"));
  const total = Number.isFinite(header) && header > 0 ? header : null;
  if (total !== null && total > options.maxBytes) throw new Error(`download is ${total} bytes, over the ${options.maxBytes} limit`);

  let received = 0;
  let lastReport = 0;
  const meter = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      received += chunk.length;
      if (received > options.maxBytes) {
        done(new Error(`download passed the ${options.maxBytes} byte limit`));
        return;
      }
      // At most every 256 KiB: a progress callback per chunk is a lot of
      // nothing for a 12 MB file.
      if (received - lastReport >= 256 * 1024) {
        lastReport = received;
        options.onProgress?.(received, total);
      }
      done(null, chunk);
    },
  });
  try {
    await pipeline(Readable.fromWeb(response.body as never), meter, createWriteStream(file, { mode: 0o600 }), {
      signal: options.signal,
    });
  } catch (error) {
    await rm(file, { force: true });
    throw error;
  }
  options.onProgress?.(received, total ?? received);
}
