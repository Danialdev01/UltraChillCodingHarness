import { describe, expect, it } from "vitest";
import { COALESCE_WINDOW_MS, mergeDetails, textDelta, withinWindow } from "./audit.js";
import { SELF_AUDITED, describeRoute } from "./route-audit.js";

describe("mergeDetails", () => {
  it("adds the running totals and keeps the first `from`", () => {
    expect(
      mergeDetails(
        { charsAdded: 3, charsRemoved: 1, from: "Old", to: "Mid", fields: ["title"] },
        { charsAdded: 5, charsRemoved: 0, from: "Mid", to: "New", fields: ["content"] },
      ),
    ).toEqual({ charsAdded: 8, charsRemoved: 1, from: "Old", to: "New", fields: ["content"] });
  });
});

describe("withinWindow", () => {
  it("folds saves made within the window and not after", () => {
    const now = new Date("2026-10-03T12:00:00Z");
    expect(withinWindow(new Date(now.getTime() - 1000), now)).toBe(true);
    expect(withinWindow(new Date(now.getTime() - COALESCE_WINDOW_MS), now)).toBe(false);
  });
});

describe("textDelta", () => {
  it("counts what differs between the common start and end", () => {
    expect(textDelta("hello world", "hello brave world")).toEqual({ charsAdded: 6, charsRemoved: 0 });
    expect(textDelta("hello brave world", "hello world")).toEqual({ charsAdded: 0, charsRemoved: 6 });
    expect(textDelta("abc", "abc")).toEqual({ charsAdded: 0, charsRemoved: 0 });
    expect(textDelta("", "new")).toEqual({ charsAdded: 3, charsRemoved: 0 });
    expect(textDelta("aaa", "aa")).toEqual({ charsAdded: 0, charsRemoved: 1 });
  });
});

describe("describeRoute", () => {
  it("skips reads, self-logging routes and ignored ones", () => {
    expect(describeRoute("GET", "/api/projects/:hash/keys", {}, undefined)).toBeNull();
    expect(describeRoute("PATCH", "/api/projects/:hash/notes/:noteId", {}, {})).toBeNull();
    expect(describeRoute("POST", "/api/ws-ticket", {}, {})).toBeNull();
  });

  it("names a key by its name and never by its value", () => {
    const change = describeRoute("POST", "/api/projects/:hash/keys", { hash: "abc" }, { name: "Stripe", value: "sk_live_secret" });
    expect(change).toMatchObject({ action: "key.create", scope: "project", resource: "keys" });
    expect(JSON.stringify(change)).not.toContain("sk_live_secret");
  });

  it("puts account settings on the account", () => {
    expect(describeRoute("PUT", "/api/settings/openrouter", {}, { key: "sk-or-secret" })).toMatchObject({
      scope: "account",
      resource: "account_settings",
    });
  });

  it("describes the database manager's routes from their shape", () => {
    expect(
      describeRoute("DELETE", "/api/database-connections/:id/db/:db/tables/:table/rows", { id: "c", db: "shop", table: "orders" }, {}),
    ).toMatchObject({ summary: "Deleted rows from shop.orders", scope: "account" });
  });

  it("still logs a write nobody described", () => {
    expect(describeRoute("POST", "/api/projects/:hash/something-new", {}, {})).toMatchObject({
      scope: "project",
      targetType: "route",
    });
  });
});

describe("describeRoute: what other tabs refetch", () => {
  it("tells them to refetch git state after any git route", () => {
    for (const route of ["stage", "unstage", "discard", "commit", "checkout", "pull", "push", "merge/abort"]) {
      expect(describeRoute("POST", `/api/projects/:hash/git/${route}`, { hash: "h" }, {})?.resource, route).toBe("git");
    }
  });

  it("names the table a database manager write touched", () => {
    expect(
      describeRoute("PATCH", "/api/database-connections/:id/db/:db/tables/:table/rows", { id: "c", db: "shop", table: "orders" }, {}),
    ).toMatchObject({ resource: "database_data", targetId: "c/shop/orders", summary: "Updated rows in shop.orders" });
  });

  it("leaves the table off a database-wide write", () => {
    expect(describeRoute("POST", "/api/database-connections/:id/db/:db/sql", { id: "c", db: "shop" }, {})).toMatchObject({
      resource: "database_data",
      targetId: "c/shop/",
    });
  });

  it("does not describe what logs itself", () => {
    for (const key of SELF_AUDITED) {
      const [method, url] = key.split(" ");
      expect(describeRoute(method!, url, {}, {}), key).toBeNull();
    }
  });
});
