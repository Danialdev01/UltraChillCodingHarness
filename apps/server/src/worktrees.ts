import type { Command, DomainEvent } from "@ucch/protocol";
import { ProjectGit } from "./project-git.js";
import { DrainableWorker } from "./worker.js";

type ThreadCreated = Extract<DomainEvent, { type: "thread.created" }>;
type WorktreeOutcome = Extract<DomainEvent, { type: "thread.worktree_ready" | "thread.worktree_failed" }>;

export interface WorktreeOptions {
  /** Host directory the project workspaces live under. */
  workspaceRoot: string;
  /**
   * The project repositories' git, shared with settling so the two take the
   * same per-project lock. One of its own when absent.
   */
  projectGit?: ProjectGit;
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
 * In a `DrainableWorker`, and under `ProjectGit`'s per-project lock:
 * `worktree add` writes the project repository's refs and worktree list,
 * and two at once -- or one beside a settle -- would race for `.git`'s locks.
 */
export class WorktreeReactor {
  readonly worker: DrainableWorker<ThreadCreated>;
  readonly #git: ProjectGit;

  /** @param append emits the outcome against the session's thread. */
  constructor(
    private readonly append: (event: WorktreeOutcome, projectId: string) => Promise<void>,
    private readonly options: WorktreeOptions,
    onError: (error: unknown, event: ThreadCreated) => void = () => {},
  ) {
    this.#git = options.projectGit ?? new ProjectGit(options.workspaceRoot);
    this.worker = new DrainableWorker<ThreadCreated>("worktree", (event) => this.#add(event), onError);
  }

  react(_command: Command, batch: readonly DomainEvent[]): void {
    for (const event of batch) {
      // A thread made in another's worktree has one already.
      if (event.type === "thread.created" && event.branch && event.baseBranch && event.hash && !event.worktreeOf) {
        this.worker.push(event);
      }
    }
  }

  drain(): Promise<void> {
    return this.worker.drain();
  }

  async #add(event: ThreadCreated): Promise<void> {
    try {
      // The branch is `ucch/{hash}`, made by `decide()`, forked in the
      // project's own repository from the base the session was created on.
      await this.#git.addWorktree(event.projectId, event.hash!, event.branch!, event.baseBranch!);
      await this.append({ type: "thread.worktree_ready", threadId: event.threadId }, event.projectId);
    } catch (error) {
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
