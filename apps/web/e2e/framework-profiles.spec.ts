import { expect, test, type Page } from "@playwright/test";

import { api, COOKIE } from "./omp-thread";

/**
 * Framework profiles in the UI (plan3 §4): the New Project dialog's picker,
 * options and "Will set up" summary, and the manage page's Environment tab.
 * Nothing is created: the dialog is closed unsent and the tab is only read.
 *
 *   pnpm --filter @ucch/web e2e framework-profiles
 */
async function firstProject(): Promise<{ ws: string; project: string }> {
  const { workspaces } = await api("/api/workspaces");
  for (const ws of workspaces.filter((w: { kind: string; archived: boolean }) => w.kind === "project" && !w.archived)) {
    const { projects } = await api(`/api/workspaces/${ws.id}/projects`);
    if (projects.length) return { ws: ws.hash, project: projects[0].hash };
  }
  throw new Error("no project: create one first");
}

const noOverflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - innerWidth);

for (const width of [1280, 375]) {
  test(`picker, options and summary in the New Project dialog at ${width}px`, async ({ page, context, baseURL }, testInfo) => {
    await context.addCookies([{ name: "ucch_session", value: COOKIE, domain: new URL(baseURL!).hostname, path: "/" }]);
    const { ws } = await firstProject();
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/${ws}`);
    // The sidebar's quick action; on a phone the sidebar is a sheet, opened first.
    // Clicked again until it opens: a click before hydration does nothing.
    const dialog = page.getByRole("dialog", { name: /project/i });
    await expect(async () => {
      if (width < 768 && !(await page.getByRole("button", { name: "New project" }).first().isVisible())) {
        await page.getByRole("button", { name: "Toggle sidebar" }).first().click({ timeout: 5_000 });
      }
      await page.getByRole("button", { name: "New project" }).first().click({ timeout: 5_000 });
      await expect(dialog).toBeVisible({ timeout: 3_000 });
    }).toPass({ timeout: 90_000 });
    await dialog.getByRole("tab", { name: /Empty/ }).or(dialog.getByRole("radio", { name: /Empty/ })).first().click();

    const picker = dialog.getByTestId("framework-picker");
    await expect(picker).toBeVisible();
    await picker.getByRole("radio", { name: /Rust/ }).click();
    const options = dialog.getByTestId("framework-options");
    await expect(options).toBeVisible();
    // The version lists arrive from /api/frameworks: a skeleton, then the fields.
    await expect(options.locator("[data-slot=skeleton]")).toHaveCount(0, { timeout: 30_000 });
    // A binary crate: no server, so no preview port.
    await expect(dialog.getByTestId("framework-summary")).toContainText(/Rust stable/);
    await expect(dialog.getByTestId("framework-summary")).not.toContainText(/preview/);

    await picker.getByRole("radio", { name: /Laravel/ }).click();
    await expect(dialog.getByTestId("framework-summary")).toContainText(/PHP/);
    await expect(dialog.getByTestId("framework-summary")).toContainText(/:8000/);
    expect(await noOverflow(page)).toBeLessThanOrEqual(0);
    await page.screenshot({ path: testInfo.outputPath(`dialog-${width}.png`) });
  });

  test(`the Environment tab shows the framework above the runtimes at ${width}px`, async ({ page, context, baseURL }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await context.addCookies([{ name: "ucch_session", value: COOKIE, domain: new URL(baseURL!).hostname, path: "/" }]);
    const { ws, project } = await firstProject();
    await page.goto(`/${ws}/p/${project}/manage?tab=runtimes`);
    await expect(page.getByRole("tab", { name: "Environment" })).toBeVisible({ timeout: 60_000 });
    const settings = page.getByTestId("framework-settings");
    await expect(settings).toBeVisible({ timeout: 30_000 });
    await expect(settings.getByTestId("framework-picker")).toBeVisible();
    expect(await noOverflow(page)).toBeLessThanOrEqual(0);
    await page.screenshot({ path: testInfo.outputPath(`environment-${width}.png`), fullPage: true });
  });
}
