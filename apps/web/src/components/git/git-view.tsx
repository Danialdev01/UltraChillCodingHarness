"use client"

import * as React from "react"
import type { GitCommitFile } from "@ucch/protocol"
import { GitBranchIcon, XIcon } from "lucide-react"

import { useFilesPanel } from "@/components/files-panel"
import { FileTypeIcon } from "@/components/file-type-icon"
import { CodeLinesSkeleton, GitSkeleton } from "@/components/page-skeletons"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Tabs, TabsList, TabsPanel, TabsTab } from "@/components/ui/tabs"
import {
  gitAbortMerge,
  gitCheckout,
  gitCommit,
  gitConnectRemote,
  gitCreateBranch,
  gitDiscard,
  gitFetch,
  gitPull,
  gitPush,
  gitResolve,
  gitStage,
  gitUnstage,
} from "@/lib/git-api"
import { relativeTime } from "@/lib/stats-format"
import { targetOf } from "@/lib/project-target"
import type { Project } from "@/lib/session"
import { cn } from "@/lib/utils"
import { usePresenceLocation } from "@/lib/realtime"

import { ChangesList, StatusBadge } from "./changes-list"
import { CommitForm } from "./commit-form"
import { ConflictBanner } from "./conflict-banner"
import { ConnectRemoteDialog } from "./connect-remote-dialog"
import { DiffView, EmptyPane } from "./diff-view"
import { GitToolbar } from "./git-toolbar"
import { HistoryList } from "./history-list"
import { useGitState } from "./use-git-state"

/**
 * The project's repository, laid out like GitHub Desktop.
 *
 * A toolbar for the branch and the remote; a column of changes or history;
 * and the diff of whatever is picked. The state hook owns every fetch and
 * every mutation; this only says what goes where and asks before the two
 * things that cannot be undone.
 */
export function GitView({ project }: { project: Project }) {
  usePresenceLocation(project.id, "git")
  const git = useGitState(project)
  const { openFile, setMode } = useFilesPanel()
  const [tab, setTab] = React.useState<"changes" | "history">("changes")
  const [discarding, setDiscarding] = React.useState<string[] | "all" | null>(null)
  const [connecting, setConnecting] = React.useState(false)
  const hash = targetOf(project)

  const open = (path: string) => {
    openFile(path)
    setMode("file")
  }

  if (git.notRepo) {
    return (
      <EmptyPane
        title="This project is not a git repository."
        hint="Run `git init` in the terminal, or create the project from a repository."
      />
    )
  }
  if (git.loading || !git.status) {
    if (git.error) return <EmptyPane title={git.error} />
    return <GitSkeleton />
  }

  const { status } = git
  const unresolved = status.files.filter((f) => f.conflicted).length
  const merging = status.mergeInProgress || status.rebaseInProgress

  return (
    <div data-slot="git-view" className="flex min-h-0 flex-1 flex-col">
      <GitToolbar
        status={status}
        branches={git.branches}
        busy={git.busy}
        onCheckout={(branch, remote) => void git.mutate("Switch branch", () => gitCheckout(hash, branch, remote))}
        onCreateBranch={(name) => void git.mutate("Create branch", () => gitCreateBranch(hash, name))}
        onFetch={(unshallow) => void git.mutate(unshallow ? "Fetch full history" : "Fetch", () => gitFetch(hash, unshallow))}
        onPull={() => void git.mutate("Pull", () => gitPull(hash))}
        onPush={() => void git.mutate("Push", () => gitPush(hash))}
        onAddRemote={() => {
          git.clearError()
          setConnecting(true)
        }}
      />
      {merging && (
        <ConflictBanner
          unresolved={unresolved}
          rebase={status.rebaseInProgress}
          busy={git.busy !== null}
          onAbort={() => void git.mutate("Abort merge", () => gitAbortMerge(hash))}
        />
      )}
      {git.error && !connecting && (
        <div className="bg-danger-soft text-destructive flex items-start gap-2 border-b px-3 py-2 text-xs">
          <p className="min-w-0 flex-1 break-words whitespace-pre-wrap">{git.error}</p>
          <button type="button" onClick={git.clearError} aria-label="Dismiss" className="shrink-0 rounded p-0.5 hover:bg-danger-soft">
            <XIcon className="size-3.5" />
          </button>
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        <Tabs
          value={tab}
          onValueChange={(value) => setTab(value as "changes" | "history")}
          className="flex w-72 shrink-0 flex-col gap-0 border-r sm:w-80"
        >
          <TabsList className="grid w-full grid-cols-2 rounded-none border-b bg-transparent p-0">
            <TabsTab value="changes" className="rounded-none">
              Changes
              {status.files.length > 0 && (
                <span className="bg-muted text-muted-foreground ml-1.5 rounded-full px-1.5 text-[0.65rem] tabular-nums">
                  {status.files.length}
                </span>
              )}
            </TabsTab>
            <TabsTab value="history" className="rounded-none">
              History
            </TabsTab>
          </TabsList>
          <TabsPanel value="changes" className="flex min-h-0 flex-1 flex-col">
            <ChangesList
              files={status.files}
              truncated={status.truncated}
              selection={git.selection}
              disabled={git.busy !== null}
              onSelect={git.select}
              onStage={(paths) => void git.mutate("Stage", () => gitStage(hash, paths))}
              onUnstage={(paths) => void git.mutate("Unstage", () => gitUnstage(hash, paths))}
              onDiscard={setDiscarding}
              onResolve={(path, strategy) => void git.mutate("Resolve", () => gitResolve(hash, path, strategy))}
              onOpen={open}
            />
            <CommitForm
              status={status}
              busy={git.busy === "Commit"}
              onCommit={async (summary, description) => {
                const result = await git.mutate("Commit", () => gitCommit(hash, summary, description || undefined))
                return result !== null
              }}
            />
          </TabsPanel>
          <TabsPanel value="history" className="flex min-h-0 flex-1 flex-col">
            <HistoryList
              commits={git.commits}
              page={git.log}
              selectedSha={git.selection?.kind === "commit" ? git.selection.sha : null}
              onSelect={(sha) => git.select({ kind: "commit", sha, path: null })}
              onLoadMore={() => void git.loadMoreHistory()}
              onUnshallow={() => void git.mutate("Fetch full history", () => gitFetch(hash, true))}
              busy={git.busy !== null}
            />
          </TabsPanel>
        </Tabs>

        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {git.selection?.kind === "commit" && git.commit ? (
            <CommitPane
              commit={git.commit}
              selectedPath={git.selection.path}
              onSelectFile={(path) => git.select({ kind: "commit", sha: git.commit!.commit.sha, path })}
            />
          ) : null}
          <div className="relative min-h-0 flex-1 overflow-auto">
            {git.diffLoading && (
              <div className="bg-background absolute inset-0 z-20">
                <CodeLinesSkeleton rows={12} />
              </div>
            )}
            {git.selection === null ? (
              <EmptyPane
                title={tab === "changes" ? "Select a file to see what changed." : "Select a commit to see what it changed."}
                hint={tab === "changes" && status.files.length === 0 ? `${status.branch ?? "HEAD"} is clean.` : undefined}
              />
            ) : git.selection.kind === "commit" && git.selection.path === null ? (
              git.commit && git.commit.files.length === 0 ? <EmptyPane title="This commit changed no files." /> : null
            ) : git.diff ? (
              <DiffView diff={git.diff} path={git.selection.path!} />
            ) : null}
          </div>
        </div>
      </div>

      <ConnectRemoteDialog
        open={connecting}
        status={status}
        busy={git.busy}
        error={connecting ? git.error : null}
        onOpenChange={setConnecting}
        onConnect={(url) => git.mutate("Connect remote", () => gitConnectRemote(hash, url))}
        onPush={() => git.mutate("Push", () => gitPush(hash))}
      />

      <Dialog open={discarding !== null} onOpenChange={(next) => !next && setDiscarding(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {discarding === "all"
                ? "Discard all changes?"
                : discarding && discarding.length === 1
                  ? `Discard changes to ${discarding[0]}?`
                  : `Discard ${discarding?.length ?? 0} files' changes?`}
            </DialogTitle>
            <DialogDescription>
              Edits go back to the last commit and new files are deleted. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDiscarding(null)}>
              Keep
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                const paths = discarding
                setDiscarding(null)
                if (paths) void git.mutate("Discard", () => gitDiscard(hash, paths))
              }}
            >
              Discard
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

/** A commit's message and the files it touched, above the diff of one of them. */
function CommitPane({
  commit,
  selectedPath,
  onSelectFile,
}: {
  commit: NonNullable<ReturnType<typeof useGitState>["commit"]>
  selectedPath: string | null
  onSelectFile(path: string): void
}) {
  const { commit: meta, files } = commit
  return (
    <div className="border-b">
      <div className="px-4 pt-3 pb-2">
        <h2 className="text-sm font-semibold">{meta.subject || "(no message)"}</h2>
        {meta.body && <p className="text-muted-foreground mt-1 text-xs whitespace-pre-wrap">{meta.body}</p>}
        <p className="text-muted-foreground mt-1.5 flex flex-wrap items-center gap-x-2 text-xs">
          <span>{meta.authorName}</span>
          <span>·</span>
          <span title={new Date(meta.date).toLocaleString()}>{relativeTime(meta.date)}</span>
          <span>·</span>
          <span className="font-mono">{meta.shortSha}</span>
          {meta.parents.length > 1 && (
            <>
              <span>·</span>
              <span className="inline-flex items-center gap-1">
                <GitBranchIcon className="size-3" /> merge
              </span>
            </>
          )}
        </p>
      </div>
      <ul className="flex max-h-40 flex-col overflow-y-auto border-t py-1">
        {files.map((file) => (
          <CommitFileRow key={file.path} file={file} selected={file.path === selectedPath} onSelect={() => onSelectFile(file.path)} />
        ))}
      </ul>
    </div>
  )
}

function CommitFileRow({ file, selected, onSelect }: { file: GitCommitFile; selected: boolean; onSelect(): void }) {
  const slash = file.path.lastIndexOf("/")
  const dir = slash >= 0 ? file.path.slice(0, slash + 1) : ""
  const name = file.path.slice(slash + 1)
  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        aria-current={selected || undefined}
        className={cn(
          "flex w-full items-center gap-1.5 px-4 py-1 text-left text-xs",
          selected ? "bg-ucch-active-bg" : "hover:bg-muted/60",
        )}
      >
        <FileTypeIcon name={name} kind="file" className="size-3.5 shrink-0" />
        <span className="min-w-0 flex-1 truncate">
          {dir && <span className="text-muted-foreground">{dir}</span>}
          {name}
          {file.origPath && <span className="text-muted-foreground"> ← {file.origPath}</span>}
        </span>
        <StatusBadge file={{ index: file.status, worktree: ".", untracked: false, conflicted: false }} />
      </button>
    </li>
  )
}
