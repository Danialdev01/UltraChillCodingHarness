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
import { gitStage, gitCommit } from "@/lib/git-api";

type ChangedTree = { session: string | null; changes: number; canCommit: boolean };

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
  const [trees, setTrees] = useState<ChangedTree[] | null>(null);
  const [discard, setDiscard] = useState(false);
  const [summary, setSummary] = useState("Save changes before deleting project");
  const [checkError, setCheckError] = useState(false);

  async function refreshChanges() {
    if (!project) return;
    const response = await fetch(`/api/projects/${project.hash}/deletion-check`, { credentials: "include", cache: "no-store" });
    if (!response.ok) throw new Error("Could not check for uncommitted changes.");
    const body = await response.json() as { trees: ChangedTree[] };
    setTrees(body.trees);
    setCheckError(false);
  }

  // Reopening on a different project must not arrive with the last one's
  // name already typed in and the button already live.
  useEffect(() => {
    setTyped("");
    setError(null);
    setTrees(null);
    setDiscard(false);
    setCheckError(false);
    setSummary("Save changes before deleting project");
    if (!open || !project) return;
    const controller = new AbortController();
    void fetch(`/api/projects/${project.hash}/deletion-check`, { credentials: "include", cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error("Could not check for uncommitted changes.");
        const body = await response.json() as { trees: ChangedTree[] };
        if (!controller.signal.aborted) setTrees(body.trees);
      }).catch(() => {
        if (!controller.signal.aborted) { setCheckError(true); setError("Could not check for uncommitted changes. Retry before deleting."); }
      });
    return () => controller.abort();
  }, [project?.id, open]);

  async function commitFirst() {
    if (!project || !trees || !summary.trim()) return;
    setPending(true);
    setError(null);
    try {
      for (const tree of trees) {
        if (!tree.canCommit) throw new Error("Some files are outside a Git repository. Back them up before deleting.");
        const target = { hash: project.hash, session: tree.session };
        await gitStage(target, "all");
        await gitCommit(target, summary.trim());
      }
      await refreshChanges();
      setDiscard(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not commit changes.");
      await refreshChanges().catch(() => setCheckError(true));
    } finally { setPending(false); }
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!project || !confirmsName(typed, project.name) || !trees || checkError || (trees.length > 0 && !discard)) return;

    setPending(true);
    setError(null);
    try {
      const response = await fetch(`/api/projects/${project.hash}`, {
        method: "DELETE",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: typed, discardChanges: discard }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string; trees?: ChangedTree[] };
        if (body.trees) { setTrees(body.trees); setDiscard(false); }
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
    <Dialog open={open} onOpenChange={(next) => !pending && onOpenChange(next)}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>Delete {project?.name}</DialogTitle>
            <DialogDescription>
              This removes the working tree from disk and the project&apos;s entire history —
              every thread, turn and tool call. It cannot be undone.
              {" "}Local commits are deleted too. Push or back up any work you want to keep before deleting.
            </DialogDescription>
          </DialogHeader>

          <div className="py-4">
            {trees === null && !checkError && <p className="mb-3 text-sm text-muted-foreground" role="status">Checking for uncommitted changes…</p>}
            {checkError && <Button type="button" variant="outline" className="mb-3" disabled={pending} onClick={() => { setError(null); void refreshChanges().catch(() => setError("Could not check for uncommitted changes.")); }}>Retry check</Button>}
            {trees && trees.length > 0 && (
              <div className="mb-4 space-y-3 rounded-md border border-destructive/30 p-3 text-sm">
                <p role="alert">This project has uncommitted changes in {trees.length} working {trees.length === 1 ? "tree" : "trees"}. Deleting will permanently discard them.</p>
                <ul className="list-inside list-disc text-muted-foreground">
                  {trees.map((tree) => <li key={tree.session ?? "checkout"}>{tree.session ? `Session ${tree.session}` : "Project checkout"}: {tree.changes} changed files</li>)}
                </ul>
                {trees.every((tree) => tree.canCommit) && <>
                  <Field>
                    <FieldLabel htmlFor="delete-project-commit">Commit message</FieldLabel>
                    <Input id="delete-project-commit" value={summary} onChange={(event) => setSummary(event.target.value)} disabled={pending} />
                  </Field>
                  <Button type="button" variant="outline" onClick={() => void commitFirst()} disabled={pending || !summary.trim()}>{pending ? "Working…" : "Commit changes first"}</Button>
                </>}
                <label className="flex items-start gap-2">
                  <input type="checkbox" checked={discard} onChange={(event) => setDiscard(event.target.checked)} disabled={pending} className="mt-1" />
                  <span>Delete without committing these changes</span>
                </label>
              </div>
            )}
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
            <DialogClose render={<Button type="button" variant="outline" disabled={pending} />}>Cancel</DialogClose>
            <Button type="submit" variant="destructive" disabled={pending || !confirmed || !trees || checkError || (trees.length > 0 && !discard)}>
              {pending ? "Working…" : "Delete project"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
