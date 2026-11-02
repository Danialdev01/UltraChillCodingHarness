import { expect, test } from "@playwright/test";

import { API, COOKIE, api, dispatch, newThread } from "./omp-thread";

/**
 * A code review in the Git view (OMP OM7.8, solution §9.3): Review changes
 * runs OMP's reviewer on the session's uncommitted changes; its verdict is
 * a banner, its findings are drawn on the diff lines they are about, and
 * Send to agent posts the picked ones to the session as a message.
 *
 * The server runs OMP on the replay of a review whose reviewer yields one
 * P0 on `math.ts` line 2, with no network: `OMP_ENABLED=true`,
 * `OMP_BIN=scripts/load/fake-omp-review.sh`, and an OpenRouter key saved for
 * the dev user (any value: nothing calls OpenRouter). Then:
 *
 *   pnpm --filter @ucch/web e2e review
 *
 * It opens a new project session in the first project it can see, on a
 * worktree of its own, and writes a `math.ts` with the bug on line 2 and a
 * lock file into it. A first message on the Custom provider (`native`,
 * which OMP_ENABLED routes to OMP) binds the session to OMP, so the findings
 * Send to agent posts start a replayed turn, never one on the account's
 * default provider.
 */

const MATH = "export const add = (a: number, b: number) => a + b;\nexport const div = (a: number, b: number) => a * b;\n";

async function write(projectHash: string, session: string, path: string, content: string) {
  const response = await fetch(`${API}/api/projects/${projectHash}/file?session=${session}`, {
    method: "PUT",
    headers: { cookie: `ucch_session=${COOKIE}`, "content-type": "application/json" },
    body: JSON.stringify({ path, content }),
  });
  if (!response.ok) throw new Error(`write ${path}: ${response.status} ${await response.text()}`);
}

test("a review's verdict, its findings on the diff, and Send to agent", async ({ page, context, baseURL }) => {
  const origin = new URL(baseURL!).origin;
  const { threadId, href, projectHash } = await newThread(origin, "review spec", { session: true });
  const sessionHash = href.split("/").at(-1)!;
  // The worktree is made after the thread: wait for it.
  await expect
    .poll(async () => (await api(`/api/projects/${projectHash}/threads`)).threads.find((t: { id: string }) => t.id === threadId)?.worktreeState, {
      timeout: 60_000,
    })
    .toBe("ready");
  const status = async () => (await api(`/api/projects/${projectHash}/threads`)).threads.find((t: { id: string }) => t.id === threadId)?.status;
  await dispatch(origin, "review-spec-bind", { type: "thread.send", threadId, text: "Hello.", provider: "native" });
  await expect.poll(status, { timeout: 60_000 }).toBe("idle");
  await write(projectHash, sessionHash, "math.ts", MATH);
  await write(projectHash, sessionHash, "pnpm-lock.yaml", "lockfileVersion: '9.0'\n");

  await context.addCookies([{ name: "ucch_session", value: COOKIE, domain: new URL(baseURL!).hostname, path: "/" }]);
  await page.goto(href);
  await page.getByRole("tab", { name: "Git" }).click();
  await expect(page.locator("[data-slot=git-view]")).toBeVisible({ timeout: 30_000 });

  // Review changes, from the toolbar.
  await page.getByTestId("review-menu").click();
  await page.getByRole("menuitem", { name: /Review changes/ }).click();

  const verdict = page.getByTestId("review-verdict");
  await expect(verdict).toHaveAttribute("data-verdict", "incorrect", { timeout: 60_000 });
  await expect(verdict).toContainText("div multiplies instead of dividing.");
  await expect(page.getByTestId("review-excluded")).toContainText("pnpm-lock.yaml");

  // The finding opens its file, drawn under its line.
  await verdict.getByRole("button", { name: /div multiplies/ }).click();
  const note = page.locator("[data-slot=git-view] table [data-testid=review-finding]");
  await expect(note).toHaveCount(1);
  await expect(note).toHaveAttribute("data-priority", "P0");
  await expect(note).toContainText("`a * b` should be `a / b`.");
  const flagged = page.locator("[data-slot=git-view] table tr[data-flagged]");
  await expect(flagged).toHaveCount(1);
  await expect(flagged).toContainText("a * b");

  // Drawn the same after a reload, from the server's record of it.
  await page.reload();
  await page.getByRole("tab", { name: "Git" }).click();
  await expect(page.getByTestId("review-verdict")).toHaveAttribute("data-verdict", "incorrect", { timeout: 30_000 });

  // Send to agent: the finding, as the session's next message.
  await page.getByTestId("review-send").click();
  await page.getByRole("tab", { name: "Chat" }).click();
  await expect(page.getByText("A code review of the uncommitted changes found this.", { exact: false }).first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/div multiplies \(math\.ts:2\)/).first()).toBeVisible();
});
