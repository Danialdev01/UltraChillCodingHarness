import { expect, test } from "@playwright/test";

import { deliberationPlayback, ZERO } from "./deliberation-playback";
import { COOKIE, newThread } from "./omp-thread";

/**
 * `@reviewer` in the chat (plan4 §4.1, §4.2): the composer offers it, the
 * review is a card under the answer, "Ask agent to fix" and Stop send
 * their commands, and a reload draws the card again from the log.
 *
 * The thread's events are played back (`deliberation-playback.ts`), so the
 * spec needs only the dev API with DEV_AUTH_BYPASS:
 *
 *   pnpm --filter @ucch/web e2e peer-review
 */
test("a review is a card with findings, sends a fix, and survives a reload", async ({ page, context, baseURL }, testInfo) => {
  const origin = new URL(baseURL!).origin;
  const { threadId, href } = await newThread(origin, "peer review spec");
  const playback = await deliberationPlayback(page, threadId);
  await context.addCookies([{ name: "ucch_session", value: COOKIE, domain: new URL(baseURL!).hostname, path: "/" }]);
  await page.goto(href);
  await expect.poll(playback.subscriptions).toBeGreaterThan(0);

  // The composer: `@rev` offers the Reviewer, which opens the model step.
  const composer = page.locator("textarea[role=combobox]");
  await expect(composer).toBeEnabled({ timeout: 30_000 });
  await composer.fill("add input validation @rev");
  await expect(page.getByRole("option", { name: /Reviewer/ })).toBeVisible();
  await page.getByRole("option", { name: /Reviewer/ }).click();
  await expect(composer).toHaveValue("add input validation @reviewer()");
  await expect(page.getByRole("option", { name: /Auto \(best available\)/ })).toBeVisible();
  // A bad mention is refused before it is sent, with the parser's reason.
  await composer.fill("@reviewer(1)");
  await expect(page.getByTestId("directive-error")).toContainText("@reviewer takes model names and fix");
  await expect(page.getByTestId("composer-send")).toBeDisabled();
  await composer.fill("");

  const turnId = "33333333-3333-4333-8333-333333333333";
  const deliberationId = "66666666-6666-4666-8666-666666666666";
  const reviewer = {
    subagentId: "r1",
    childThreadId: "77777777-7777-4777-8777-777777777777",
    childHash: "abcdefghij",
    model: "gpt-6.1-sol",
    provider: "codex" as const,
    reason: "different vendor from the author",
  };
  playback.publish([
    { type: "user.message", threadId, text: "add input validation", directives: { reviewer: { models: [], fix: false, previous: false } } },
    { type: "turn.started", threadId, turnId, provider: "claude" },
    { type: "agent.text_delta", threadId, turnId, text: "Validation added." },
    { type: "agent.turn_completed", threadId, turnId, stopReason: "end_turn", usage: ZERO, costUsd: 0 },
    { type: "agent.peer_review_started", threadId, deliberationId, targetTurnId: turnId, reviewers: [reviewer], fix: false },
  ]);
  const card = page.getByTestId("peer-review-card");
  await expect(card).toHaveAttribute("data-status", "running");
  await expect(card).toContainText("gpt-6.1-sol");
  await card.getByTestId("peer-review-stop").click();
  await expect.poll(() => playback.dispatched.map((c) => c.type)).toContain("thread.deliberation_cancel");

  playback.publish([
    {
      type: "agent.peer_review_completed",
      threadId,
      deliberationId,
      subagentId: "r1",
      verdict: "changes_requested",
      summary: "The email check accepts an empty string.",
      findings: [
        { id: "f1", severity: "major", file: "src/signup.ts", line: 12, title: "Empty email accepted", detail: "`z.string()` without `.min(1)`." },
        { id: "f2", severity: "minor", title: "No test for the error", detail: "…" },
        { id: "f3", severity: "nit", title: "Naming", detail: "…" },
      ],
      costUsd: 0.21,
    },
    { type: "agent.peer_review_ended", threadId, deliberationId, status: "completed", costUsd: 0.21 },
  ]);
  await expect(card).toHaveAttribute("data-status", "completed");
  await expect(card.getByTestId("peer-review-verdict")).toHaveText("Changes requested");
  await expect(card.getByTestId("peer-review-finding")).toHaveCount(3);
  // Nits are not sent; one unchecked finding leaves one to send.
  await expect(card.getByTestId("peer-review-fix")).toHaveText("Ask agent to fix (2)");
  await card.getByRole("checkbox", { name: /No test for the error/ }).uncheck();
  await card.screenshot({ path: testInfo.outputPath("peer-review-card.png") });
  await card.getByTestId("peer-review-fix").click();
  await expect
    .poll(() => playback.dispatched.find((c) => c.type === "thread.peer_review_fix"))
    .toMatchObject({ peerReviewId: deliberationId, findingIds: ["f1"] });

  // The fix turn's message names who sent it.
  playback.publish([{ type: "user.message", threadId, text: "Fix: Empty email accepted", peerReviewId: deliberationId }]);
  await expect(page.getByTestId("reviewer-message")).toContainText("From Reviewer (gpt-6.1-sol)");

  await page.reload();
  await expect(page.getByTestId("peer-review-card")).toHaveAttribute("data-status", "completed", { timeout: 30_000 });
  await expect(page.getByTestId("peer-review-finding")).toHaveCount(3);
});
