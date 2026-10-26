#!/usr/bin/env node
/**
 * Bundles the server into `dist/server.mjs` -- and the collab service into
 * `dist/collab.mjs` -- for production.
 *
 * The workspace packages (`@ucch/*`) are TypeScript sources, so they are
 * compiled in. Everything from npm stays an ordinary `import` resolved from
 * node_modules at runtime: native modules (node-pty) cannot be bundled, and
 * the rest gain nothing from it but a fragile build.
 *
 * What the sources find beside themselves at runtime comes along: the shell
 * init files `terminals.ts` locates with `import.meta.url`. The migrations
 * and the document kit are found through MIGRATIONS_DIR and DOC_KIT_DIR.
 */
import { build } from "esbuild";
import { cpSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "dist");

rmSync(out, { recursive: true, force: true });

await build({
  // The API, and the collab service: its own process (deploy/s6/s6-rc.d/collab).
  entryPoints: { server: join(here, "src/index.ts"), collab: join(here, "src/collab.ts") },
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
  plugins: [
    {
      name: "external-npm",
      setup(b) {
        // Bare specifiers other than the workspace's own packages stay imports.
        b.onResolve({ filter: /^[^./]/ }, (args) => {
          if (args.path.startsWith("@ucch/") || args.path.startsWith("node:")) return undefined;
          return { path: args.path, external: true };
        });
      },
    },
  ],
  // For the odd CommonJS module an ESM bundle still has to `require`.
  banner: {
    js: "import { createRequire as __ucchCreateRequire } from 'node:module'; const require = __ucchCreateRequire(import.meta.url);",
  },
});

cpSync(join(here, "src/shell"), join(out, "shell"), {
  recursive: true,
  filter: (path) => !path.endsWith(".test.ts"),
});
