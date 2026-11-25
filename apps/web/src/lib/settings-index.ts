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
 * Every settings page, in the groups the settings nav shows them in.
 *
 * Account settings (`/setting/{id}`) follow the person; workspace settings
 * (`/{ws}/workspace-settings/{id}`) belong to the workspace. The nav lists
 * only the tree it is in (`settingsGroups`); the command palette lists both.
 */
export type SettingsEntry =
  | { scope: "account"; id: SettingsPageId; keywords: string }
  | { scope: "workspace"; id: WorkspaceSettingsPageId; keywords: string };

export type SettingsScope = SettingsEntry["scope"];

export interface SettingsGroup {
  label: string | null;
  entries: readonly SettingsEntry[];
}

const ACCOUNT_GROUPS: readonly SettingsGroup[] = [
  {
    label: "Account",
    entries: [
      { scope: "account", id: "account", keywords: "profile name email avatar password github sign in" },
      {
        scope: "account",
        id: "preferences",
        keywords: "general default model permission mode access keybindings shortcuts vim font size editor tree chat view transcript debug diff commands widget follow-up sendprompt",
      },
      {
        scope: "account",
        id: "theme",
        keywords: "theme colour color accent hue dark light system contrast syntax presets palette",
      },
      { scope: "account", id: "api", keywords: "api keys resend secrets email" },
      { scope: "account", id: "usage", keywords: "usage tokens cost storage quota" },
      { scope: "account", id: "activity", keywords: "activity log audit history" },
    ],
  },
  {
    label: "Agents",
    entries: [
      { scope: "account", id: "providers", keywords: "providers ai git github gitlab gitea token repository claude codex sign in login cli custom api keys openrouter anonrouter model keys" },
    ],
  },
];

const WORKSPACE_GROUPS: readonly SettingsGroup[] = [
  {
    label: "Workspace",
    entries: [
      {
        scope: "workspace",
        id: "general",
        keywords: "terminal terminals limit per project browser tabs per session settled sessions delete data",
      },
      { scope: "workspace", id: "members", keywords: "members roles invite people permissions" },
      { scope: "workspace", id: "sharing", keywords: "sharing invite link public access" },
    ],
  },
  {
    label: "Agents",
    entries: [
      { scope: "workspace", id: "harness", keywords: "harness subscription claude codex shared login widgets interactive visual chart diagram" },
    ],
  },
];

/** The groups of one settings tree. */
export function settingsGroups(scope: SettingsScope): readonly SettingsGroup[] {
  return scope === "account" ? ACCOUNT_GROUPS : WORKSPACE_GROUPS;
}

/** Every settings page of both trees, for the command palette. */
export const SETTINGS_ENTRIES: readonly SettingsEntry[] = [...ACCOUNT_GROUPS, ...WORKSPACE_GROUPS].flatMap(
  (group) => group.entries,
);

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
