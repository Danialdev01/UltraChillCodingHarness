#!/usr/bin/env node
/**
 * One fresh sign-in through the login form, in a real browser: how long
 * from pressing Enter until the shell is interactive, and what the tab then
 * asks the server for while it warms up.
 *
 *   node scripts/load/probes/signin.mjs --base http://127.0.0.1:3397 \
 *     --email load-049@load.test [--password load-password-123] [--settle 30]
 *
 * Interactive: off /login, no busy status on screen (the boot screen this
 * was written against had one) and <main> visible. The requests are the tab's own, counted from the
 * browser, so other traffic on the server does not muddy them: RSC renders
 * (`rsc: 1`) split into prefetches and the rest, and API calls.
 * Needs Chrome: E2E_CHROME (default /opt/google/chrome/chrome).
 */
import { createRequire } from "node:module";
import { parseArgs } from "node:util";

const { values: args } = parseArgs({
  options: {
    base: { type: "string", default: "http://127.0.0.1:3397" },
    email: { type: "string", default: "load-049@load.test" },
    password: { type: "string", default: "load-password-123" },
    settle: { type: "string", default: "30" },
  },
});

const require = createRequire(new URL("../../../apps/web/package.json", import.meta.url));
const { chromium } = require("@playwright/test");

const browser = await chromium.launch({ executablePath: process.env.E2E_CHROME ?? "/opt/google/chrome/chrome" });
const page = await (await browser.newContext()).newPage();
const counts = { rsc: 0, rscPrefetch: 0, api: 0 };
let counting = false;
page.on("request", (request) => {
  if (!counting) return;
  const headers = request.headers();
  if (headers.rsc === "1") counts[headers["next-router-prefetch"] ? "rscPrefetch" : "rsc"]++;
  else if (new URL(request.url()).pathname.startsWith("/api/")) counts.api++;
});

await page.goto(`${args.base}/login`);
const email = page.locator('input[type="email"], input[name="email"]');
await email.waitFor();
await email.fill(args.email);
await page.fill('input[type="password"]', args.password);
counting = true;
const submitted = Date.now();
await page.keyboard.press("Enter");
await page.waitForFunction(
  () =>
    location.pathname !== "/login" &&
    !document.querySelector('[role="status"][aria-busy="true"]') &&
    !!document.querySelector("main")?.checkVisibility(),
  null,
  { polling: "raf", timeout: 60_000 },
);
const interactiveMs = Date.now() - submitted;
await page.waitForTimeout(Number(args.settle) * 1000);
console.log(JSON.stringify({ email: args.email, interactiveMs, settleSeconds: Number(args.settle), requests: counts }));
await browser.close();
