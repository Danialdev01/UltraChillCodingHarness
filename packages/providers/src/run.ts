import type { DomainEvent } from "@ucch/protocol";
import type { ChildHandle, ExitStatus, SpawnSpec } from "./process.js";
import {
  forbiddenEnvPresent,
  type AgentRun,
  type PermissionReply,
  type RunContext,
} from "./types.js";

/**
 * What a provider's stream reader looks like from the driver's side.
 *
 * Stateful on purpose: a tool's duration needs the moment it started, a
 * `file.changed` needs the path the call named until its result says it
 * worked, and the CLI that emits one line per content block needs the
 * message id to tell a continuation from a new message.
 */
export interface Normaliser {
  /** One line of stdout, already complete. Not necessarily JSON. */
  push(line: string): DomainEvent[];
  /**
   * The child's stdin, for a CLI that talks back. Handed over before the
   * first line is read, so a prompt arriving on the first line has
   * somewhere to send its answer.
   */
  bind?(io: { write(line: string): void; endStdin(): void }): void;
  /** A person's answer to a prompt this stream raised. See `AgentRun`. */
  answerPermission?(requestId: string, reply: PermissionReply): DomainEvent[];
  /**
   * An interrupt has been sent. The CLI may still print a result line of
   * its own before it exits -- Claude Code does, and marks it an error --
   * and that result is a cancellation, not a failure.
   */
  noteInterrupt?(): void;
  /**
   * The process is gone. Closes the turn if the stream never did: an
   * interrupted run is a cancelled turn, anything else is a failed one.
   */
  finish(exit: ExitStatus & { interrupted: boolean; stderrTail: string }): DomainEvent[];
}

/** How long a SIGINT gets to land before SIGTERM follows it. */
const INTERRUPT_GRACE_MS = 10_000;

/** Stderr kept for the failure message. The end of it is where the error is. */
const STDERR_TAIL_BYTES = 4 * 1024;

/**
 * Spawns one CLI turn and turns its output into events.
 *
 * Shared by both providers: the normaliser is the only genuinely different
 * code between them, and the process supervision -- signals, the grace
 * period, the stderr tail, closing an unclosed turn -- must not be written
 * twice and drift.
 */
export function runCli(input: {
  ctx: RunContext;
  spec: Omit<SpawnSpec, "cwd" | "env">;
  normaliser: Normaliser;
}): AgentRun {
  const forbidden = forbiddenEnvPresent(input.ctx.env);
  if (forbidden) {
    throw new Error(
      `${forbidden} is set in the provider environment; refusing to run on API billing`,
    );
  }

  const child: ChildHandle = input.ctx.host.spawn({
    ...input.spec,
    cwd: input.ctx.cwd,
    env: input.ctx.env,
  });

  let interrupted = false;
  let interruptTimer: NodeJS.Timeout | undefined;
  let stderrTail = "";

  input.normaliser.bind?.({ write: (line) => child.write(line), endStdin: () => child.endStdin() });

  // An answer produces events of its own -- the prompt's resolution -- and
  // they must reach the consumer in order with the stream, so they queue
  // here and the reader drains them between lines.
  const answered: DomainEvent[] = [];

  const events: AsyncIterable<DomainEvent> = {
    async *[Symbol.asyncIterator]() {
      let spawnFailure: string | null = null;
      try {
        for await (const { stream, line } of child.lines) {
          if (stream === "stderr") {
            stderrTail = (stderrTail + line + "\n").slice(-STDERR_TAIL_BYTES);
            continue;
          }
          while (answered.length) yield answered.shift()!;
          for (const event of input.normaliser.push(line)) yield event;
        }
        while (answered.length) yield answered.shift()!;
      } catch (error) {
        spawnFailure = error instanceof Error ? error.message : String(error);
      }
      const status = await child.exited;
      if (interruptTimer) clearTimeout(interruptTimer);
      for (const event of input.normaliser.finish({
        ...status,
        interrupted,
        stderrTail: spawnFailure ?? stderrTail.trim(),
      })) {
        yield event;
      }
    },
  };

  return {
    events,
    ...(input.normaliser.answerPermission
      ? {
          answerPermission(requestId: string, reply: PermissionReply): boolean {
            const events = input.normaliser.answerPermission!(requestId, reply);
            if (events.length === 0) return false;
            answered.push(...events);
            return true;
          },
        }
      : {}),
    async interrupt() {
      if (interrupted) return;
      interrupted = true;
      input.normaliser.noteInterrupt?.();
      child.signal("SIGINT");
      interruptTimer = setTimeout(() => child.signal("SIGTERM"), INTERRUPT_GRACE_MS);
      interruptTimer.unref();
    },
    async kill() {
      interrupted = true;
      input.normaliser.noteInterrupt?.();
      child.signal("SIGTERM");
    },
  };
}

/** Whether an exit is the one a signal we sent produces. */
export function exitedBySignal(exit: ExitStatus): boolean {
  return exit.signal !== null || exit.code === 143 || exit.code === 130;
}
