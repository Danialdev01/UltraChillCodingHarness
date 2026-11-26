import { expect, test } from "@playwright/test";

import { deliberationPlayback, ZERO } from "./deliberation-playback";
import { COOKIE, newThread } from "./omp-thread";

/**
 * `@council` in the chat (plan4 §4.3): the card stands where the held turn
 * waits, fills in round by round, concludes above the moderator's answer,
 * stops on Stop, and is drawn again after a reload. Played back, like
 * `peer-review.spec.ts`:
 *
 *   pnpm --filter @ucch/web e2e council
 */
test("a council is a card of seats and rounds above the moderator's answer", async ({ page, context, baseURL }, testInfo) => {
  const origin = new URL(baseURL!).origin;
  const { threadId, href } = await newThread(origin, "council spec");
  const playback = await deliberationPlayback(page, threadId);
  await context.addCookies([{ name: "ucch_session", value: COOKIE, domain: new URL(baseURL!).hostname, path: "/" }]);
  await page.goto(href);
  await expect.poll(playback.subscriptions).toBeGreaterThan(0);

  const composer = page.locator("textarea[role=combobox]");
  await expect(composer).toBeEnabled({ timeout: 30_000 });
  // A council needs a question.
  await composer.fill("@council");
  await expect(page.getByTestId("directive-error")).toHaveText("Ask the council a question");
  await composer.fill("");

  const deliberationId = "66666666-6666-4666-8666-666666666666";
  const held = "88888888-8888-4888-8888-888888888888";
  const seat = (letter: string, model: string, provider: "claude" | "codex", n: number) => ({
    seat: letter,
    subagentId: `s${n}`,
    childThreadId: `9999999${n}-9999-4999-8999-999999999999`,
    childHash: `seatseat0${n}`,
    model,
    provider,
    reason: "best available from its vendor",
  });
  const position = (round: number, letter: string, recommendation: string, changed = false) => ({
    type: "agent.council_position" as const,
    threadId,
    deliberationId,
    round,
    seat: letter,
    recommendation,
    confidence: 0.85,
    reasons: ["one store to run"],
    risks: ["session reads under load"],
    changed,
  });
  playback.publish([
    { type: "user.message", threadId, text: "should sessions move to Redis?", directives: { council: { models: [], size: 3, rounds: 1, implement: false } } },
    {
      type: "agent.council_started",
      threadId,
      deliberationId,
      turnId: held,
      members: [seat("A", "claude-opus-5-5", "claude", 1), seat("B", "gpt-6.1-sol", "codex", 2), seat("C", "claude-sonnet-5-5", "claude", 3)],
      rounds: 1,
      question: "should sessions move to Redis?",
    },
    position(0, "A", "Stay on Postgres"),
    position(0, "B", "Move to Redis"),
  ]);
  const card = page.getByTestId("council-card");
  await expect(card).toHaveAttribute("data-status", "running");
  await expect(card.getByTestId("council-member")).toHaveCount(3);
  await expect(card.getByTestId("council-member").nth(2)).toHaveAttribute("data-status", "thinking");
  await card.getByTestId("council-stop").click();
  await expect.poll(() => playback.dispatched.map((c) => c.type)).toContain("thread.deliberation_cancel");

  playback.publish([
    position(0, "C", "Stay on Postgres"),
    position(1, "A", "Stay on Postgres"),
    position(1, "B", "Stay on Postgres", true),
    position(1, "C", "Stay on Postgres"),
    { type: "agent.council_concluded", threadId, deliberationId, consensus: "unanimous", recommendation: "Stay on Postgres", dissent: [], roundsRun: 1, costUsd: 0.9 },
    { type: "turn.started", threadId, turnId: held, provider: "claude" },
    { type: "agent.text_delta", threadId, turnId: held, text: "The council agreed: stay on Postgres." },
    { type: "agent.turn_completed", threadId, turnId: held, stopReason: "end_turn", usage: ZERO, costUsd: 0 },
  ]);
  await expect(card).toHaveAttribute("data-status", "completed");
  await expect(card.getByTestId("council-consensus")).toHaveText("Unanimous");
  await expect(card.getByTestId("council-round")).toHaveCount(2);
  await expect(card).toContainText("changed position");
  // The card sits above the moderator's answer.
  const cardBox = await card.boundingBox();
  const answer = page.getByText("The council agreed: stay on Postgres.");
  await expect(answer).toBeVisible();
  expect((await answer.boundingBox())!.y).toBeGreaterThan(cardBox!.y);

  // At phone width the member strip wraps rather than overflowing.
  await page.setViewportSize({ width: 375, height: 800 });
  const overflow = await card.evaluate((el) => el.scrollWidth - el.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  await card.screenshot({ path: testInfo.outputPath("council-card-375.png") });
  await page.emulateMedia({ colorScheme: "light" });
  await card.screenshot({ path: testInfo.outputPath("council-card-375-light.png") });

  await page.reload();
  await expect(page.getByTestId("council-card")).toHaveAttribute("data-status", "completed", { timeout: 30_000 });
  await expect(page.getByTestId("council-round")).toHaveCount(2);
});
