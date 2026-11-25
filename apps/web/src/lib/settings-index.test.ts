import { describe, expect, it } from "vitest";

import { SETTINGS_PAGES, WORKSPACE_SETTINGS_PAGES } from "./sections";
import { settingsGroups } from "./settings-index";

describe("settingsGroups", () => {
  it.each([
    ["account", SETTINGS_PAGES],
    ["workspace", WORKSPACE_SETTINGS_PAGES],
  ] as const)("lists every %s page once, and no page of the other tree", (scope, pages) => {
    const entries = settingsGroups(scope).flatMap((group) => group.entries);
    expect(entries.every((entry) => entry.scope === scope)).toBe(true);
    expect(entries.map((entry) => entry.id).sort()).toEqual(pages.map((page) => page.id).sort());
  });
});
