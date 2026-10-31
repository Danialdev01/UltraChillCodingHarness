import { expect, test } from "@playwright/test";

import { COOKIE, dispatch, newThread } from "./omp-thread";

/**
 * A `task` call draws as a subagent card (OMP OM5.3, solution §6.3): who
 * ran, what it was asked, and, once it is done, its answer a click away.
 *
 * The server runs OMP turns on the replay of a turn whose `task` sends a
 * scout off in the background, with no network: `OMP_ENABLED=true`,
 * `OMP_BIN=scripts/load/fake-omp-subagent.sh`, and an OpenRouter key saved
 * for the dev user (any value: nothing calls OpenRouter). Then:
 *
 *   pnpm --filter @ucch/web e2e subagent
 *
 * The message goes over the socket on the Custom provider (`native`), which
 * OMP_ENABLED routes to OMP, as in `compaction.spec.ts`.
 */

test("a subagent is a card with its answer", async ({ page, context, baseURL }) => {
  const origin = new URL(baseURL!).origin;
  const { threadId, href } = await newThread(origin, "subagent spec");
  await context.addCookies([{ name: "ucch_session", value: COOKIE, domain: new URL(baseURL!).hostname, path: "/" }]);
  await page.goto(href);
  // Loaded and listening before the turn starts, so it is drawn live.
  await expect(page.locator("textarea[role=combobox]")).toBeEnabled({ timeout: 30_000 });
  await dispatch(origin, "subagent-spec-send", { type: "thread.send", threadId, text: "What does src export?", provider: "native" });

  // The turn's work is folded into one line; the card is inside it.
  const work = page.locator("details.group\\/work").first();
  await expect(work).toBeVisible({ timeout: 60_000 });
  await work.locator(":scope > summary").click();

  const card = page.getByTestId("subagent-card");
  await expect(card).toHaveCount(1);
  // The recording's scout, on the task it was given.
  await expect(card.locator("summary")).toContainText("scout");
  await expect(card.locator("summary")).toContainText("List what src/ exports.");
  await expect(card).toHaveAttribute("data-status", "done", { timeout: 60_000 });

  // Collapsed: the answer is a click away.
  const result = card.getByTestId("subagent-result");
  await expect(result).toBeHidden();
  await card.locator(":scope > summary").click();
  await expect(result).toContainText("src/a.ts exports");

  // And it is drawn the same from the log.
  await page.reload();
  const reloaded = page.locator("details.group\\/work").first();
  await expect(reloaded).toBeVisible({ timeout: 30_000 });
  await reloaded.locator(":scope > summary").click();
  await expect(page.getByTestId("subagent-card")).toHaveAttribute("data-status", "done");
  await page.getByTestId("subagent-card").locator(":scope > summary").click();
  await expect(page.getByTestId("subagent-result")).toContainText("src/a.ts exports");
});
