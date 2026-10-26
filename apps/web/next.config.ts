import { randomUUID } from "node:crypto";
import { readdirSync, rmSync } from "node:fs";
import path from "node:path";
import type { NextConfig } from "next";
import { PHASE_PRODUCTION_BUILD } from "next/constants";
import bundleAnalyzer from "@next/bundle-analyzer";
import withSerwistInit from "@serwist/next";

/**
 * Next reads `.env` only from its own directory, but UCCH keeps one `.env` at
 * the repo root. Rather than maintain a second copy, the two values the web
 * app needs default to the local server here. Both are overridden by real
 * environment variables in production (see the root Dockerfile) -- and both
 * are read at *build* time: the rewrite table is compiled into the build, so
 * a SERVER_ORIGIN set only on the running container has no effect.
 */
const SERVER_ORIGIN = process.env.SERVER_ORIGIN ?? "http://127.0.0.1:3001";
const WS_ORIGIN = process.env.NEXT_PUBLIC_WS_ORIGIN ?? SERVER_ORIGIN;

const config: NextConfig = {
  // A second build directory, so a production build (the e2e suite's) can
  // run beside a `next dev` that owns `.next`. Unset everywhere else.
  distDir: process.env.NEXT_DIST_DIR || ".next",
  // Production images ship only the traced server (`server.js` plus the files
  // it reaches), not the whole monorepo's node_modules. The trace starts at
  // the repo root so workspace packages are included. No effect on `next dev`.
  output: "standalone",
  outputFileTracingRoot: path.resolve(process.cwd(), "../.."),
  env: { NEXT_PUBLIC_WS_ORIGIN: WS_ORIGIN },
  // The protocol package is shipped as TypeScript source and compiled by the
  // Next build rather than pre-built, so client and server can never drift
  // onto different versions of the wire contract.
  transpilePackages: ["@ucch/protocol"],
  poweredByHeader: false,
  experimental: {
    // How long the router keeps a page it has rendered (or prefetched) and
    // shows it again without asking the server: a return to a page within
    // half a minute is instant, and its data revalidates through the client
    // cache meanwhile. Live updates arrive over the socket either way.
    staleTimes: { dynamic: 30, static: 300 },
    optimizePackageImports: ["lucide-react", "@base-ui/react"],
  },
  async headers() {
    // The same baseline the API sends (apps/server/src/http-guards.ts). The
    // app is never meant to be framed -- a framed shell with a live session
    // is a clickjacking target -- and nothing it serves should be sniffed
    // into another type. HSTS is Traefik's, since only it knows the scheme.
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Content-Security-Policy", value: "frame-ancestors 'none'; base-uri 'self'; object-src 'none'" },
        ],
      },
      {
        // The service worker is checked for updates on every page load; a
        // cached copy would hide a deploy. Same headers as the edge sends
        // (web-proxy.ts), for a `next start` with nothing in front of it.
        source: "/sw.js",
        headers: [
          { key: "Cache-Control", value: "no-cache" },
          { key: "Service-Worker-Allowed", value: "/" },
        ],
      },
    ];
  },
  webpack(config) {
    // `@ucch/protocol` is NodeNext TypeScript: its internal imports carry
    // explicit `.js` specifiers that resolve to `.ts` files on disk. The
    // server compiles this natively; webpack needs to be told.
    config.resolve.extensionAlias = {
      ".js": [".ts", ".tsx", ".js"],
      ".mjs": [".mts", ".mjs"],
    };
    return config;
  },
  async redirects() {
    // A project's notes moved to /documentation when it grew diagrams and
    // references; old links and bookmarks follow it there.
    return [
      {
        source: "/:hash([a-z0-9]{12})/notes/:rest*",
        destination: "/:hash/documentation/:rest*",
        permanent: false,
      },
    ];
  },
  async rewrites() {
    // In development the UI and API are separate origins; proxying keeps the
    // session cookie first-party so the browser actually sends it.
    return [
      { source: "/api/:path*", destination: `${SERVER_ORIGIN}/api/:path*` },
      // The shareable preview entry point. The server answers with a
      // redirect to the preview subdomain, so this never carries the app's
      // own traffic -- only the hop that needs the session cookie.
      {
        source: "/:hash([a-z0-9]{12})/preview/:rest*",
        destination: `${SERVER_ORIGIN}/api/projects/:hash/preview/open/:rest*`,
      },
    ];
  },
};

// `ANALYZE=1 next build` writes treemaps of every bundle to `<distDir>/analyze`.
const withBundleAnalyzer = bundleAnalyzer({ enabled: process.env.ANALYZE === "1", openAnalyzer: false });

/**
 * The service worker (`src/app/sw.ts`), built into `public/sw.js` only when
 * `NEXT_PUBLIC_PWA=1` -- read at build time, like every `NEXT_PUBLIC_`. The
 * page registers it itself (`lib/pwa.ts`), so it can remove it too.
 *
 * The precache is cut down to what every page needs before it can draw:
 * stylesheets, fonts, the runtime chunks, the root layout's and the offline
 * page's. Everything else is cached as it is used; precaching all ~200 chunks
 * would download every editor on install.
 */
const PRECACHE = /static\/(?:css\/.*\.css|media\/.*\.woff2|chunks\/(?:framework|main|main-app|webpack|polyfills)-[^/]*\.js|chunks\/app\/(?:layout|offline\/page)-[^/]*\.js)$/;

const PWA = process.env.NEXT_PUBLIC_PWA === "1";

/**
 * A build without the flag must not ship a worker an earlier build left in
 * public/: the server sends a self-removing one only when there is none.
 * Only while building -- `next start` reads this file too.
 */
function removeStaleWorker() {
  let names: string[] = [];
  try {
    names = readdirSync("public");
  } catch {
    // No public/ at all: nothing was left behind.
  }
  for (const name of names) {
    if (/^(?:sw|swe-worker-.*)\.js(?:\.map)?$/.test(name)) rmSync(path.join("public", name), { force: true });
  }
}

const withSerwist = withSerwistInit({
  swSrc: "src/app/sw.ts",
  swDest: "public/sw.js",
  disable: !PWA,
  register: false,
  // A reload on reconnect would throw away whatever was being typed.
  reloadOnOnline: false,
  // Static, so one revision per build is exact enough.
  additionalPrecacheEntries: [{ url: "/offline", revision: randomUUID() }],
  manifestTransforms: [async (entries) => ({ manifest: entries.filter((entry) => PRECACHE.test(entry.url)), warnings: [] })],
});

export default function nextConfig(phase: string): NextConfig {
  if (phase === PHASE_PRODUCTION_BUILD && !PWA) removeStaleWorker();
  return withSerwist(withBundleAnalyzer(config));
}
