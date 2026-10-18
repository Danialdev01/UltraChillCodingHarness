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
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const dist = args.find((a) => !a.startsWith("--")) ?? process.env.NEXT_DIST_DIR ?? ".next";
const here = dirname(fileURLToPath(import.meta.url));
const baselineFile = join(here, "..", "e2e", "results", "bundle-baseline.json");
const GROWTH = 1.1;

const app = JSON.parse(readFileSync(join(dist, "app-build-manifest.json"), "utf8")).pages;
const root = JSON.parse(readFileSync(join(dist, "build-manifest.json"), "utf8")).rootMainFiles ?? [];

const sizes = new Map();
function gz(file) {
  if (!sizes.has(file)) {
    const path = join(dist, file);
    sizes.set(file, existsSync(path) && file.endsWith(".js") ? gzipSync(readFileSync(path)).length : 0);
  }
  return sizes.get(file);
}

const layouts = Object.keys(app).filter((k) => k.endsWith("/layout"));
const result = {};
for (const key of Object.keys(app).filter((k) => k.endsWith("/page"))) {
  const dir = key.slice(0, -"/page".length);
  const chain = layouts.filter((l) => {
    const ld = l.slice(0, -"/layout".length);
    return ld === "" || dir === ld || dir.startsWith(`${ld}/`);
  });
  const files = new Set([...root, ...chain.flatMap((l) => app[l]), ...app[key]]);
  result[dir || "/"] = Math.round([...files].reduce((sum, f) => sum + gz(f), 0) / 1024);
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
