"use client";

import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { confirmsName } from "@/lib/confirm-name";
import type { Project } from "@/lib/session";

/**
 * Deleting a project, behind its own name.
 *
 * This removes the repository from disk and the whole event log with it --
 * every thread, turn and tool call the project ever recorded. There is no
 * undo and no trash, so the confirmation is the name rather than a second
 * button: a misaimed click cannot satisfy it, and the sidebar holds several
 * projects whose names differ by one word.
 */
export function DeleteProjectDialog({
  project,
  open,
  onOpenChange,
  onDeleted,
}: {
  /** null while nothing is being deleted; the dialog renders empty. */
  project: Project | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Runs after the server has confirmed it, so the caller can navigate. */
  onDeleted: (project: Project) => void;
}) {
  const [typed, setTyped] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reopening on a different project must not arrive with the last one's
  // name already typed in and the button already live.
  useEffect(() => {
    setTyped("");
    setError(null);
  }, [project?.id, open]);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!project || !confirmsName(typed, project.name)) return;

    setPending(true);
    setError(null);
    try {
      const response = await fetch(`/api/projects/${project.hash}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        // A running turn comes back as 409 with the remedy in the message,
        // so it is shown rather than flattened into "could not delete".
        setError(body.error ?? "Could not delete the project.");
        return;
      }
      onOpenChange(false);
      onDeleted(project);
    } catch {
      setError("Could not reach the server.");
    } finally {
      setPending(false);
    }
  }

  const confirmed = project ? confirmsName(typed, project.name) : false;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>Delete {project?.name}</DialogTitle>
            <DialogDescription>
              This removes the working tree from disk and the project&apos;s entire history —
              every thread, turn and tool call. It cannot be undone.
            </DialogDescription>
          </DialogHeader>

          <div className="py-4">
            <Field>
              <FieldLabel htmlFor="delete-project-name">
                Type <span className="text-foreground font-medium">{project?.name}</span> to
                confirm
              </FieldLabel>
              <Input
                id="delete-project-name"
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                placeholder={project?.name}
                autoFocus
                autoComplete="off"
                spellCheck={false}
                disabled={pending}
              />
            </Field>
            {error && (
              <p role="alert" className="text-destructive mt-2 text-sm">
                {error}
              </p>
            )}
          </div>

          <DialogFooter>
            <DialogClose render={<Button type="button" variant="outline" />}>Cancel</DialogClose>
            <Button type="submit" variant="destructive" disabled={pending || !confirmed}>
              {pending ? "Deleting…" : "Delete project"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
