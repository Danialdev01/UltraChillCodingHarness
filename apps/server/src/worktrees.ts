import { mkdir, rm } from "node:fs/promises";
import { dirname } from "node:path";
import type { Command, DomainEvent } from "@ucch/protocol";
import { runGit } from "./git-exec.js";
import { projectRoot, sessionTree } from "./trees.js";
import { DrainableWorker } from "./worker.js";

type ThreadCreated = Extract<DomainEvent, { type: "thread.created" }>;
type WorktreeOutcome = Extract<DomainEvent, { type: "thread.worktree_ready" | "thread.worktree_failed" }>;

const TIMEOUT_MS = 60_000;

export interface WorktreeOptions {
  /** Host directory the project workspaces live under. */
  workspaceRoot: string;
}

/**
 * The reactor that gives a project session its own checkout.
 *
 * On a `thread.created` that names a branch it runs `git worktree add -b
 * <branch> <tree> <baseBranch>` against the project's repository, and emits
 * `thread.worktree_ready` or `thread.worktree_failed`. Two sessions forked
 * from the same base each get a branch of their own, which is what lets them
 * run side by side: git refuses one branch checked out twice.
 *
 * One at a time, in a `DrainableWorker`: `worktree add` writes the shared
 * repository's refs and worktree list, and two at once would race for
 * `.git`'s locks.
 */
export class WorktreeReactor {
  readonly worker: DrainableWorker<ThreadCreated>;

  /** @param append emits the outcome against the session's thread. */
  constructor(
    private readonly append: (event: WorktreeOutcome, projectId: string) => Promise<void>,
    private readonly options: WorktreeOptions,
    onError: (error: unknown, event: ThreadCreated) => void = () => {},
  ) {
    this.worker = new DrainableWorker<ThreadCreated>("worktree", (event) => this.#add(event), onError);
  }

  react(_command: Command, batch: readonly DomainEvent[]): void {
    for (const event of batch) {
      if (event.type === "thread.created" && event.branch && event.baseBranch && event.hash) {
        this.worker.push(event);
      }
    }
  }

  drain(): Promise<void> {
    return this.worker.drain();
  }

  async #add(event: ThreadCreated): Promise<void> {
    const repo = projectRoot(this.options.workspaceRoot, event.projectId);
    const tree = sessionTree(this.options.workspaceRoot, event.projectId, event.hash!);
    try {
      await mkdir(dirname(tree), { recursive: true });
      // `--` keeps a base branch from ever being read as an option; the
      // branch itself is `ucch/{hash}`, made by `decide()`.
      await runGit(
        ["worktree", "add", "-b", event.branch!, "--", tree, event.baseBranch!],
        repo,
        TIMEOUT_MS,
      );
      await this.append({ type: "thread.worktree_ready", threadId: event.threadId }, event.projectId);
    } catch (error) {
      // A half-made tree would be refused by the next attempt; clear it and
      // let git forget it.
      await rm(tree, { recursive: true, force: true }).catch(() => {});
      await runGit(["worktree", "prune"], repo, TIMEOUT_MS).catch(() => {});
      await this.append(
        {
          type: "thread.worktree_failed",
          threadId: event.threadId,
          error: error instanceof Error ? error.message : String(error),
        },
        event.projectId,
      );
    }
  }
}
