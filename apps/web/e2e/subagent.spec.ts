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

  // Subagents sit on the page under a "N subagents" line, not folded
  // into the turn's work.
  await expect(page.getByTestId("subagent-group")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId("subagent-group")).toContainText("1 subagent");

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
  await expect(page.getByTestId("subagent-group")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("subagent-card")).toHaveAttribute("data-status", "done");
  await page.getByTestId("subagent-card").locator(":scope > summary").click();
  await expect(page.getByTestId("subagent-result")).toContainText("src/a.ts exports");
});

// Replay real native v2 records through the provider adapter, then stream the
// resulting protocol frames through the application's normal socket/reducer/UI.
// Only the new test thread's subscription is replaced; app/auth/navigation stay real.
import { readFileSync } from "node:fs";
import type { Page, WebSocketRoute } from "@playwright/test";
import { isTransient, type DomainEvent } from "../../../packages/protocol/src/index";
import { CodexSubagents } from "../../../packages/providers/src/codex-subagents";

const nativeFixture = (name: string): any[] => readFileSync(new URL(`../../../tests/fixtures/codex-0.167.0/${name}.jsonl`, import.meta.url), "utf8").trim().split("\n").map(line => JSON.parse(line));

async function nativePlayback(page: Page, threadId: string) {
  const history: { seq: number; at: string; event: DomainEvent }[] = [];
  let connection: WebSocketRoute | undefined;
  let subscription = "";
  let subscriptions = 0;
  let handleSend: ((command: any) => DomainEvent[]) | undefined;
  await page.routeWebSocket(/\/ws\?/, socket => {
    const server = socket.connectToServer();
    socket.onMessage(data => {
      const frame = JSON.parse(String(data));
      if (frame.kind === "subscribe" && frame.topic.name === "thread" && frame.topic.threadId === threadId) {
        connection = socket; subscription = frame.id; subscriptions++;
        socket.send(JSON.stringify({ kind: "replay", subscriptionId: frame.id, events: history.filter(row => row.seq > (frame.sinceSeq ?? -1)), done: true }));
        socket.send(JSON.stringify({ kind: "ack", id: frame.id, events: [] }));
      } else if (frame.kind === "dispatch" && frame.command.type === "thread.send" && frame.command.threadId === threadId && handleSend) {
        try {
          const events = handleSend(frame.command);
          socket.send(JSON.stringify({ kind: "ack", id: frame.id, events: [] }));
          publish(events);
        } catch (error) { socket.send(JSON.stringify({ kind: "error", id: frame.id, code: "conflict", message: error instanceof Error ? error.message : String(error) })); }
      } else server.send(data);
    });
  });
  const publish = (events: DomainEvent[]) => {
    for (const event of events) {
      const at = new Date().toISOString();
      const seq = isTransient(event.type) ? null : history.length;
      if (seq !== null) history.push({ seq, at, event });
      connection!.send(JSON.stringify({ kind: "push", subscriptionId: subscription, seq, at, event }));
    }
  };
  return { publish, onSend: (handler: (command: any) => DomainEvent[]) => { handleSend = handler; }, subscriptions: () => subscriptions, disconnect: () => connection!.close({ code: 1012, reason: "fixture reconnect" }) };
}

test("Codex native children stream into shared cards and reconstruct on reload and reconnect", async ({ page, context, baseURL }, testInfo) => {
  const origin = new URL(baseURL!).origin;
  const { threadId, href } = await newThread(origin, "Codex native fixture");
  const turnId = "33333333-3333-4333-8333-333333333333";
  const agents = new CodexSubagents({ threadId, turnId });
  const playback = await nativePlayback(page, threadId);
  const { publish } = playback;
  const feed = (records: any[]) => publish(records.flatMap(row => agents.parentRollout(JSON.stringify(row))));
  await context.addCookies([{ name: "ucch_session", value: COOKIE, domain: new URL(baseURL!).hostname, path: "/" }]);
  await page.goto(href);
  await expect.poll(playback.subscriptions).toBeGreaterThan(0);
  publish([{ type: "user.message", threadId, text: "Run Alpha and Beta" }, { type: "turn.started", threadId, turnId, provider: "codex" }]);
  const rows = nativeFixture("parent");
  feed(rows.filter(row => row.ordinal < 34));
  const group = page.getByTestId("subagent-group");
  const cards = page.getByTestId("subagent-card");
  await expect(group).toBeVisible();
  await expect(group).toContainText("2 subagents");
  await expect(group).toContainText("2 working");
  await expect(cards).toHaveCount(2);
  await expect(cards.nth(0)).toHaveAttribute("data-status", "running");
  await expect(cards.nth(0).locator(":scope > summary")).toContainText("alpha");
  await expect(cards.nth(1).locator(":scope > summary")).toContainText("beta");
  await page.screenshot({ path: testInfo.outputPath("codex-subagents-active.png"), fullPage: true });

  // Progress belongs to the worker while its parent's turn is still open.
  const id = [...agents.children.keys()][0]!;
  publish(nativeFixture("alpha").filter(row => row.ordinal <= 26).flatMap(row => agents.rollout(id, JSON.stringify(row))));
  await expect(cards.nth(0).getByTestId("subagent-summary")).toContainText("ALPHA_OK");
  feed(rows.filter(row => row.ordinal >= 34));
  await expect(cards.nth(0)).toHaveAttribute("data-status", "done");
  await expect(cards.nth(1)).toHaveAttribute("data-status", "done");
  await expect(group).toContainText("2 done");
  publish([{ type: "agent.turn_completed", threadId, turnId, stopReason: "end_turn", usage: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 }, costUsd: 0 }]);
  await cards.nth(0).locator(":scope > summary").click();
  await expect(cards.nth(0).getByTestId("subagent-result")).toContainText("ALPHA_AGAIN");
  await expect(cards.nth(0).getByTestId("subagent-run")).toHaveAttribute("data-provider", "codex");
  await expect(cards.nth(0).getByTestId("subagent-run")).toContainText("gpt-6.1-sol");
  await page.screenshot({ path: testInfo.outputPath("codex-subagents-completed.png"), fullPage: true });
  await testInfo.attach("Codex subagents", { path: testInfo.outputPath("codex-subagents-completed.png"), contentType: "image/png" });

  const beforeReload = playback.subscriptions();
  await page.reload();
  await expect.poll(playback.subscriptions).toBeGreaterThan(beforeReload);
  await expect(cards).toHaveCount(2);
  await expect(cards.nth(0)).toHaveAttribute("data-status", "done");
  await cards.nth(0).locator(":scope > summary").click();
  await expect(cards.nth(0).getByTestId("subagent-result")).toContainText("ALPHA_AGAIN");
  await expect(cards.nth(0).getByTestId("subagent-run")).toContainText("gpt-6.1-sol");
  const beforeReconnect = playback.subscriptions();
  playback.disconnect();
  await expect.poll(playback.subscriptions, { timeout: 30_000 }).toBeGreaterThan(beforeReconnect);
  await expect(cards).toHaveCount(2);
  await expect(cards.nth(1)).toHaveAttribute("data-status", "done");
});

test("Codex native failure and interruption remain distinct in shared cards", async ({ page, context, baseURL }, testInfo) => {
  const origin = new URL(baseURL!).origin;
  const { threadId, href } = await newThread(origin, "Codex terminal states");
  const turnId = "33333333-3333-4333-8333-333333333333";
  const agents = new CodexSubagents({ threadId, turnId });
  const playback = await nativePlayback(page, threadId);
  await context.addCookies([{ name: "ucch_session", value: COOKIE, domain: new URL(baseURL!).hostname, path: "/" }]);
  await page.goto(href);
  await expect.poll(playback.subscriptions).toBeGreaterThan(0);
  playback.publish([{ type: "user.message", threadId, text: "Check worker outcomes" }, { type: "turn.started", threadId, turnId, provider: "codex" }]);
  playback.publish(nativeFixture("parent").filter(row => row.ordinal < 34).flatMap(row => agents.parentRollout(JSON.stringify(row))));
  const group = page.getByTestId("subagent-group");
  const cards = page.getByTestId("subagent-card");
  await expect(group).toContainText("2 working");
  // Error variant of a captured list_agents envelope; the interruption value
  // is captured, while the error value deliberately exercises failure handling.
  const status = nativeFixture("interruption").find(row => row.payload.name === "list_agents");
  const result = { ...status, ordinal: 10001, payload: { type: "function_call_output", call_id: status.payload.call_id,
    output: JSON.stringify({ agents: [{ agent_name: "/root/alpha", agent_status: { errored: "Fixture worker failed" } }, { agent_name: "/root/beta", agent_status: "interrupted" }] }) } };
  playback.publish([status, result].flatMap(row => agents.parentRollout(JSON.stringify({ ...row, timestamp: "2026-11-10T08:18:30Z", ordinal: row === status ? 10000 : 10001 }))));
  playback.publish([{ type: "agent.turn_completed", threadId, turnId, stopReason: "end_turn", usage: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 }, costUsd: 0 }]);
  await expect(cards.nth(0)).toHaveAttribute("data-status", "failed");
  await expect(cards.nth(1)).toHaveAttribute("data-status", "aborted");
  await expect(group).toContainText("1 failed, 1 interrupted");
  await expect(group).not.toContainText("done");
  await cards.nth(0).locator(":scope > summary").focus();
  await page.keyboard.press("Enter");
  await expect(cards.nth(0).getByTestId("subagent-result")).toContainText("Fixture worker failed");
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(group).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("codex-subagents-terminal-mobile.png"), fullPage: true });
  await page.reload();
  await expect(cards).toHaveCount(2);
  await expect(cards.nth(0)).toHaveAttribute("data-status", "failed");
  await expect(cards.nth(1)).toHaveAttribute("data-status", "aborted");
});

test("Codex native agent page has its task context and an isolated working chat", async ({ page, context, baseURL }, testInfo) => {
  const origin = new URL(baseURL!).origin;
  const { threadId, href } = await newThread(origin, "Native child chat");
  const turnId = "33333333-3333-4333-8333-333333333333";
  const nextTurn = "44444444-4444-4444-8444-444444444444";
  const agents = new CodexSubagents({ threadId, turnId });
  const playback = await nativePlayback(page, threadId);
  await context.addCookies([{ name: "ucch_session", value: COOKIE, domain: new URL(baseURL!).hostname, path: "/" }]);
  await page.goto(href);
  await expect.poll(playback.subscriptions).toBeGreaterThan(0);
  playback.publish([{ type: "user.message", threadId, text: "Maintain the current cache task" }, { type: "turn.started", threadId, turnId, provider: "codex" }]);
  const records = nativeFixture("parent");
  playback.publish(records.flatMap(row => agents.parentRollout(JSON.stringify(row))));
  playback.publish([{ type: "agent.turn_completed", threadId, turnId, stopReason: "end_turn", usage: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 }, costUsd: 0 }]);
  const id = [...agents.children.keys()][0]!;
  const call = records.find(row => row.ordinal === 18).payload.call_id;
  await page.goto(`${href}?agent=${encodeURIComponent(`${call}:${id}`)}`);
  await expect(page.getByTestId("subagent-prompt")).toContainText("Maintain the current cache task");
  await expect(page.getByTestId("subagent-prompt")).not.toContainText("Not recorded");
  await expect(page.getByTestId("subagent-prompt")).toContainText("Parent request");
  const conversation = page.getByTestId("subagent-conversation");
  await expect(conversation).toContainText("ALPHA_AGAIN");
  await expect(conversation).not.toContainText("BETA_OK");
  const composer = page.getByRole("textbox", { name: "Message alpha", exact: true });
  await expect(composer).toBeVisible();
  let attempts = 0;
  playback.onSend(command => {
    expect(command.subagentId).toBe(id);
    expect(command.provider).toBe("codex");
    expect(command.text).toBe("Change your current task and explain the edit");
    if (++attempts === 1) throw new Error("Worker is busy; retry");
    return [{ type: "user.message", threadId, subagentId: id, text: command.text }, { type: "turn.started", threadId, turnId: nextTurn, provider: "codex" },
      { type: "agent.subagent_started", threadId, turnId: nextTurn, subagentId: id, parentToolUseId: call, agent: "alpha", provider: "codex", model: null, description: null },
      { type: "agent.tool_use", threadId, turnId: nextTurn, subagentId: id, toolUseId: "child-edit", name: "apply_patch", input: { patch: "Update cache task" } },
      { type: "agent.tool_result", threadId, turnId: nextTurn, toolUseId: "child-edit", content: "Updated cache.ts", isError: false, durationMs: 10 },
      { type: "agent.subagent_output", threadId, turnId: nextTurn, subagentId: id, kind: "text", text: "I updated the current task and edited cache.ts." },
      { type: "agent.subagent_finished", threadId, turnId: nextTurn, subagentId: id, status: "completed", result: "I updated the current task and edited cache.ts." },
      { type: "agent.turn_completed", threadId, turnId: nextTurn, stopReason: "end_turn", usage: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 }, costUsd: 0 }];
  });
  await composer.fill("Change your current task and explain the edit");
  await composer.press("Enter");
  await expect(page.getByTestId("subagent-composer").getByRole("alert")).toContainText("Worker is busy");
  await expect(composer).toHaveValue("Change your current task and explain the edit");
  await composer.press("Enter");
  await expect(conversation).toContainText("Change your current task and explain the edit");
  await expect(conversation).toContainText("I updated the current task and edited cache.ts.");
  await expect(composer).toHaveValue("");
  await page.reload();
  await expect(conversation).toContainText("Change your current task and explain the edit");
  await expect(conversation).toContainText("I updated the current task and edited cache.ts.");
  await page.screenshot({ path: testInfo.outputPath("subagent-chat.png"), fullPage: true });
});
