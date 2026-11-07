"use client";

import { BotIcon, ChevronRightIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { subagentAnchor } from "@/lib/subagent-lineage";
import { Markdown } from "@/components/markdown";
import { Skeleton } from "@/components/ui/skeleton";
import { formatDuration, type SubagentRun, type ToolPart } from "@/lib/chat-messages";
import { formatUsd } from "@/lib/stats-format";

/**
 * A call that spawned subagents (solution §6.3): OMP's `task`, Claude Code's
 * `Agent` / `Task`, the bridge's `mcp__omp__omp_task`. Drawn among the tool
 * rows, as one: collapsed to a line saying who is working on what and how
 * far it has got, and expandable to each subagent's result.
 *
 * Nothing here is fetched -- every figure comes from the turn's events -- so
 * a subagent that has not reported yet shows a skeleton line where its
 * progress will be, not a spinner.
 */
/**
 * A turn's subagents, on the page rather than folded into its work: one
 * line saying how many went off and how many are still out, then a card
 * per call. Who is working on what is the first thing a reader looks for
 * once agents fan out, so it should not take a click to find.
 */
export function SubagentGroup({ calls }: { calls: readonly ToolPart[] }) {
  const runs = calls.flatMap((call) => (call.subagents?.length ? call.subagents : [null]));
  const count = runs.length;
  const working = calls.reduce(
    (n, call) =>
      n +
      (call.subagents?.length
        ? call.subagents.filter((run) => run.status === "running").length
        : call.result === null
          ? 1
          : 0),
    0,
  );
  const failed = calls.reduce(
    (n, call) => n + (call.subagents?.filter((run) => run.status === "failed").length ?? (call.isError ? 1 : 0)),
    0,
  );
  const longest = calls
    .flatMap((call) => call.subagents ?? [])
    .reduce<number | null>((max, run) => (run.durationMs === null ? max : Math.max(max ?? 0, run.durationMs)), null);
  const state = working > 0 ? `${working} working` : failed > 0 ? `${failed} failed` : `${count} done`;

  return (
    <section className="flex flex-col gap-2" aria-label="Subagents" data-testid="subagent-group">
      <div className="flex items-center gap-2.5 text-xs">
        <span className="flex -space-x-1.5" aria-hidden>
          {Array.from({ length: Math.min(count, 3) }, (_, i) => (
            <span
              key={i}
              className={cn(
                "bg-card ring-background grid size-6 place-items-center rounded-full border ring-2",
                working > 0 && "text-ucch-active",
              )}
            >
              <BotIcon className="size-3.5" />
            </span>
          ))}
        </span>
        <span className="flex flex-col leading-tight">
          <span className="text-foreground font-medium">
            {count} {count === 1 ? "subagent" : "subagents"}
          </span>
          <span
            className={cn(
              "text-2xs",
              working > 0 ? "text-ucch-active" : failed > 0 ? "text-destructive" : "text-muted-foreground",
            )}
          >
            {state}
          </span>
        </span>
        {longest !== null && working === 0 && (
          <span className="text-muted-foreground ml-auto tabular-nums">{formatDuration(longest)}</span>
        )}
      </div>
      {calls.map((call) => (
        <SubagentCard key={call.id} call={call} />
      ))}
    </section>
  );
}

export function SubagentCard({ call }: { call: ToolPart }) {
  const runs = call.subagents ?? [];
  const running = runs.length > 0 ? runs.some((run) => run.status === "running") : call.result === null;
  const failed = call.isError || runs.some((run) => run.status === "failed");
  const agents = [...new Set(runs.map((run) => run.agent))];
  const label = agents.length > 0 ? agents.join(", ") : agentOf(call.input) ?? "subagent";
  const description = runs.length === 1 ? runs[0]!.description : runs.length > 1 ? `${runs.length} tasks` : descriptionOf(call.input);
  const totals = sum(runs);
  const live = runs.length === 1 && runs[0]!.status === "running" ? runs[0]!.summary : null;

  return (
    <details
      id={subagentAnchor(call.id)}
      className={`group/subagent bg-card/40 scroll-mt-4 rounded-lg border text-xs ${failed ? "border-destructive/40" : ""}`}
      data-testid="subagent-card"
      data-status={running ? "running" : failed ? "failed" : "done"}
    >
      <summary className="flex cursor-pointer list-none flex-col gap-1 px-3 py-2 select-none [&::-webkit-details-marker]:hidden">
        <span className="flex items-center gap-2">
          <ChevronRightIcon className="text-muted-foreground size-3.5 shrink-0 transition-transform group-open/subagent:rotate-90" />
          <BotIcon className="text-muted-foreground size-3.5 shrink-0" />
          <span className="font-medium">{label}</span>
          {description && <span className="text-muted-foreground truncate">{description}</span>}
          <span className="text-muted-foreground ml-auto flex shrink-0 items-center gap-1.5 tabular-nums">
            {running && <span className="text-ucch-active">running</span>}
            {failed && <span className="text-destructive">failed</span>}
            <Figures {...totals} />
          </span>
        </span>
        {/* The live line, under the title while a lone subagent works. */}
        {runs.length === 1 && running && (
          <span className="text-muted-foreground block truncate pl-[1.375rem]" data-testid="subagent-summary">
            {live ?? <Skeleton className="h-3 w-40" />}
          </span>
        )}
      </summary>

      <div className="flex flex-col gap-2 border-t px-3 py-2">
        {runs.length === 0 ? (
          // The bridge's call: the CLI says nothing of the subagent inside it,
          // so the card has only the call's own answer.
          call.result === null ? (
            <Skeleton className="h-3 w-48" />
          ) : (
            <Result text={call.result} error={call.isError} />
          )
        ) : (
          runs.map((run) => <Run key={run.id} run={run} titled={runs.length > 1} />)
        )}
      </div>
    </details>
  );
}

function Run({ run, titled }: { run: SubagentRun; titled: boolean }) {
  return (
    <div className="flex flex-col gap-1" data-testid="subagent-run">
      {(titled || run.model) && (
        <span className="text-muted-foreground flex items-center gap-1.5">
          {titled && <span className="text-foreground font-medium">{run.agent}</span>}
          {titled && run.description && <span className="truncate">{run.description}</span>}
          {run.model && <span className="truncate font-mono">{run.model}</span>}
          <span className="ml-auto flex shrink-0 items-center gap-1.5 tabular-nums">
            {run.status === "failed" && <span className="text-destructive">failed</span>}
            {run.status === "aborted" && <span>stopped</span>}
            {titled && <Figures toolCalls={run.toolCalls} durationMs={run.durationMs} costUsd={run.costUsd} />}
          </span>
        </span>
      )}
      {run.status === "running" ? (
        titled ? (
          <span className="text-muted-foreground truncate">{run.summary ?? <Skeleton className="h-3 w-40" />}</span>
        ) : null
      ) : run.result ? (
        <Result text={run.result} error={run.status === "failed"} />
      ) : (
        <span className="text-muted-foreground">
          {run.status === "aborted" ? "Stopped before it answered." : "No answer."}
        </span>
      )}
    </div>
  );
}

function Result({ text, error }: { text: string; error: boolean }) {
  if (!text.trim()) return <span className="text-muted-foreground">No answer.</span>;
  return (
    // Capped and scrollable, as a tool result is: a long report must not
    // push the composer off the screen.
    <div
      className={`bg-muted/50 max-h-64 overflow-auto rounded p-2 text-xs @md:max-h-96 ${error ? "text-destructive" : ""}`}
      data-testid="subagent-result"
    >
      <Markdown>{text}</Markdown>
    </div>
  );
}

function Figures({ toolCalls, durationMs, costUsd }: Pick<SubagentRun, "toolCalls" | "durationMs" | "costUsd">) {
  const parts = [
    toolCalls !== null ? `${toolCalls} ${toolCalls === 1 ? "call" : "calls"}` : null,
    formatDuration(durationMs),
    costUsd !== null && costUsd > 0 ? formatUsd(costUsd) : null,
  ].filter(Boolean);
  return parts.length ? <span>{parts.join(" · ")}</span> : null;
}

/** Each subagent's figures, added up: the card's line covers all its tasks. */
function sum(runs: readonly SubagentRun[]): Pick<SubagentRun, "toolCalls" | "durationMs" | "costUsd"> {
  const add = (pick: (run: SubagentRun) => number | null, combine: (a: number, b: number) => number) =>
    runs.reduce<number | null>((total, run) => {
      const value = pick(run);
      return value === null ? total : total === null ? value : combine(total, value);
    }, null);
  return {
    toolCalls: add((run) => run.toolCalls, (a, b) => a + b),
    // In parallel, so the longest, not the total.
    durationMs: add((run) => run.durationMs, Math.max),
    costUsd: add((run) => run.costUsd, (a, b) => a + b),
  };
}

/** The agent a call asks for, before any subagent has started. */
function agentOf(input: unknown): string | null {
  if (typeof input !== "object" || input === null) return null;
  const record = input as Record<string, unknown>;
  for (const key of ["agent", "subagent_type"]) {
    const value = record[key];
    if (typeof value === "string" && value) return value;
  }
  return null;
}

/** What a call asks for, before any subagent has started. */
function descriptionOf(input: unknown): string | null {
  if (typeof input === "string") return input || null;
  if (typeof input !== "object" || input === null) return null;
  const record = input as Record<string, unknown>;
  for (const key of ["description", "task", "prompt"]) {
    const value = record[key];
    if (typeof value === "string" && value) return value;
  }
  if (Array.isArray(record.tasks)) return `${record.tasks.length} ${record.tasks.length === 1 ? "task" : "tasks"}`;
  return null;
}
