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
  const project = await projectOf(projectHash);
  const expected = project?.defaultBranch ?? main.branch;
  if (expected) await expect(repo).toContainText(expected);

  // The picker: the project's branches only, the session's own branch apart.
  const sessionHash = href.split("/").at(-1);
  const { threads } = await api(`/api/projects/${projectHash}/threads`);
  const sessionBranch: string = threads.find((t: { hash: string }) => t.hash === sessionHash).branch;
  expect(sessionBranch).toMatch(/^ucch\//);
  await page.getByText("Session branch").click();
  const list = page.locator("[cmdk-list]");
  await expect(page.getByTestId("current-session-branch")).toContainText(sessionBranch);
  const listed = await list.locator("[cmdk-group]").filter({ hasNot: page.getByTestId("current-session-branch") }).locator("[cmdk-item]").allTextContents();
  expect(listed.length).toBeGreaterThan(0);
  expect(listed.filter((text) => /ucch\//.test(text))).toEqual([]);
  if (project?.defaultBranch) await expect(page.getByTestId("default-branch-badge").first()).toBeVisible();

  // Filtering for ucch finds nothing.
  const filter = page.getByPlaceholder("Filter or create a branch…");
  await filter.fill("ucch");
  await expect(list.locator("[cmdk-item]")).toHaveCount(0);
  await expect(page.getByTestId("reserved-branch-prefix")).toBeVisible();

  // And ucch/ cannot be made by hand.
  await filter.fill("ucch/test");
  await expect(page.getByTestId("reserved-branch-prefix")).toContainText("reserved for UCCH session branches");
  await expect(page.getByText("Create branch")).toHaveCount(0);
  const refused = await fetch(`${API}/api/projects/${projectHash}/git/branches?session=${sessionHash}`, {
    method: "POST",
    headers: { cookie: `ucch_session=${COOKIE}`, "content-type": "application/json" },
    body: JSON.stringify({ name: "ucch/test" }),
  });
  expect(refused.status).toBe(400);
  expect((await refused.json()).error).toMatch(/reserved for UCCH session branches/);
}

async function projectOf(hash: string): Promise<{ defaultBranch?: string } | undefined> {
  const { workspaces } = await api("/api/workspaces");
  for (const ws of workspaces) {
    const { projects } = await api(`/api/workspaces/${ws.id}/projects`).catch(() => ({ projects: [] }));
    const found = projects.find((p: { hash: string }) => p.hash === hash);
    if (found) return found;
  }
  return undefined;
}
