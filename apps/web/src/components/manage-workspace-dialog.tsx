"use client";

import * as React from "react";
import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  GalleryVerticalEndIcon,
  ImageUpIcon,
  MessagesSquareIcon,
  Settings2Icon,
  Trash2Icon,
  XIcon,
} from "lucide-react";

import {
  FIELD,
  FormDialog,
  FormDialogFooter,
  FormField,
  HELPER,
  LABEL,
  SECONDARY_BUTTON,
} from "@/components/form-dialog";
import type { Workspace } from "@/components/workspace-switcher";
import { countLabel, logoDataUrl, updateWorkspace } from "@/lib/workspace-api";
import { cn } from "@/lib/utils";

/**
 * A workspace's settings: its name, logo, what kind it is, and the way out --
 * archive, or delete when there is nothing in it to lose.
 *
 * The leaving actions are handed back to the switcher rather than done here,
 * because what happens next (switching away from the active workspace, the
 * delete confirmation) is the switcher's to manage.
 */
export function ManageWorkspaceDialog({
  workspace,
  open,
  onOpenChange,
  onSaved,
  onArchive,
  onDelete,
}: {
  workspace: Workspace | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
  onArchive: (workspace: Workspace, archived: boolean) => void;
  onDelete: (workspace: Workspace) => void;
}) {
  const [name, setName] = React.useState("");
  const [logo, setLogo] = React.useState<string | null>(null);
  const [logoError, setLogoError] = React.useState<string | null>(null);
  const fileInput = React.useRef<HTMLInputElement>(null);
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!open) return;
    setName(workspace?.name ?? "");
    setLogo(workspace?.logo ?? null);
    setError(null);
    setLogoError(null);
  }, [open, workspace]);

  if (!workspace) return null;
  const current = workspace;
  const empty = current.projectCount === 0;
  const nameChanged = name.trim() !== current.name && name.trim().length > 0;
  const logoChanged = logo !== (current.logo ?? null);
  const unchanged = !nameChanged && !logoChanged;

  async function pickLogo(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    // Cleared so picking the same file again still fires a change.
    event.target.value = "";
    if (!file) return;
    setLogoError(null);
    try {
      setLogo(await logoDataUrl(file));
    } catch (e) {
      setLogoError(e instanceof Error ? e.message : "Could not read the image.");
    }
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || unchanged) return;
    setPending(true);
    setError(null);
    try {
      await updateWorkspace(current.id, {
        ...(nameChanged ? { name: name.trim() } : {}),
        ...(logoChanged ? { logo } : {}),
      });
      onOpenChange(false);
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save.");
    } finally {
      setPending(false);
    }
  }

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      busy={pending}
      icon={Settings2Icon}
      title="Manage workspace"
      description={`${current.kind === "session" ? "Session" : "Project"} based · ${countLabel(current)}`}
      onSubmit={submit}
      footer={
        <FormDialogFooter busy={pending} disabled={unchanged}>
          {pending ? "Saving…" : "Save changes"}
        </FormDialogFooter>
      }
    >
      <FormField label="Name" htmlFor="manage-workspace-name" error={error}>
        <input
          id="manage-workspace-name"
          className={FIELD}
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={60}
          required
          disabled={pending}
        />
      </FormField>

      <FormField
        label="Logo"
        htmlFor="manage-workspace-logo"
        helper="Shown in the workspace switcher. Cropped to a square."
        error={logoError}
      >
        <div className="flex items-center gap-3">
          <div className="flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-sidebar-primary text-sidebar-primary-foreground">
            {logo ? (
              // eslint-disable-next-line @next/next/no-img-element -- a data URL; next/image has nothing to optimise
              <img src={logo} alt="" className="size-full object-cover" />
            ) : current.kind === "session" ? (
              <MessagesSquareIcon className="size-4" />
            ) : (
              <GalleryVerticalEndIcon className="size-4" />
            )}
          </div>
          <input
            ref={fileInput}
            id="manage-workspace-logo"
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml"
            className="sr-only"
            onChange={pickLogo}
            disabled={pending}
          />
          <button
            type="button"
            className={SECONDARY_BUTTON}
            onClick={() => fileInput.current?.click()}
            disabled={pending}
          >
            <ImageUpIcon />
            {logo ? "Change" : "Upload"}
          </button>
          {logo && (
            <button
              type="button"
              className={SECONDARY_BUTTON}
              onClick={() => {
                setLogo(null);
                setLogoError(null);
              }}
              disabled={pending}
            >
              <XIcon />
              Remove
            </button>
          )}
        </div>
      </FormField>

      <div className="flex flex-col gap-1.5">
        <span className={LABEL}>Workspace type</span>
        <p className={HELPER}>
          {current.kind === "session"
            ? "Session based: each session is a chat with its own files and terminal."
            : "Project based: each project is a codebase with its own pages."}{" "}
          The type is set when the workspace is created.
        </p>
      </div>

      <div className="flex items-center justify-between gap-3 rounded-[8px] border border-(--fd-border) px-3 py-2.5">
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className={LABEL}>
            {current.archived ? "Restore workspace" : empty ? "Delete workspace" : "Archive workspace"}
          </span>
          <span className={HELPER}>
            {current.archived
              ? "Put it back in the workspace list."
              : empty
                ? "It has nothing in it, so it can be removed outright."
                : "Hide it from the list. Nothing in it is deleted."}
          </span>
        </div>
        <button
          type="button"
          disabled={pending}
          onClick={() => {
            onOpenChange(false);
            if (current.archived) onArchive(current, false);
            else if (empty) onDelete(current);
            else onArchive(current, true);
          }}
          className={cn(
            SECONDARY_BUTTON,
            !current.archived && empty && "text-destructive [&_svg]:text-destructive",
          )}
        >
          {current.archived ? (
            <ArchiveRestoreIcon />
          ) : empty ? (
            <Trash2Icon />
          ) : (
            <ArchiveIcon />
          )}
          {current.archived ? "Unarchive" : empty ? "Delete" : "Archive"}
        </button>
      </div>
    </FormDialog>
  );
}
