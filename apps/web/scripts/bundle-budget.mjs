#!/usr/bin/env node
/**
 * First-load JavaScript per app route, gzipped, from a finished `next build`.
 *
 *   node scripts/bundle-budget.mjs [distDir]            print the table
 *   node scripts/bundle-budget.mjs [distDir] --write    also save e2e/results/bundle-baseline.json
 *   node scripts/bundle-budget.mjs [distDir] --check    fail when a route grew >10% over that baseline
 *
 * A route's first load is what the browser needs before the page runs: the
 * framework's root chunks, every layout above the page, and the page itself
 * -- the same sum `next build` prints, recomputed here so it can be compared
 * and kept.
 */
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { gzipSync } from "node:zlib";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const dist = args.find((a) => !a.startsWith("--")) ?? process.env.NEXT_DIST_DIR ?? ".next";
const here = dirname(fileURLToPath(import.meta.url));
const baselineFile = join(here, "..", "e2e", "results", "bundle-baseline.json");
const GROWTH = 1.1;

const root = JSON.parse(readFileSync(join(dist, "build-manifest.json"), "utf8")).rootMainFiles ?? [];

const sizes = new Map();
function gz(file) {
  if (!sizes.has(file)) {
    const path = join(dist, file);
    sizes.set(file, existsSync(path) && file.endsWith(".js") ? gzipSync(readFileSync(path)).length : 0);
  }
  return sizes.get(file);
}

/**
 * Next 16 no longer writes `app-build-manifest.json`, so each page's chunks
 * come from its client reference manifest
 * (`server/app/<route>/page_client-reference-manifest.js`). That manifest
 * also lists the client modules of sibling routes, so a module counts only
 * when one of its chunks is the entry chunk of a segment in this page's chain
 * (`static/chunks/app/<segment>/{layout,page}-<hash>.js`): the root layout,
 * every layout above the page, and the page. Chunk names come URL-encoded
 * (`%5BworkspaceHash%5D`). On a Next 15 build this gave the same table as
 * the old manifest, to the kilobyte.
 */
const ENTRY = /^static\/chunks\/app\/(?:(.*)\/)?(page|layout)-[0-9a-f]+\.js$/;
const entryOf = (chunk) => {
  const m = ENTRY.exec(chunk);
  return m ? `${m[1] ? `${m[1]}/` : ""}${m[2]}` : null;
};

function* manifests(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* manifests(path);
    else if (name === "page_client-reference-manifest.js") yield path;
  }
}

const require = createRequire(import.meta.url);
const appDir = resolve(dist, "server", "app");
const result = {};
for (const file of manifests(appDir)) {
  const key = `/${relative(appDir, file).slice(0, -"_client-reference-manifest.js".length)}`;
  globalThis.__RSC_MANIFEST = undefined;
  require(file);
  const manifest = globalThis.__RSC_MANIFEST?.[key];
  if (!manifest) continue;
  const dir = key.slice(1, -"/page".length);
  const segments = dir ? dir.split("/") : [];
  const chain = new Set(["layout", dir ? `${dir}/page` : "page"]);
  for (let i = 1; i <= segments.length; i++) chain.add(`${segments.slice(0, i).join("/")}/layout`);
  const files = new Set(root);
  for (const mod of Object.values(manifest.clientModules)) {
    const js = mod.chunks.filter((c) => c.endsWith(".js")).map(decodeURIComponent);
    if (!js.some((c) => chain.has(entryOf(c)))) continue;
    // Another segment's entry chunk can ride along with a shared module.
    for (const c of js) if (entryOf(c) === null || chain.has(entryOf(c))) files.add(c);
  }
  result[dir ? `/${dir}` : "/"] = Math.round([...files].reduce((sum, f) => sum + gz(f), 0) / 1024);
}

const rows = Object.entries(result).sort((a, b) => b[1] - a[1]);
for (const [route, kb] of rows) console.log(`${String(kb).padStart(6)} kB  ${route}`);

if (args.includes("--write")) {
  mkdirSync(dirname(baselineFile), { recursive: true });
  writeFileSync(baselineFile, JSON.stringify(result, null, 2) + "\n");
  console.log(`\nwrote ${baselineFile}`);
}

if (args.includes("--check")) {
  const baseline = JSON.parse(readFileSync(baselineFile, "utf8"));
  const over = rows.filter(([route, kb]) => baseline[route] && kb > baseline[route] * GROWTH);
  if (over.length) {
    console.error("\nover budget (>10% above baseline):");
    for (const [route, kb] of over) console.error(`  ${route}: ${baseline[route]} -> ${kb} kB`);
    process.exit(1);
  }
  console.log("\nwithin budget");
}
