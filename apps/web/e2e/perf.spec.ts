import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";

/**
 * How long each kind of click takes, measured the way a person sees it:
 *
 *   paint    click -> the address bar shows the new page, which the App
 *            Router commits together with the page (or its loading.tsx)
 *   content  click -> nothing in <main> is a skeleton any more
 *
 * It walks the routes the plan names (documentation/plan.md §B.10), picking
 * real hashes from the API so it runs against any dev database. Each hop is
 * a soft navigation: through the app's own link when one is on screen,
 * otherwise through the router itself -- never a full page load.
 *
 * Results go to `e2e/results/<E2E_LABEL or "latest">.json`.
 */

const API = process.env.E2E_API ?? "http://127.0.0.1:3001";
const COOKIE = process.env.E2E_SESSION ?? "dev";
const RESULTS = join(dirname(fileURLToPath(import.meta.url)), "results");

type Json = Record<string, any>;

async function api(path: string): Promise<Json> {
  const response = await fetch(`${API}${path}`, { headers: { cookie: `ucch_session=${COOKIE}` } });
  if (!response.ok) throw new Error(`${path}: ${response.status}`);
  return response.json() as Promise<Json>;
}

/** A workspace and project with enough in them to walk: two sessions and two notes when it can. */
async function pickRoute(): Promise<{ steps: { name: string; href: string }[] }> {
  const { workspaces } = await api("/api/workspaces");
  let best: { ws: Json; project: Json; threads: Json[]; notes: Json[]; score: number } | null = null;
  for (const ws of workspaces.filter((w: Json) => w.kind === "project" && !w.archived)) {
    const { projects } = await api(`/api/workspaces/${ws.id}/projects`);
    for (const project of projects.slice(0, 8)) {
      const [{ threads }, { notes }] = await Promise.all([
        api(`/api/projects/${project.hash}/threads`),
        api(`/api/projects/${project.hash}/notes`),
      ]);
      const score = Math.min(threads.length, 2) + Math.min(notes.length, 2);
      if (!best || score > best.score) best = { ws, project, threads, notes, score };
      if (score === 4) break;
    }
    if (best?.score === 4) break;
  }
  if (!best) throw new Error("no project to walk: create one in the dev database first");

  const ws = best.ws.hash as string;
  const p = `/${ws}/p/${best.project.hash}`;
  const steps: { name: string; href: string }[] = [{ name: "dashboard", href: `/${ws}` }];
  best.threads.slice(0, 2).forEach((t, i) => steps.push({ name: `session ${i ? "B" : "A"}`, href: `${p}/${t.hash}` }));
  steps.push({ name: "tasks", href: `${p}/tasks` });
  steps.push({ name: "documentation", href: `${p}/documentation` });
  best.notes
    .filter((n) => n.parentId !== null)
    .slice(0, 2)
    .forEach((n, i) => steps.push({ name: `note ${i ? "B" : "A"}`, href: `${p}/documentation/${n.id}` }));
  steps.push({ name: "timeline", href: `${p}/timeline` });
  steps.push({ name: "settings account", href: "/setting/account" });
  steps.push({ name: "settings theme", href: "/setting/theme" });
  steps.push({ name: "workspace settings", href: `/${ws}/workspace-settings/general` });
  steps.push({ name: "workspace members", href: `/${ws}/workspace-settings/members` });
  steps.push({ name: "dashboard again", href: `/${ws}` });
  return { steps };
}

/** Soft-navigates to `href` and times paint and content, in ms. */
async function hop(page: Page, href: string): Promise<{ paint: number; content: number; via: string }> {
  return page.evaluate(async (target) => {
    const now = () => performance.now();
    const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const main = () => document.querySelector("main") ?? document.body;
    const link = [...document.querySelectorAll<HTMLAnchorElement>(`a[href="${target}"]`)].find(
      (a) => a.offsetParent !== null && Object.keys(a).some((k) => k.startsWith("__reactProps")),
    );
    const start = now();
    let via = "link";
    if (link) link.click();
    else {
      via = "router";
      (window as any).next.router.push(target);
    }
    let paint = -1;
    let quiet = 0;
    while (now() - start < 15_000) {
      await frame();
      if (paint < 0 && location.pathname === target) paint = now() - start;
      if (paint >= 0) {
        quiet = main().querySelector('[data-slot="skeleton"]') ? 0 : quiet + 1;
        if (quiet >= 2) return { paint, content: now() - start, via };
      }
    }
    return { paint, content: -1, via };
  }, href);
}

test("navigation timing", async ({ page, context, baseURL }) => {
  const { steps } = await pickRoute();
  const host = new URL(baseURL!).hostname;
  await context.addCookies([{ name: "ucch_session", value: COOKIE, domain: host, path: "/" }]);

  const loadStart = Date.now();
  await page.goto(steps[0]!.href);
  await expect(page.locator("main")).toBeVisible();
  await page.waitForFunction(() => !document.querySelector('main [data-slot="skeleton"]'), null, { timeout: 30_000 });
  const firstLoad = Date.now() - loadStart;
  // Let the route warmup (components/route-warmup.tsx) run, as a person reading the page would.
  await page.waitForTimeout(Number(process.env.E2E_IDLE_MS ?? 6000));

  const hops: { name: string; href: string; paint: number; content: number; via: string }[] = [];
  for (const step of steps.slice(1)) {
    const timing = await hop(page, step.href);
    hops.push({ ...step, ...timing });
    await page.waitForTimeout(400);
  }

  const sorted = (key: "paint" | "content") => hops.map((h) => h[key]).filter((v) => v >= 0).sort((a, b) => a - b);
  const p95 = (values: number[]) => values[Math.min(values.length - 1, Math.floor(values.length * 0.95))] ?? -1;
  const result = {
    at: new Date().toISOString(),
    baseURL,
    firstLoad,
    p95: { paint: p95(sorted("paint")), content: p95(sorted("content")) },
    hops,
  };
  mkdirSync(RESULTS, { recursive: true });
  writeFileSync(join(RESULTS, `${process.env.E2E_LABEL ?? "latest"}.json`), JSON.stringify(result, null, 2));
  console.table(hops.map(({ name, paint, content, via }) => ({ name, paint: Math.round(paint), content: Math.round(content), via })));

  expect(hops.every((h) => h.paint >= 0)).toBe(true);
});
