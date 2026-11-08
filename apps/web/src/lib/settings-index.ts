import type { LucideIcon } from "lucide-react";

import {
  settingsPageById,
  settingsPageHref,
  workspaceSettingsPageById,
  workspaceSettingsPageHref,
  type SettingsPageId,
  type WorkspaceSettingsPageId,
} from "@/lib/sections";

/**
 * Every settings page, account and workspace alike, in the groups the
 * settings nav shows them in.
 *
 * Which tree a page lives in -- `/setting/{id}` or
 * `/{ws}/workspace-settings/{id}` -- is a fact about where its data is kept.
 * Someone looking for a setting should not have to know it, so the nav, its
 * search and the command palette all read this one list.
 */
export type SettingsEntry =
  | { scope: "account"; id: SettingsPageId; keywords: string }
  | { scope: "workspace"; id: WorkspaceSettingsPageId; keywords: string };

export const SETTINGS_GROUPS: readonly { label: string | null; entries: readonly SettingsEntry[] }[] = [
  {
    label: null,
    entries: [
      {
        scope: "workspace",
        id: "general",
        keywords: "default model permission mode access keybindings shortcuts vim font size editor tree chat view transcript debug diff commands",
      },
      {
        scope: "account",
        id: "theme",
        keywords: "theme colour color accent hue dark light system contrast syntax presets palette",
      },
    ],
  },
  {
    label: "Account",
    entries: [
      { scope: "account", id: "account", keywords: "profile name email avatar password github sign in" },
      { scope: "account", id: "api", keywords: "api keys openrouter resend github tokens secrets" },
      { scope: "account", id: "usage", keywords: "usage tokens cost storage quota" },
      { scope: "account", id: "activity", keywords: "activity log audit history" },
    ],
  },
  {
    label: "Agents",
    entries: [
      { scope: "account", id: "providers", keywords: "providers claude codex sign in login cli" },
      { scope: "workspace", id: "harness", keywords: "harness subscription claude codex shared login" },
    ],
  },
  {
    label: "Workspace",
    entries: [
      { scope: "workspace", id: "members", keywords: "members roles invite people permissions" },
      { scope: "workspace", id: "sharing", keywords: "sharing invite link public access" },
    ],
  },
];

export function settingsEntryTitle(entry: SettingsEntry): string {
  return settingsEntryPage(entry).title;
}

export function settingsEntryIcon(entry: SettingsEntry): LucideIcon {
  return settingsEntryPage(entry).icon;
}

function settingsEntryPage(entry: SettingsEntry) {
  return entry.scope === "account" ? settingsPageById(entry.id) : workspaceSettingsPageById(entry.id);
}

/** The entry's URL; a workspace page needs the workspace it is under. */
export function settingsEntryHref(entry: SettingsEntry, ws: string): string {
  return entry.scope === "account" ? settingsPageHref(entry.id) : workspaceSettingsPageHref(ws, entry.id);
}
