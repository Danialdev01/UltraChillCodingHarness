/** What the server and the web app agree on about the Tasks board. */

export const TASK_TITLE_MAX = 200;
export const TASK_DESCRIPTION_MAX = 20_000;
export const TASK_REFERENCES_MAX = 20;
export const TASK_FEEDBACK_MAX = 10_000;

/** The board's columns, left to right. */
export const TASK_STAGES = ["idea", "research", "ongoing", "verification", "done"] as const;
export type TaskStage = (typeof TASK_STAGES)[number];

/**
 * What the pipeline is doing with a card. `needs_input` is a failed
 * verification waiting for the person to say why; `failed` is a run that
 * errored and waits for a retry.
 */
export const TASK_STATUSES = ["idle", "running", "needs_input", "failed"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export type TaskReference =
  | { kind: "url"; url: string }
  | { kind: "file"; path: string }
  | { kind: "upload"; uploadId: string; name: string };

export interface TaskVerification {
  passed: boolean;
  reason: string;
  at: string;
  /** The thread the verifier worked in. */
  threadId?: string | null;
}

/** One failed round: what the verifier said, and what the person answered. */
export interface TaskFeedback {
  reason: string;
  answer: string;
  at: string;
}

export interface ProjectTask {
  id: string;
  title: string;
  description: string;
  references: TaskReference[];
  stage: TaskStage;
  status: TaskStatus;
  position: number;
  research: string | null;
  verification: TaskVerification | null;
  feedback: TaskFeedback[];
  threadId: string | null;
  attempts: number;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * When the board moves Idea cards to Research on its own. `days` are
 * 0 (Sunday) to 6; `time` is `HH:MM` in `timezone`, an IANA zone name.
 */
export interface TaskAutoRun {
  enabled: boolean;
  days: number[];
  time: string;
  timezone: string;
  /** The last scheduled slot that was looked at, and what came of it. */
  lastRunAt?: string | null;
  lastOutcome?: string | null;
}

export const DEFAULT_TASK_AUTO_RUN: TaskAutoRun = {
  enabled: false,
  days: [1, 2, 3, 4, 5],
  time: "02:00",
  timezone: "UTC",
};

/** Auto-run is skipped while any of the agent's usage windows is at or above this. */
export const TASK_AUTO_RUN_USAGE_LIMIT = 80;

export interface TaskSettings {
  /** Null falls back to the account default. */
  provider: "native" | "claude" | "codex" | null;
  model: string | null;
  autoRun: TaskAutoRun;
}
