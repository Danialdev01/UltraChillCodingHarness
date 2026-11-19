import { expect, test } from "@playwright/test";

import { API, COOKIE, api, newThread } from "./omp-thread";

/**
 * A session's Git view names both branches: the session's own (its
 * worktree's `ucch/…`) and the one the project's repository is on, which
 * is where the session's work is merged.
 *
 *   pnpm --filter @ucch/web e2e git-branch
 *
 * It opens a new project session in the first project it can see and sends
 * nothing, so no agent turn runs; the empty session is removed after.
 */
test("a session's Git view shows the project repo's branch beside its own", async ({ page, context, baseURL }) => {
  const origin = new URL(baseURL!).origin;
  const { threadId, href, projectHash } = await newThread(origin, "git branch spec", { session: true });
  await expect
    .poll(async () => (await api(`/api/projects/${projectHash}/threads`)).threads.find((t: { id: string }) => t.id === threadId)?.worktreeState, {
      timeout: 60_000,
    })
    .toBe("ready");
  const sessionHash = href.split("/").at(-1)!;
  test.info().attach("session", { body: sessionHash });
  try {
    await check(projectHash, href, page, context, baseURL!);
  } finally {
    await fetch(`${API}/api/projects/${projectHash}/sessions/${sessionHash}?ifEmpty=1`, {
      method: "DELETE",
      headers: { cookie: `ucch_session=${COOKIE}` },
    });
  }
});

async function check(
  projectHash: string,
  href: string,
  page: import("@playwright/test").Page,
  context: import("@playwright/test").BrowserContext,
  baseURL: string,
) {
  const main = await api(`/api/projects/${projectHash}/git/status`);

  await context.addCookies([{ name: "ucch_session", value: COOKIE, domain: new URL(baseURL).hostname, path: "/" }]);
  await page.goto(href);
  await page.getByRole("tab", { name: "Git" }).click();
  await expect(page.locator("[data-slot=git-view]")).toBeVisible({ timeout: 30_000 });

  await expect(page.getByText("Session branch")).toBeVisible();
  const repo = page.getByTestId("project-repo-branch");
  await expect(repo).toBeVisible();
  await expect(repo).toContainText("Project repo");
  if (main.branch) await expect(repo).toContainText(main.branch);
}
