import path from "node:path";
import type { NextConfig } from "next";

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

export default config;
