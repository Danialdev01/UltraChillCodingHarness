import { expect, test } from "@playwright/test";

import { api, COOKIE, dispatch, newThread } from "./omp-thread";

/**
 * A handoff to another provider (OMP OM4.5, solution §5.4): `/continue` in
 * the composer writes a brief of the thread on OMP, starts a new thread on
 * the chosen harness in the same folder with the brief as its first
 * message, and links the two.
 *
 * The server runs as for `compact.spec.ts` (`OMP_ENABLED=true`,
 * `OMP_BIN=scripts/load/fake-omp-compaction.sh`, an OpenRouter key saved for
 * the dev user), and with `CLAUDE_BIN=scripts/load/fake-claude.mjs`, so the
 * new thread's turn runs on a stand-in for Claude Code rather than a
 * subscription.
 *
 *   pnpm --filter @ucch/web e2e handoff.spec
 */

test("hand a thread off to another provider", async ({ page, context, baseURL }) => {
  const origin = new URL(baseURL!).origin;
  const { threadId, href } = await newThread(origin, "handoff spec");
  await context.addCookies([{ name: "ucch_session", value: COOKIE, domain: new URL(baseURL!).hostname, path: "/" }]);
  await page.goto(href);
  const composer = page.locator("textarea[role=combobox]");
  await expect(composer).toBeEnabled({ timeout: 30_000 });

  // Not before the thread has run: there is nothing to hand off.
  const refused = await dispatch(origin, "handoff-spec-early", { type: "thread.handoff_to", threadId, targetProvider: "claude" }).catch(
    (e: Error) => e,
  );
  expect(String(refused)).toMatch(/no conversation to hand off yet/);

  await dispatch(origin, "handoff-spec-send", { type: "thread.send", threadId, text: "Fix the parser bug.", provider: "native" });
  await expect(page.getByTestId("compaction-divider")).toHaveCount(1, { timeout: 30_000 });
  await expect(composer).toBeEnabled({ timeout: 30_000 });

  // `/continue`, then the harness to carry it on in.
  await composer.fill("/continue claude");
  const row = page.getByText("Continue in Claude Code");
  await expect(row).toBeVisible();
  await composer.press("Enter");
  const continuedIn = page.getByTestId("continued-in");
  await expect(continuedIn).toBeVisible({ timeout: 30_000 });
  await expect(continuedIn).toContainText("Continued in a new thread on Claude Code");
  await expect(composer).toBeEnabled();

  // The new thread: in the same folder, opened with the brief, on Claude Code.
  const project = href.split("/").slice(0, 4).join("/");
  const { threads } = await api(`/api/projects/${href.split("/")[3]}/threads`);
  const source = threads.find((t: { id: string }) => t.id === threadId);
  const target = threads.find((t: { handoffFromThreadId: string | null }) => t.handoffFromThreadId === threadId);
  expect(target).toMatchObject({ title: `Continued: ${source.title}`, provider: "claude", treeHash: source.branch ? source.hash : null });

  await continuedIn.getByRole("link").click();
  await expect(page).toHaveURL(new RegExp(`${project}/${target.hash}$`), { timeout: 30_000 });
  await expect(page.getByTestId("continued-from")).toBeVisible({ timeout: 30_000 });
  const brief = page.getByTestId("handoff-brief");
  await expect(brief).toBeVisible();
  await brief.locator("summary").click();
  await expect(brief).toContainText("Fix the parser bug.");
  await expect(page.getByText("Continue from here.")).toBeVisible();
  // fake-claude answers, and the thread is free again.
  await expect(page.locator("textarea[role=combobox]")).toBeEnabled({ timeout: 60_000 });

  // And back: the link at the head of the new thread goes to the old one.
  await page.getByTestId("continued-from").getByRole("link").click();
  await expect(page).toHaveURL(new RegExp(`${href}$`), { timeout: 30_000 });
  await expect(page.getByTestId("continued-in")).toBeVisible({ timeout: 30_000 });
});

test("a session's handoff carries on in its worktree", async ({ baseURL }) => {
  const origin = new URL(baseURL!).origin;
  const { threadId, projectHash } = await newThread(origin, "handoff spec session", { session: true });
  type Row = { id: string; hash: string; branch: string | null; worktreeState: string | null; treeHash: string | null; handoffFromThreadId: string | null; status: string };
  const rows = async () => (await api(`/api/projects/${projectHash}/threads`)).threads as Row[];
  await expect.poll(async () => (await rows()).find((t) => t.id === threadId)?.worktreeState, { timeout: 30_000 }).toBe("ready");

  await dispatch(origin, "handoff-session-send", { type: "thread.send", threadId, text: "Fix the parser bug.", provider: "native" });
  await expect.poll(async () => (await rows()).find((t) => t.id === threadId)?.status, { timeout: 30_000 }).toBe("idle");
  await dispatch(origin, "handoff-session-to", { type: "thread.handoff_to", threadId, targetProvider: "claude", focus: "the tests" });
  await expect.poll(async () => (await rows()).some((t) => t.handoffFromThreadId === threadId), { timeout: 30_000 }).toBe(true);

  const all = await rows();
  const source = all.find((t) => t.id === threadId)!;
  const target = all.find((t) => t.handoffFromThreadId === threadId)!;
  // The same worktree, on the same branch, ready at once.
  expect(target).toMatchObject({ branch: source.branch, worktreeState: "ready", treeHash: source.hash });
  const files = (hash: string) => api(`/api/projects/${projectHash}/files?session=${hash}`);
  expect(await files(target.hash)).toEqual(await files(source.hash));
  await expect.poll(async () => (await rows()).find((t) => t.id === target.id)?.status, { timeout: 60_000 }).toBe("idle");

  // Not settled here: settling pushes a session's work to the project's
  // origin. Two sessions leaving one worktree is session-lifecycle.test.ts's.
});
