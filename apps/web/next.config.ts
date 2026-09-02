import type { NextConfig } from "next";

/**
 * Next reads `.env` only from its own directory, but UCCH keeps one `.env` at
 * the repo root. Rather than maintain a second copy, the two values the web
 * app needs default to the local server here. Both are overridden by real
 * environment variables in production (see docker-compose.yml).
 */
const SERVER_ORIGIN = process.env.SERVER_ORIGIN ?? "http://127.0.0.1:3001";
const WS_ORIGIN = process.env.NEXT_PUBLIC_WS_ORIGIN ?? SERVER_ORIGIN;

const config: NextConfig = {
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
  async rewrites() {
    // In development the UI and API are separate origins; proxying keeps the
    // session cookie first-party so the browser actually sends it.
    return [{ source: "/api/:path*", destination: `${SERVER_ORIGIN}/api/:path*` }];
  },
};

export default config;
