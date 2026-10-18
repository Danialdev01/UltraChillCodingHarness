"use client";

import * as React from "react";
import { FolderKanbanIcon, LayoutGridIcon, MessagesSquareIcon } from "lucide-react";

import {
  FIELD,
  FormDialog,
  FormDialogFooter,
  FormField,
  HELPER,
  OptionPanel,
  OptionTabs,
} from "@/components/form-dialog";
import type { WorkspaceKind } from "@/lib/session";

const KINDS = [
  { value: "project", title: "Project based", hint: "Projects with their own pages" },
  { value: "session", title: "Session based", hint: "Quick chats with files & terminal" },
] as const;

/**
 * Creating a workspace, as a controlled dialog.
 *
 * Extracted from the switcher because the quick menu opens it too, and two
 * copies of this form would be two places to keep the validation and the
 * post-create switch in sync. Drawn in the same shell as New Project, so the
 * two read as one family of dialogs.
 */
export function NewWorkspaceDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Receives the new workspace, so the caller can go to it. */
  onCreated: (workspace: { id: string; hash: string }) => void;
}) {
  const [name, setName] = React.useState("");
  const [kind, setKind] = React.useState<WorkspaceKind>("project");
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  // A fresh dialog every time, as New Project does.
  React.useEffect(() => {
    if (open) return;
    setName("");
    setKind("project");
    setError(null);
  }, [open]);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || name.trim().length === 0) return;
    setPending(true);
    setError(null);
    try {
      const response = await fetch("/api/workspaces", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ name, kind }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        // A 5xx with no JSON body is the Next proxy reporting the API is down.
        setError(
          body.error ??
            (response.status >= 500
              ? "Could not reach the server. Is it running?"
              : "Could not create the workspace."),
        );
        return;
      }
      const created = (await response.json()) as { id: string; hash: string };
      onOpenChange(false);
      onCreated(created);
    } catch {
      setError("Could not reach the server.");
    } finally {
      setPending(false);
    }
  }

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      busy={pending}
      icon={LayoutGridIcon}
      title="Create a new workspace"
      description="A workspace groups related work, like a company or a team."
      onSubmit={submit}
      footer={
        <FormDialogFooter
          hint={kind === "session" ? "Sessions open straight into chat" : "Projects get their own pages"}
          hintIcon={kind === "session" ? MessagesSquareIcon : FolderKanbanIcon}
          busy={pending}
          disabled={name.trim().length === 0}
        >
          {pending ? "Creating…" : "Create workspace"}
        </FormDialogFooter>
      }
    >
      <FormField label="Name" htmlFor="workspace-name" error={error}>
        <input
          id="workspace-name"
          className={FIELD}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Acme Inc"
          maxLength={60}
          autoFocus
          required
          disabled={pending}
        />
      </FormField>

      <OptionTabs
        label="Workspace type"
        value={kind}
        onChange={setKind}
        options={KINDS}
        disabled={pending}
      >
        <OptionPanel value="project">
          <p className={HELPER}>
            Each project is a codebase with its own chat, files, terminal, notes, tasks and
            settings. Start one by importing a repository or from an empty folder.
          </p>
        </OptionPanel>
        <OptionPanel value="session">
          <p className={HELPER}>
            Click New session and start talking. Each session is a single item in the sidebar
            with its own chat, files and terminal, titled from your first message.
          </p>
        </OptionPanel>
      </OptionTabs>
    </FormDialog>
  );
}

