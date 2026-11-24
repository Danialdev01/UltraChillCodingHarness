/**
 * Writes `.br` and `.gz` copies beside a build's hashed static files, for the
 * edge to serve as they are (apps/server/src/web-proxy.ts): compressing once,
 * as hard as it goes, instead of on every request or not at all.
 *
 *   node scripts/precompress.mjs .next/static
 *
 * A copy that saves less than a tenth is not written.
 */
import { readdir, readFile, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { promisify } from "node:util";
import { brotliCompress, constants, gzip } from "node:zlib";

const COMPRESSIBLE = new Set([".js", ".mjs", ".css", ".json", ".svg", ".wasm", ".ttf", ".txt", ".html"]);
const MIN_BYTES = 1024;
const [br, gz] = [promisify(brotliCompress), promisify(gzip)];

const root = process.argv[2];
if (!root) throw new Error("usage: precompress.mjs <static dir>");

const files = (await readdir(root, { recursive: true, withFileTypes: true }))
  .filter((entry) => entry.isFile() && COMPRESSIBLE.has(extname(entry.name).toLowerCase()))
  .map((entry) => join(entry.parentPath, entry.name));

const total = { raw: 0, br: 0, gz: 0 };
async function worker() {
  for (let path = files.pop(); path; path = files.pop()) {
    const raw = await readFile(path);
    if (raw.length < MIN_BYTES) continue;
    const copies = {
      br: await br(raw, { params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_SIZE_HINT]: raw.length } }),
      gz: await gz(raw, { level: 9 }),
    };
    total.raw += raw.length;
    for (const [name, data] of Object.entries(copies)) {
      const worth = data.length < raw.length * 0.9;
      total[name] += worth ? data.length : raw.length;
      if (worth) await writeFile(`${path}.${name}`, data);
    }
  }
}
// zlib runs on libuv's pool of four.
await Promise.all([worker(), worker(), worker(), worker()]);
console.log(`precompressed ${root}: ${total.raw} bytes raw, ${total.gz} gzip, ${total.br} brotli`);
