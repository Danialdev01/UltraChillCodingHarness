"use client";

import { useState } from "react";

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

/**
 * Creating a workspace, as a controlled dialog.
 *
 * Extracted from the switcher because the quick menu opens it too, and two
 * copies of this form would be two places to keep the validation and the
 * post-create switch in sync.
 */
export function NewWorkspaceDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Receives the new workspace id, so the caller can switch to it. */
  onCreated: (workspaceId: string) => void;
}) {
  const [name, setName] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      const response = await fetch("/api/workspaces", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ name }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? "Could not create the workspace.");
        return;
      }
      const created = (await response.json()) as { id: string };
      setName("");
      onOpenChange(false);
      onCreated(created.id);
    } catch {
      setError("Could not reach the server.");
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>New workspace</DialogTitle>
            <DialogDescription>
              A workspace groups related projects, like a company or a team.
            </DialogDescription>
          </DialogHeader>

          <div className="py-4">
            <Field>
              <FieldLabel htmlFor="workspace-name">Name</FieldLabel>
              <Input
                id="workspace-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Acme Inc"
                maxLength={60}
                autoFocus
                required
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
            <Button type="submit" disabled={pending || name.trim().length === 0}>
              {pending ? "Creating…" : "Create workspace"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Persists the active workspace where the server can read it too, then
 * refreshes so the dashboard and the sidebar agree on which one is showing.
 */
export function selectWorkspace(workspaceId: string): void {
  document.cookie = `ucch_workspace=${workspaceId}; path=/; max-age=${60 * 60 * 24 * 365}; samesite=lax`;
}
