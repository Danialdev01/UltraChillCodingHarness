import { defineConfig } from "@playwright/test";

/**
 * The navigation-timing suite (`e2e/`), run against a *production* build:
 * `next dev` neither prefetches nor minifies, so its numbers say nothing.
 *
 * The web app is built into its own `distDir` (`NEXT_DIST_DIR`) so this can
 * run beside a `next dev` that owns `.next`. The API is whatever answers at
 * `E2E_API` -- a running dev server is reused -- and must have
 * `DEV_AUTH_BYPASS=true`, which lets the suite sign in with any cookie.
 *
 * `E2E_CHROME` points at an installed Chrome when Playwright's own browsers
 * are not downloaded (`npx playwright install chromium`).
 */
const WEB_PORT = Number(process.env.E2E_WEB_PORT ?? 3200);
const API = process.env.E2E_API ?? "http://127.0.0.1:3001";

export default defineConfig({
  testDir: "./e2e",
  timeout: 180_000,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? `http://127.0.0.1:${WEB_PORT}`,
    launchOptions: process.env.E2E_CHROME ? { executablePath: process.env.E2E_CHROME } : {},
  },
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : [
        {
          command: "pnpm --filter @ucch/server start",
          url: `${API}/health`,
          reuseExistingServer: true,
          timeout: 120_000,
        },
        {
          command: `NEXT_DIST_DIR=.next-e2e pnpm exec next build && NEXT_DIST_DIR=.next-e2e pnpm exec next start -p ${WEB_PORT}`,
          url: `http://127.0.0.1:${WEB_PORT}/healthz`,
          reuseExistingServer: true,
          timeout: 600_000,
        },
      ],
});
