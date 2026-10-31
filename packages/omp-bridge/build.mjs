#!/usr/bin/env node
/**
 * Bundles the bridge into one file, `dist/omp-bridge.mjs` (solution §10.1).
 *
 * Unlike the server's bundle, everything goes in, the MCP SDK included: the
 * CLI starts the bridge as `node <file>` from wherever the image puts it, with
 * no node_modules beside it to resolve from.
 */
import { build } from "esbuild";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "dist");

rmSync(out, { recursive: true, force: true });

await build({
  entryPoints: { "omp-bridge": join(here, "src/index.ts") },
  outdir: out,
  outExtension: { ".js": ".mjs" },
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  sourcemap: "linked",
  logLevel: "info",
  // The workspace's own TypeScript imports its siblings with `.js` specifiers.
  resolveExtensions: [".ts", ".tsx", ".js", ".mjs", ".json"],
  // For the odd CommonJS module an ESM bundle still has to `require`.
  banner: {
    js: "import { createRequire as __ucchCreateRequire } from 'node:module'; const require = __ucchCreateRequire(import.meta.url);",
  },
});
