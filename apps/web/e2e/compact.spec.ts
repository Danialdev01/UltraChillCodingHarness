import { expect, test } from "@playwright/test";

import { COOKIE, dispatch, newThread } from "./omp-thread";

/**
 * Compact and Hand off on an idle OMP thread (OMP OM4.3): `/compact` and
 * `/handoff` in the composer fold the session between turns, draw a divider
 * under the last answer, and shrink the context the meter shows.
 *
 * The server runs as for `compaction.spec.ts` (`OMP_ENABLED=true`,
 * `OMP_BIN=scripts/load/fake-omp-compaction.sh`, an OpenRouter key saved for
 * the dev user). fake-omp's context: the turn ends on 320 tokens, a
 * compact cuts it to 80, a handoff to 20.
 *
 *   pnpm --filter @ucch/web e2e compact.spec
 */

test("compact and hand off between turns", async ({ page, context, baseURL }) => {
  const origin = new URL(baseURL!).origin;
  const { threadId, href } = await newThread(origin, "compact spec");
  await context.addCookies([{ name: "ucch_session", value: COOKIE, domain: new URL(baseURL!).hostname, path: "/" }]);
  await page.goto(href);
  const composer = page.locator("textarea[role=combobox]");
  await expect(composer).toBeEnabled({ timeout: 30_000 });

  // Not before the thread has run on OMP: there is no session to fold.
  const refused = await dispatch(origin, "compact-spec-early", { type: "thread.compact", threadId }).catch((e: Error) => e);
  expect(String(refused)).toMatch(/no conversation to compact yet/);

  await dispatch(origin, "compact-spec-send", { type: "thread.send", threadId, text: "Fourth question.", provider: "native" });
  const meter = page.locator('button[title^="Context "]');
  await expect(meter).toHaveAttribute("title", /\(320 \/ 200k tokens\)/, { timeout: 30_000 });
  await expect(composer).toBeEnabled({ timeout: 30_000 });
  const dividers = page.getByTestId("compaction-divider");
  await expect(dividers).toHaveCount(1);

  // `/compact` with what to keep: the menu's row, then Enter.
  await composer.fill("/compact the tests");
  await expect(page.getByText("Compact now")).toBeVisible();
  await composer.press("Enter");
  await expect(dividers).toHaveCount(2, { timeout: 30_000 });
  await expect(dividers.nth(1)).toContainText("Context compacted (soft) · 320 → 80 tokens");
  await dividers.nth(1).locator("summary").click();
  await expect(dividers.nth(1)).toContainText("Kept: the tests.");
  await expect(meter).toHaveAttribute("title", /\(80 \/ 200k tokens\)/);
  await expect(composer).toHaveValue("");

  // `/handoff` with nothing more: picked from the menu as it stands.
  await composer.fill("/handoff ");
  await expect(page.getByText("Hand off now")).toBeVisible();
  await composer.press("Enter");
  await expect(dividers).toHaveCount(3, { timeout: 30_000 });
  await expect(dividers.nth(2)).toContainText("Context compacted (handoff) · 80 → 20 tokens");
  await expect(meter).toHaveAttribute("title", /\(20 \/ 200k tokens\)/);

  // Both are logged: the dividers are still there drawn from the log.
  await page.reload();
  await expect(page.getByTestId("compaction-divider")).toHaveCount(3, { timeout: 30_000 });
});
