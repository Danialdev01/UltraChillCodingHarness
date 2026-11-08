"use client";

import { ArrowLeftIcon, ChevronRightIcon, ExternalLinkIcon } from "lucide-react";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { HarnessIcon } from "@/components/harness-icon";
import { projectHashFromPath } from "@/lib/sections";
import { TransitionLink } from "@/lib/view-transitions";
import { useActiveWorkspace, useWorkspaceHash } from "@/lib/workspace-context";
import { cn } from "@/lib/utils";
import { subagentAnchor, type LineageEntry } from "@/lib/subagent-lineage";
import { Markdown } from "@/components/markdown";
import { Skeleton } from "@/components/ui/skeleton";
import { agentOf, descriptionOf, formatDuration, type ChatMessage, type SubagentRun, type ToolPart } from "@/lib/chat-messages";
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
export function SubagentGroup({ calls, harness }: { calls: readonly ToolPart[]; harness?: string }) {
  const runs = calls.flatMap((call) => (call.subagents?.length ? call.subagents : [null]));
  // One mark per subagent: its own harness, or the turn's it ran inside.
  const marks = calls.flatMap((call) =>
    call.subagents?.length ? call.subagents.map((run) => run.provider ?? harnessOf(call, harness)) : [harnessOf(call, harness)],
  );
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
              <HarnessIcon harness={marks[i]} size={14} />
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
        <SubagentCard key={call.id} call={call} harness={harness} />
      ))}
    </section>
  );
}

/**
 * The harness a subagent call runs on: a `ucch_agent` subagent's own, or
 * else the parent turn's -- a CLI's built-in subagent runs inside it. A
 * turn that names no provider is the native loop's.
 */
function harnessOf(call: ToolPart, parent: string | undefined): string {
  return call.subagents?.find((run) => run.provider)?.provider ?? parent ?? "native";
}

/** `harness`: the provider of the turn the call was made in. */
export function SubagentCard({ call, harness }: { call: ToolPart; harness?: string }) {
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
          <HarnessIcon harness={harnessOf(call, harness)} size={14} />
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

/**
 * Where a `ucch_agent` subagent's own session is: its full transcript. Only
 * in a project workspace, whose sessions have addresses of their own.
 */
function useSessionHref(childHash: string | undefined): string | null {
  const pathname = usePathname();
  const ws = useWorkspaceHash();
  const kind = useActiveWorkspace()?.kind ?? "project";
  const projectHash = projectHashFromPath(pathname);
  if (!childHash || !projectHash || !ws || kind !== "project") return null;
  return `/${ws}/p/${projectHash}/${childHash}`;
}

function Run({ run, titled }: { run: SubagentRun; titled: boolean }) {
  const transcript = useSessionHref(run.childHash);
  return (
    <div className="flex flex-col gap-1" data-testid="subagent-run" data-provider={run.provider}>
      {(titled || run.model || run.provider) && (
        <span className="text-muted-foreground flex items-center gap-1.5">
          {/* A subagent on a harness of its own: which, as the sessions list marks it. */}
          {run.provider && <HarnessIcon harness={run.provider} size={14} />}
          {titled && <span className="text-foreground font-medium">{run.agent}</span>}
          {titled && run.description && <span className="truncate">{run.description}</span>}
          {run.model && (
            <span className="truncate font-mono" title={run.routing}>
              {run.model}
            </span>
          )}
          {transcript && (
            <TransitionLink
              href={transcript}
              className="hover:text-foreground flex shrink-0 items-center gap-1 underline-offset-2 hover:underline"
              data-testid="subagent-transcript"
            >
              Open transcript
              <ExternalLinkIcon className="size-3" />
            </TransitionLink>
          )}
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

export function Result({ text, error }: { text: string; error: boolean }) {
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

export function Figures({ toolCalls, durationMs, costUsd }: Pick<SubagentRun, "toolCalls" | "durationMs" | "costUsd">) {
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

/**
 * A CLI's built-in subagent (Claude Code's `Task`, OMP's `task`), on a page
 * of its own over its parent's thread: what it was asked, what it is doing
 * -- live, as its events arrive -- and what it answered. It ran inside its
 * parent's process, so there is no session to talk to or run again -- only
 * a `ucch_agent` subagent has one.
 *
 * `renderWork` draws its steps as the chat draws a turn: the chat owns the
 * tool rows, and this module is one the transcript imports.
 */
export function SubagentDetail({
  entry,
  onBack,
  renderWork,
}: {
  entry: LineageEntry;
  onBack: () => void;
  renderWork: (message: ChatMessage) => ReactNode;
}) {
  const { run } = entry;
  const running = run.status === "running";
  const recent = [...(run.recentTools ?? []), ...(run.recentOutput ?? [])].length > 0;
  // Its steps as a turn of their own, still streaming while it runs.
  const work: ChatMessage | null =
    run.steps.length > 0
      ? {
          role: "assistant",
          text: "",
          parts: run.steps,
          reasoning: "",
          streaming: running,
          startedAt: null,
          completedAt: null,
          provider: entry.harness ?? "native",
        }
      : null;
  return (
    <div className="flex flex-col gap-4" data-testid="subagent-detail">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onBack}
          className="text-muted-foreground hover:text-foreground hover:bg-muted -ml-1.5 flex h-7 items-center gap-1.5 rounded-md px-1.5 text-xs"
        >
          <ArrowLeftIcon className="size-3.5" />
          Back to the thread
        </button>
      </div>
      <div className="flex items-start gap-3">
        <span className="bg-card grid size-9 shrink-0 place-items-center rounded-full border">
          <HarnessIcon harness={run.provider ?? entry.harness ?? "native"} size={18} />
        </span>
        <div className="flex min-w-0 flex-col gap-0.5">
          <h2 className="truncate text-base font-medium">{run.description ?? run.agent}</h2>
          <p className="text-muted-foreground flex flex-wrap items-center gap-x-1.5 text-xs">
            <span>{run.agent}</span>
            {run.model && <span className="font-mono">· {run.model}</span>}
            <span
              className={cn(
                run.status === "running" && "text-ucch-active",
                run.status === "failed" && "text-destructive",
              )}
            >
              · {run.status === "aborted" ? "stopped" : run.status === "completed" ? "done" : run.status}
            </span>
            <Figures toolCalls={run.toolCalls} durationMs={run.durationMs} costUsd={run.costUsd} />
          </p>
        </div>
      </div>

      <section className="flex flex-col gap-1.5" aria-label="Prompt">
        <h3 className="text-muted-foreground text-xs font-medium">Prompt</h3>
        <div className="bg-muted/50 rounded-lg border px-3 py-2 text-sm" data-testid="subagent-prompt">
          {run.prompt ? <Markdown>{run.prompt}</Markdown> : <span className="text-muted-foreground">Not recorded.</span>}
        </div>
      </section>

      {(work || recent || running) && (
        <section className="flex flex-col gap-1.5" aria-label="Work" data-testid="subagent-work">
          <h3 className="text-muted-foreground flex items-center gap-1.5 text-xs font-medium">
            Work
            {running && <span className="text-ucch-active font-normal">· live</span>}
          </h3>
          {work ? (
            renderWork(work)
          ) : recent ? (
            <RecentActivity tools={run.recentTools ?? []} output={run.recentOutput ?? []} />
          ) : (
            // Nothing reported yet, or a harness that reports only a line.
            <span className="text-muted-foreground text-xs">{run.summary ?? <Skeleton className="h-3 w-48" />}</span>
          )}
        </section>
      )}

      <section className="flex flex-col gap-1.5" aria-label="Result">
        <h3 className="text-muted-foreground text-xs font-medium">Result</h3>
        {running ? (
          <span className="text-muted-foreground text-xs">Still working; its answer lands here.</span>
        ) : run.result ? (
          <Result text={run.result} error={run.status === "failed"} />
        ) : (
          <span className="text-muted-foreground text-xs">
            {run.status === "aborted" ? "Stopped before it answered." : "No answer."}
          </span>
        )}
      </section>

      <p className="text-muted-foreground border-t pt-3 text-xs">
        This subagent ran inside its parent&apos;s harness, so it has no session of its own to chat with or rerun.
        Subagents started with <code className="font-mono">ucch_agent</code> get one.
      </p>
    </div>
  );
}

/**
 * OMP's window onto a running subagent: its last few tool calls and output
 * lines. A rolling view, not a log -- older ones scroll out as it works.
 */
function RecentActivity({ tools, output }: { tools: readonly string[]; output: readonly string[] }) {
  return (
    <div className="flex flex-col gap-2 text-xs" data-testid="subagent-recent">
      {tools.length > 0 && (
        <ul className="flex flex-wrap gap-1">
          {tools.map((tool, i) => (
            <li key={i} className="bg-muted text-muted-foreground rounded px-1.5 py-0.5 font-mono">
              {tool}
            </li>
          ))}
        </ul>
      )}
      {output.length > 0 && (
        <pre className="bg-muted/50 max-h-64 overflow-auto rounded border px-3 py-2 font-mono whitespace-pre-wrap @md:max-h-96">
          {output.join("\n")}
        </pre>
      )}
    </div>
  );
}
