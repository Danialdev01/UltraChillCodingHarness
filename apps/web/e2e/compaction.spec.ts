import { expect, test } from "@playwright/test";

import { COOKIE, dispatch, newThread } from "./omp-thread";

/**
 * A compaction mid-turn draws as a divider in the answer (OMP OM4.1), and
 * the context meter drops with it (OM4.2).
 *
 * The server must run OMP turns on the replay of a compacting turn, with no
 * network: `OMP_ENABLED=true`, `OMP_BIN=scripts/load/fake-omp-compaction.sh`,
 * and an OpenRouter key saved for the dev user (any value: nothing calls
 * OpenRouter). Then:
 *
 *   pnpm --filter @ucch/web e2e compaction
 *
 * It opens a new session in the first project it can see and sends one
 * message on the Custom provider (`native`), which OMP_ENABLED routes to
 * OMP. The message goes over the socket rather than through the composer,
 * so the account's default provider does not decide which engine answers.
 */

test("a compaction mid-turn is a divider with its figures", async ({ page, context, baseURL }) => {
  const origin = new URL(baseURL!).origin;
  const { threadId, href } = await newThread(origin, "compaction spec");
  await context.addCookies([{ name: "ucch_session", value: COOKIE, domain: new URL(baseURL!).hostname, path: "/" }]);
  await page.goto(href);
  // Loaded and listening before the turn starts, so it is drawn live.
  await expect(page.locator("textarea[role=combobox]")).toBeEnabled({ timeout: 30_000 });
  await dispatch(origin, "compaction-spec-send", { type: "thread.send", threadId, text: "Fourth question.", provider: "native" });

  const divider = page.getByTestId("compaction-divider");
  await expect(divider).toBeVisible({ timeout: 60_000 });
  // The recording's own figures: OMP's `soft` method, 7383 -> 7363 tokens.
  await expect(divider).toContainText("Context compacted (soft) · 7k → 7k tokens");
  // Collapsed: the summary is a click away.
  const summary = divider.getByText("Summary: the session so far.", { exact: false });
  await expect(summary).toBeHidden();
  await divider.locator("summary").click();
  await expect(summary).toBeVisible();

  // The meter reads the session's own measure (OMP OM4.2), which the
  // compaction cut: fake-omp's 1280 tokens after the model call, a quarter
  // of that after -- not the turn's usage, and not the catalogue's window.
  await expect(page.locator('button[title^="Context "]')).toHaveAttribute("title", /\(320 \/ 200k tokens\)/, { timeout: 15_000 });

  // And it stays where it was once the page is drawn from the log.
  await page.reload();
  await expect(page.getByTestId("compaction-divider")).toContainText("Context compacted (soft)", { timeout: 30_000 });
});
