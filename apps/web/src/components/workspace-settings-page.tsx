import { AgentPermissionSettings } from "@/components/agent-permission-settings"
import { DefaultSettings } from "@/components/default-settings"
import { FontSizeSettings, TreeFontSizeSettings } from "@/components/font-size-settings"
import { KeybindingSettings } from "@/components/keybinding-settings"
import { WorkspaceHarnessSettings } from "@/components/workspace-harness-settings"
import { WorkspaceMembersSettings } from "@/components/workspace-members-settings"
import { WorkspaceSharingSettings } from "@/components/workspace-sharing-settings"
import type { WorkspaceSettingsPageId } from "@/lib/sections"
import type { Workspace } from "@/lib/session"

/**
 * The body of one Workspace Settings page, for the active workspace.
 *
 * Like `SettingsPage`, which page is a matter of the URL. What can be
 * changed is a matter of the caller's role: every page renders for every
 * member, and the controls a role cannot use are left out rather than
 * refused after the click.
 */
export function WorkspaceSettingsPage({
  page,
  workspace,
  currentUserId,
  projects,
}: {
  page: WorkspaceSettingsPageId
  workspace: Workspace
  currentUserId: string
  /** The workspace's projects: a sign-in terminal needs one to publish on. */
  projects: { id: string; name: string }[]
}) {
  switch (page) {
    case "general":
      return (
        <div className="flex flex-col gap-4">
          <DefaultSettings />
          <AgentPermissionSettings />
          <KeybindingSettings />
          <FontSizeSettings />
          <TreeFontSizeSettings />
        </div>
      )
    case "members":
      return <WorkspaceMembersSettings workspace={workspace} currentUserId={currentUserId} />
    case "sharing":
      return <WorkspaceSharingSettings workspace={workspace} />
    case "harness":
      return <WorkspaceHarnessSettings workspace={workspace} projects={projects} />
  }
}
