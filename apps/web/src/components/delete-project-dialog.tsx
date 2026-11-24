"use client";

import * as React from "react";
import { useEffect, useRef, useState } from "react";
import {
  CheckIcon,
  CircleAlertIcon,
  CopyIcon,
  FolderIcon,
  GitCommitHorizontalIcon,
  MessagesSquareIcon,
  Trash2Icon,
  TriangleAlertIcon,
} from "lucide-react";

import {
  ActionDialog,
  ActionDialogFooter,
  CARD,
  CARD_CHECKED_ACCENT,
  CARD_CHECKED_DANGER,
  CARD_UNCHECKED,
  FIELD_LABEL,
  HELPER_TEXT,
  INPUT,
  SECTION_LABEL,
} from "@/components/action-dialog";
import { FOCUS } from "@/components/form-dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { confirmsName } from "@/lib/confirm-name";
import { fetchGitStatus, gitCommit, gitPush, gitStage } from "@/lib/git-api";
import { useToast } from "@/lib/realtime";
import type { Project } from "@/lib/session";
import { cn } from "@/lib/utils";

type ChangedTree = { session: string | null; changes: number; canCommit: boolean };
type Choice = "commit" | "discard";
type Stage = "idle" | "pushing" | "deleting";

const DEFAULT_MESSAGE = "Save changes before deleting project";

const DELETED = [
  { icon: FolderIcon, text: "Working tree on disk" },
  { icon: MessagesSquareIcon, text: "All threads, turns and tool calls" },
  { icon: GitCommitHorizontalIcon, text: "Local commits that haven't been pushed" },
] as const;

async function fetchDeletionCheck(hash: string, signal?: AbortSignal): Promise<ChangedTree[]> {
  const response = await fetch(`/api/projects/${hash}/deletion-check`, { credentials: "include", cache: "no-store", signal });
  if (!response.ok) throw new Error("Could not check for uncommitted changes.");
  return ((await response.json()) as { trees: ChangedTree[] }).trees;
}

/**
 * Deleting a project, behind its own name.
 *
 * This removes the repository from disk and the whole event log with it --
 * every thread, turn and tool call the project ever recorded. There is no
 * undo and no trash, so the confirmation is the name rather than a second
 * button: a misaimed click cannot satisfy it, and the sidebar holds several
 * projects whose names differ by one word.
 *
 * Uncommitted work is a choice made here rather than a reason to bounce the
 * person out to the git panel: commit and push it first, or discard it. A
 * failed push stops the whole thing -- nothing is deleted until the work is
 * safe on the remote.
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
  const toast = useToast();
  const [typed, setTyped] = useState("");
  const [stage, setStage] = useState<Stage>("idle");
  const [error, setError] = useState<string | null>(null);
  /** A failure committing or pushing; shown under the changes it concerns. */
  const [pushError, setPushError] = useState<string | null>(null);
  const [trees, setTrees] = useState<ChangedTree[] | null>(null);
  const [checkError, setCheckError] = useState(false);
  const [choice, setChoice] = useState<Choice>("commit");
  const [message, setMessage] = useState(DEFAULT_MESSAGE);
  const [upstream, setUpstream] = useState<string | null>(null);

  const confirmRef = useRef<HTMLInputElement>(null);
  const choiceRefs = useRef<Record<Choice, HTMLButtonElement | null>>({ commit: null, discard: null });

  const busy = stage !== "idle";
  const dirty = trees?.filter((tree) => tree.changes > 0) ?? [];
  const total = dirty.reduce((sum, tree) => sum + tree.changes, 0);
  const hasChanges = dirty.length > 0;
  const canCommit = dirty.every((tree) => tree.canCommit);
  const effectiveChoice: Choice = canCommit ? choice : "discard";

  // Reopening on a different project must not arrive with the last one's
  // name already typed in and the button already live.
  useEffect(() => {
    setTyped("");
    setError(null);
    setPushError(null);
    setTrees(null);
    setCheckError(false);
    setChoice("commit");
    setMessage(DEFAULT_MESSAGE);
    setUpstream(null);
    if (!open || !project) return;
    const controller = new AbortController();
    void fetchDeletionCheck(project.hash, controller.signal)
      .then((next) => {
        if (controller.signal.aborted) return;
        setTrees(next);
        const first = next.find((tree) => tree.changes > 0 && tree.canCommit);
        if (first) {
          void fetchGitStatus({ hash: project.hash, session: first.session })
            .then((status) => {
              if (controller.signal.aborted) return;
              setUpstream(status.upstream ?? (status.branch ? `origin/${status.branch}` : null));
            })
            .catch(() => {});
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) setCheckError(true);
      });
    return () => controller.abort();
  }, [project?.id, open]); // eslint-disable-line react-hooks/exhaustive-deps

  // With changes to decide about, the decision is the first thing to reach.
  // Only while nothing has been typed: focus does not jump out from under a
  // person already filling in the name.
  const shouldFocusChoice = hasChanges;
  useEffect(() => {
    if (!shouldFocusChoice) return;
    if (document.activeElement === confirmRef.current && confirmRef.current?.value === "") {
      choiceRefs.current[canCommit ? "commit" : "discard"]?.focus();
    }
  }, [shouldFocusChoice, canCommit]);

  async function retryCheck() {
    if (!project) return;
    setCheckError(false);
    setError(null);
    try {
      setTrees(await fetchDeletionCheck(project.hash));
    } catch {
      setCheckError(true);
    }
  }

  async function deleteProject(discardChanges: boolean): Promise<boolean> {
    if (!project) return false;
    setStage("deleting");
    const response = await fetch(`/api/projects/${project.hash}`, {
      method: "DELETE",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: typed, discardChanges }),
    });
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as { error?: string; trees?: ChangedTree[] };
      if (body.trees) setTrees(body.trees);
      // A running turn comes back as 409 with the remedy in the message,
      // so it is shown rather than flattened into "could not delete".
      setError(body.error ?? "Could not delete the project.");
      return false;
    }
    const body = (await response.json().catch(() => ({}))) as { leftFiles?: boolean };
    if (body.leftFiles) {
      toast({
        title: `Deleted ${project.name}`,
        description: "Some of its files belong to another system user or are in use. The server keeps trying to remove them.",
        tone: "error",
      });
    }
    return true;
  }

  /** Commit and push every dirty tree. False, with the reason shown, if any step fails. */
  async function saveChanges(): Promise<boolean> {
    if (!project) return false;
    setStage("pushing");
    try {
      for (const tree of dirty) {
        const target = { hash: project.hash, session: tree.session };
        await gitStage(target, "all");
        await gitCommit(target, message.trim());
        await gitPush(target);
      }
      const after = await fetchDeletionCheck(project.hash);
      setTrees(after);
      if (after.some((tree) => tree.changes > 0)) {
        setPushError("Some changes are still uncommitted after saving. Check the project's Git panel, then try again.");
        return false;
      }
      return true;
    } catch (caught) {
      setPushError(caught instanceof Error ? caught.message : "Could not commit and push the changes.");
      // What did land (a commit without its push) should show as it now is.
      await fetchDeletionCheck(project.hash).then(setTrees).catch(() => {});
      return false;
    }
  }

  const confirmed = project ? confirmsName(typed, project.name) : false;
  const ready =
    confirmed &&
    trees !== null &&
    !checkError &&
    !busy &&
    (!hasChanges || effectiveChoice === "discard" || message.trim().length > 0);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!project || !ready) return;
    setError(null);
    setPushError(null);
    try {
      if (hasChanges && effectiveChoice === "commit" && !(await saveChanges())) return;
      const discard = hasChanges && effectiveChoice === "discard";
      if (!(await deleteProject(discard))) return;
      onOpenChange(false);
      onDeleted(project);
    } catch {
      setError("Could not reach the server.");
    } finally {
      setStage("idle");
    }
  }

  const label = busy
    ? stage === "pushing"
      ? "Pushing…"
      : "Deleting…"
    : !hasChanges
      ? "Delete project"
      : effectiveChoice === "commit"
        ? "Commit, push & delete"
        : "Discard & delete";

  return (
    <ActionDialog
      open={open}
      onOpenChange={onOpenChange}
      busy={busy}
      icon={Trash2Icon}
      tone="danger"
      title="Delete project"
      description={
        <>
          Permanently removes <span className="fd-mono text-(--fd-text)">{project?.name}</span> and everything in it.
          This can&apos;t be undone.
        </>
      }
      onSubmit={(event) => void submit(event)}
      initialFocus={confirmRef}
      footer={
        <ActionDialogFooter tone="danger" hint="Permanent" hintIcon={TriangleAlertIcon} busy={busy} ready={ready}>
          {label}
        </ActionDialogFooter>
      }
    >
      {/* A. What goes */}
      <section className="flex flex-col gap-2.5" aria-labelledby="delete-project-what">
        <h3 id="delete-project-what" className={SECTION_LABEL}>
          What will be deleted
        </h3>
        <ul className="overflow-hidden rounded-[10px] border border-(--fd-border) bg-(--fd-field-muted)">
          {DELETED.map(({ icon: Icon, text }) => (
            <li
              key={text}
              className="flex items-center gap-3 border-b border-(--fd-border-subtle) px-3.5 py-[11px] text-[13.5px] text-(--fd-text) last:border-b-0"
            >
              <Icon className="size-4 shrink-0 text-(--fd-text-muted)" aria-hidden />
              {text}
            </li>
          ))}
        </ul>
      </section>

      {/* B. Uncommitted changes, once known */}
      {trees === null && !checkError && (
        <div className="flex flex-col gap-2" role="status" aria-label="Checking for uncommitted changes">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-3.5 w-64" />
        </div>
      )}
      {checkError && (
        <div className="flex items-center gap-3 text-[12.5px] text-(--fd-danger-text)" role="alert">
          <CircleAlertIcon className="size-4 shrink-0" aria-hidden />
          <span className="grow">Could not check for uncommitted changes.</span>
          <button
            type="button"
            onClick={() => void retryCheck()}
            className={cn(
              "h-8 shrink-0 rounded-[8px] border border-(--fd-border-field) px-3 text-[12.5px] font-medium text-(--fd-text) hover:bg-(--fd-cancel-hover)",
              FOCUS,
            )}
          >
            Retry
          </button>
        </div>
      )}
      {hasChanges && (
        <section className="flex flex-col gap-3" aria-labelledby="delete-project-changes">
          <div className="flex items-center justify-between gap-3">
            <h3 id="delete-project-changes" className={SECTION_LABEL}>
              Uncommitted changes
            </h3>
            <span className="fd-mono rounded-full border border-(--fd-warning-border) bg-(--fd-warning-tint) px-2 py-0.5 text-[12px] font-medium text-(--fd-warning)">
              {total} {total === 1 ? "file" : "files"}
            </span>
          </div>
          <ul className="flex flex-col gap-1.5 text-[13px]">
            {dirty.map((tree) => (
              <li key={tree.session ?? "checkout"} className="flex items-center justify-between gap-3">
                <span className="min-w-0 truncate text-(--fd-text-muted)">
                  {tree.session ? (
                    <>
                      Session <span className="fd-mono">{tree.session}</span>
                    </>
                  ) : (
                    "Project checkout"
                  )}
                </span>
                <span className="fd-mono shrink-0 text-(--fd-text)">
                  {tree.changes} {tree.changes === 1 ? "file" : "files"}
                </span>
              </li>
            ))}
          </ul>

          <p id="delete-project-choice-label" className="text-[12.5px] text-(--fd-text-muted)">
            What should happen to them?
          </p>
          <ChoiceCards
            value={effectiveChoice}
            onChange={(next) => {
              setChoice(next);
              setPushError(null);
            }}
            disabled={busy}
            commitDisabled={!canCommit}
            total={total}
            refs={choiceRefs}
          />

          {effectiveChoice === "commit" ? (
            <div className="flex flex-col gap-1.5">
              <label htmlFor="delete-project-commit" className={FIELD_LABEL}>
                Commit message
              </label>
              <input
                id="delete-project-commit"
                value={message}
                onChange={(event) => setMessage(event.target.value)}
                disabled={busy}
                autoComplete="off"
                className={INPUT}
              />
              <p className={HELPER_TEXT}>
                {dirty.length > 1 ? (
                  "Each working tree is pushed to its own branch before the project is removed."
                ) : (
                  <>
                    Pushed to <span className="fd-mono text-(--fd-text)">{upstream ?? "its upstream"}</span> before
                    the project is removed.
                  </>
                )}
              </p>
            </div>
          ) : (
            <p className="flex items-start gap-2 text-[12.5px] leading-normal text-(--fd-danger-text)">
              <CircleAlertIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              {canCommit
                ? `These ${total} ${total === 1 ? "change" : "changes"} will be lost for good.`
                : "Some files are outside a Git repository, so they can't be pushed. They will be lost for good — back them up first if you need them."}
            </p>
          )}

          {pushError && (
            <p role="alert" className="flex items-start gap-2 text-[12.5px] leading-normal break-words text-(--fd-danger-text)">
              <CircleAlertIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              <span>
                {pushError} Nothing was deleted.
              </span>
            </p>
          )}
        </section>
      )}

      {/* C. The name */}
      <div className="flex flex-col gap-1.5">
        <label htmlFor="delete-project-name" className={cn(FIELD_LABEL, "flex flex-wrap items-center gap-2")}>
          Type
          {project && <CopyChip text={project.name} />}
          to confirm
        </label>
        <input
          id="delete-project-name"
          ref={confirmRef}
          value={typed}
          onChange={(event) => setTyped(event.target.value)}
          placeholder="Project name"
          autoComplete="off"
          spellCheck={false}
          disabled={busy}
          className={cn(INPUT, "fd-mono", confirmed && "border-(--fd-success) focus-visible:border-(--fd-success)")}
        />
      </div>

      {error && (
        <p role="alert" className="text-[12.5px] leading-normal break-words text-(--fd-danger-text)">
          {error}
        </p>
      )}
    </ActionDialog>
  );
}

/**
 * Commit & push, or discard: a radio group of two cards.
 *
 * Arrow keys move the choice and the focus together, with only the checked
 * card in the tab order, as a native radio group does.
 */
function ChoiceCards({
  value,
  onChange,
  disabled,
  commitDisabled,
  total,
  refs,
}: {
  value: Choice;
  onChange: (value: Choice) => void;
  disabled: boolean;
  /** Some tree is outside a repository, so only discarding is possible. */
  commitDisabled: boolean;
  total: number;
  refs: React.RefObject<Record<Choice, HTMLButtonElement | null>>;
}) {
  const options = [
    { value: "commit" as const, title: "Commit & push", hint: "Save them to the remote first", off: commitDisabled },
    { value: "discard" as const, title: "Discard", hint: `Throw away all ${total} ${total === 1 ? "change" : "changes"}`, off: false },
  ];
  const enabled = options.filter((option) => !option.off);

  function onKeyDown(event: React.KeyboardEvent) {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
    if (!step || enabled.length < 2) return;
    event.preventDefault();
    const at = enabled.findIndex((option) => option.value === value);
    const next = enabled[(at + step + enabled.length) % enabled.length]!.value;
    onChange(next);
    refs.current[next]?.focus();
  }

  return (
    <div role="radiogroup" aria-labelledby="delete-project-choice-label" className="grid grid-cols-1 gap-2.5 sm:grid-cols-2" onKeyDown={onKeyDown}>
      {options.map((option) => {
        const checked = option.value === value;
        const danger = option.value === "discard";
        return (
          <button
            key={option.value}
            ref={(node) => {
              refs.current[option.value] = node;
            }}
            type="button"
            role="radio"
            aria-checked={checked}
            tabIndex={checked ? 0 : -1}
            disabled={disabled || option.off}
            onClick={() => onChange(option.value)}
            className={cn(
              CARD,
              "flex-col gap-1",
              option.off && "opacity-50",
              !checked && CARD_UNCHECKED,
              checked && !danger && CARD_CHECKED_ACCENT,
              checked && danger && CARD_CHECKED_DANGER,
            )}
          >
            <span className="text-[13.5px] font-semibold text-(--fd-text)">{option.title}</span>
            <span
              className={cn(
                "text-[12.5px] leading-snug",
                !checked && "text-(--fd-text-muted)",
                checked && !danger && "text-(--fd-accent-desc)",
                checked && danger && "text-(--fd-danger-desc)",
              )}
            >
              {option.off ? "Some files are outside a Git repository" : option.hint}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** The name to type, as a chip that copies it. */
function CopyChip({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard refused (insecure origin, permissions): the name is right there to type.
    }
  }

  return (
    <span className="relative inline-flex">
      <button
        type="button"
        onClick={() => void copy()}
        aria-label={`Copy ${text}`}
        className={cn(
          "fd-mono inline-flex max-w-full items-center gap-1.5 rounded-[6px] border border-(--fd-border-field) bg-(--fd-code-bg) px-1.5 py-0.5 text-[12.5px] font-normal break-all text-(--fd-text) transition-colors hover:border-(--fd-border-hover)",
          FOCUS,
        )}
      >
        {text}
        {copied ? (
          <CheckIcon className="size-3 shrink-0 text-(--fd-success)" aria-hidden />
        ) : (
          <CopyIcon className="size-3 shrink-0 text-(--fd-text-muted)" aria-hidden />
        )}
      </button>
      {copied && (
        <span
          role="status"
          className="pointer-events-none absolute bottom-full left-1/2 mb-1.5 -translate-x-1/2 rounded-[6px] bg-(--fd-text) px-2 py-1 text-[11.5px] font-medium whitespace-nowrap text-(--fd-surface) shadow-md"
        >
          Copied
        </span>
      )}
    </span>
  );
}
