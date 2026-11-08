"use client"

import * as React from "react"
import { ChevronRightIcon, Loader2Icon } from "lucide-react"

import { Markdown, StreamingMarkdown } from "@/components/markdown"
import { SubagentCard } from "@/components/subagent-card"
import {
  formatDuration,
  isSubagentCall,
  splitThinking,
  type ChatMessage,
  type CompactionPart,
  type ToolPart,
} from "@/lib/chat-messages"
import type { DiffLine } from "@/lib/git-diff"
import { highlightLines, type Token } from "@/lib/highlight-lines"
import {
  classifyTool,
  diffStats,
  lineDiff,
  parseShellResult,
  trimContext,
  type ToolView,
} from "@/lib/tool-transcript"
import { cn } from "@/lib/utils"

/** How many lines of a command's output or a written file show before "show all". */
const PREVIEW_LINES = 12

/**
 * An assistant turn the way a CLI prints it: everything the agent did, in the
 * order it did it, nothing folded away. Prose as Markdown, thinking as a dim
 * line, shell calls as the command with its output and exit code, edits as
 * diffs. A call it has no special drawing for goes to `renderOther`, the
 * default view's row.
 */
export function TranscriptTurn({
  message,
  renderOther,
  renderCompaction,
  caret,
}: {
  message: ChatMessage
  renderOther: (call: ToolPart) => React.ReactNode
  renderCompaction: (part: CompactionPart, key: string) => React.ReactNode
  /** Drawn after the last item while the turn is still working on something other than prose. */
  caret: React.ReactNode
}) {
  const items: React.ReactNode[] = []
  if (message.reasoning) items.push(<Thinking key="reasoning" text={message.reasoning} />)

  let lastIsStreamingProse = false
  message.parts.forEach((part, i) => {
    lastIsStreamingProse = false
    if (part.kind === "compaction") {
      items.push(renderCompaction(part, `compaction-${i}`))
      return
    }
    if (part.kind === "tool") {
      items.push(<TranscriptTool key={part.id} call={part} harness={message.provider} renderOther={renderOther} />)
      return
    }
    const segments = splitThinking(part.text)
    segments.forEach((segment, j) => {
      const key = `${i}-${j}`
      if (segment.kind === "think") {
        items.push(<Thinking key={key} text={segment.text} />)
        return
      }
      const live = message.streaming && part.streaming && i === message.parts.length - 1 && j === segments.length - 1
      lastIsStreamingProse = live
      items.push(
        <div key={key} className="flex gap-2">
          <Bullet tone="text" />
          <div className="min-w-0 flex-1">
            {live ? (
              <StreamingMarkdown className="streaming-caret">{segment.text}</StreamingMarkdown>
            ) : (
              <Markdown>{segment.text}</Markdown>
            )}
          </div>
        </div>,
      )
    })
  })

  return (
    <div className="flex flex-col gap-2.5" data-testid="chat-transcript">
      {items}
      {message.streaming && !lastIsStreamingProse && caret}
    </div>
  )
}

function TranscriptTool({
  call,
  harness,
  renderOther,
}: {
  call: ToolPart
  /** The turn's provider: what a subagent without one of its own runs inside. */
  harness?: string
  renderOther: (call: ToolPart) => React.ReactNode
}) {
  if (isSubagentCall(call.name) || call.subagents) return <SubagentCard call={call} harness={harness} />
  const view = classifyTool(call)
  switch (view.kind) {
    case "shell":
      return <ShellCall call={call} command={view.command} />
    case "edit":
    case "write":
      return <EditCall call={call} view={view} />
    case "patch":
      return <PatchCall call={call} path={view.path} patch={view.patch} />
    case "files":
      return (
        <ToolLine call={call} verb="Update" label={view.changes.map((c) => c.path).join(", ")}>
          <ul className="font-mono text-xs">
            {view.changes.map((c) => (
              <li key={c.path}>
                <span className={c.change === "add" ? "text-success" : c.change === "delete" ? "text-danger" : "text-muted-foreground"}>
                  {c.change}
                </span>{" "}
                {c.path}
              </li>
            ))}
          </ul>
        </ToolLine>
      )
    case "delete":
      return <ToolLine call={call} verb="Delete" label={view.path} />
    case "read":
      return <ToolLine call={call} verb={view.verb} label={view.label} collapsedResult />
    case "other":
      return <>{renderOther(call)}</>
  }
}

/** A bullet in the margin, coloured by how the call went. */
function Bullet({ tone }: { tone: "text" | "running" | "ok" | "error" | "waiting" }) {
  return (
    <span
      aria-hidden
      className={cn(
        "mt-[0.45rem] size-1.5 shrink-0 rounded-full",
        tone === "text" && "bg-foreground/60",
        tone === "running" && "bg-muted-foreground animate-pulse",
        tone === "ok" && "bg-success",
        tone === "error" && "bg-danger",
        tone === "waiting" && "bg-ucch-active animate-pulse",
      )}
    />
  )
}

function toneOf(call: ToolPart, failed = call.isError): "running" | "ok" | "error" | "waiting" {
  if (call.result === null) return call.awaitingApproval ? "waiting" : "running"
  return failed ? "error" : "ok"
}

/** The right end of a call's header: running, waiting, failed, how long it took. */
function Status({ call, extra }: { call: ToolPart; extra?: React.ReactNode }) {
  const duration = formatDuration(call.durationMs)
  return (
    <span className="text-muted-foreground ml-auto flex shrink-0 items-center gap-1.5 text-xs">
      {extra}
      {call.result === null ? (
        call.awaitingApproval ? (
          <span className="text-ucch-active">needs approval</span>
        ) : (
          <Loader2Icon className="size-3 animate-spin" />
        )
      ) : (
        duration && <span className="tabular-nums">{duration}</span>
      )}
    </span>
  )
}

function Header({ call, verb, label, tone, extra }: { call: ToolPart; verb: string; label: string; tone?: ReturnType<typeof toneOf>; extra?: React.ReactNode }) {
  return (
    <div className="flex min-w-0 items-start gap-2 text-sm">
      <Bullet tone={tone ?? toneOf(call)} />
      <span className="min-w-0 truncate font-mono text-xs leading-5">
        <span className="text-foreground font-semibold">{verb}</span>
        <span className="text-muted-foreground">(</span>
        <span className="text-foreground">{label}</span>
        <span className="text-muted-foreground">)</span>
      </span>
      <Status call={call} extra={extra} />
    </div>
  )
}

/** A one-line call; its result, if any, a click away. Errors are always shown. */
function ToolLine({
  call,
  verb,
  label,
  collapsedResult,
  children,
}: {
  call: ToolPart
  verb: string
  label: string
  collapsedResult?: boolean
  children?: React.ReactNode
}) {
  return (
    <div className="flex flex-col gap-1">
      <Header call={call} verb={verb} label={label} />
      <Indent>
        {children}
        {call.isError && call.result !== null ? (
          <Output text={call.result} error />
        ) : (
          collapsedResult &&
          call.result && (
            <details className="group/res text-muted-foreground text-xs">
              <summary className="flex cursor-pointer list-none items-center gap-1 select-none [&::-webkit-details-marker]:hidden">
                <ChevronRightIcon className="size-3 transition-transform group-open/res:rotate-90" />
                {countLines(call.result)} {countLines(call.result) === 1 ? "line" : "lines"}
              </summary>
              <Output text={call.result} />
            </details>
          )
        )}
      </Indent>
    </div>
  )
}

function Indent({ children }: { children: React.ReactNode }) {
  return <div className="ml-[0.1875rem] min-w-0 border-l pl-[1.0625rem] empty:hidden">{children}</div>
}

function ShellCall({ call, command }: { call: ToolPart; command: string }) {
  const parsed = call.result === null ? null : parseShellResult(call.result)
  const exitCode = parsed?.exitCode ?? null
  const failed = exitCode !== null ? exitCode !== 0 : call.isError
  const badge =
    call.result === null ? null : (
      <span
        className={cn(
          "rounded px-1.5 py-px font-mono text-[0.65rem] font-medium",
          failed ? "bg-danger-soft text-danger" : "bg-success-soft text-success",
        )}
      >
        {exitCode !== null ? `exit ${exitCode}` : failed ? "failed" : "ok"}
      </span>
    )

  return (
    <div className="flex flex-col gap-1">
      <div className="flex min-w-0 items-start gap-2">
        <Bullet tone={toneOf(call, failed)} />
        <pre className="text-foreground min-w-0 flex-1 font-mono text-xs leading-5 break-all whitespace-pre-wrap">
          <span className="text-muted-foreground select-none">$ </span>
          {command}
        </pre>
        <Status call={call} extra={badge} />
      </div>
      {parsed && parsed.output && (
        <Indent>
          <Output text={parsed.output} error={failed} />
        </Indent>
      )}
    </div>
  )
}

/** Monospace output, cut to its first lines until asked for the rest. */
function Output({ text, error }: { text: string; error?: boolean }) {
  const [all, setAll] = React.useState(false)
  const lines = text.split("\n")
  const cut = !all && lines.length > PREVIEW_LINES
  return (
    <div className="flex flex-col gap-1">
      <pre
        className={cn(
          "bg-muted/40 max-h-[32rem] overflow-auto rounded px-2 py-1.5 font-mono text-xs leading-5 whitespace-pre-wrap",
          error ? "text-danger" : "text-muted-foreground",
        )}
      >
        {cut ? lines.slice(0, PREVIEW_LINES).join("\n") : text}
      </pre>
      {lines.length > PREVIEW_LINES && (
        <button
          type="button"
          onClick={() => setAll((v) => !v)}
          className="text-muted-foreground hover:text-foreground self-start text-xs"
        >
          {all ? "Show less" : `… ${lines.length - PREVIEW_LINES} more lines`}
        </button>
      )}
    </div>
  )
}

function EditCall({ call, view }: { call: ToolPart; view: Extract<ToolView, { kind: "edit" | "write" }> }) {
  const blocks = React.useMemo(
    () => (view.kind === "write" ? [lineDiff("", view.content)] : view.edits.map((e) => lineDiff(e.old, e.new))),
    [view],
  )
  const stats = blocks.reduce(
    (sum, lines) => {
      const s = diffStats(lines)
      return { added: sum.added + s.added, removed: sum.removed + s.removed }
    },
    { added: 0, removed: 0 },
  )
  const counts = (
    <span className="font-mono tabular-nums">
      <span className="text-success">+{stats.added}</span> <span className="text-danger">−{stats.removed}</span>
    </span>
  )

  return (
    <div className="flex flex-col gap-1">
      <Header call={call} verb={view.kind === "write" ? "Write" : "Update"} label={view.path} extra={counts} />
      <Indent>
        <div className="flex flex-col gap-1">
          {blocks.map((lines, i) => (
            <DiffBlock key={i} lines={lines} path={view.path} capped={view.kind === "write"} />
          ))}
          {call.isError && call.result !== null && <Output text={call.result} error />}
        </div>
      </Indent>
    </div>
  )
}

/** Diff lines with +/− and syntax colour, coloured per side so multi-line constructs read right. */
function DiffBlock({ lines, path, capped }: { lines: DiffLine[]; path: string; capped?: boolean }) {
  const [all, setAll] = React.useState(false)
  const tokens = React.useMemo(() => {
    const old = lines.filter((l) => l.kind !== "add").map((l) => l.text)
    const neu = lines.filter((l) => l.kind !== "del").map((l) => l.text)
    return { old: highlightLines(old.join("\n"), path), new: highlightLines(neu.join("\n"), path) }
  }, [lines, path])
  const trimmed = React.useMemo(() => trimContext(lines), [lines])
  const shown = capped && !all && trimmed.length > PREVIEW_LINES ? trimmed.slice(0, PREVIEW_LINES) : trimmed

  const tokensFor = (line: DiffLine): Token[] => {
    const row = line.kind === "del" ? tokens.old[(line.oldNo ?? 0) - 1] : tokens.new[(line.newNo ?? 0) - 1]
    return row ?? (line.text ? [{ text: line.text, cls: "" }] : [])
  }

  if (lines.length === 0) return <p className="text-muted-foreground text-xs">(empty)</p>

  return (
    <div className="flex flex-col gap-1">
      <div className="overflow-x-auto rounded border">
        <table className="w-full border-collapse font-mono text-xs leading-5">
          <tbody>
            {shown.map((line, i) =>
              line.kind === "gap" ? (
                <tr key={i} className="bg-muted/60 text-muted-foreground">
                  <td colSpan={2} className="px-2 select-none">
                    ⋯ {line.count} unchanged {line.count === 1 ? "line" : "lines"}
                  </td>
                </tr>
              ) : (
                <tr key={i} className={cn(line.kind === "add" && "bg-diff-add", line.kind === "del" && "bg-diff-del")}>
                  <td className="text-text-subtle w-8 min-w-8 border-r px-1.5 text-right align-top select-none">
                    {line.kind === "del" ? line.oldNo : line.newNo}
                  </td>
                  <td className="w-full px-2 whitespace-pre">
                    <span className="text-muted-foreground mr-2 inline-block w-3 select-none" aria-hidden>
                      {line.kind === "add" ? "+" : line.kind === "del" ? "−" : " "}
                    </span>
                    {line.kind !== "context" && (
                      <span className="sr-only">{line.kind === "add" ? "Added: " : "Removed: "}</span>
                    )}
                    {tokensFor(line).map((token, t) => (
                      <span key={t} className={token.cls || undefined}>
                        {token.text}
                      </span>
                    ))}
                  </td>
                </tr>
              ),
            )}
          </tbody>
        </table>
      </div>
      {capped && trimmed.length > PREVIEW_LINES && (
        <button
          type="button"
          onClick={() => setAll((v) => !v)}
          className="text-muted-foreground hover:text-foreground self-start text-xs"
        >
          {all ? "Show less" : `… ${trimmed.length - PREVIEW_LINES} more lines`}
        </button>
      )}
    </div>
  )
}

/** A patch as written, its +/− lines tinted. For edits that only come as a patch. */
function PatchCall({ call, path, patch }: { call: ToolPart; path: string | null; patch: string }) {
  return (
    <div className="flex flex-col gap-1">
      <Header call={call} verb="Update" label={path ?? "patch"} />
      <Indent>
        <pre className="max-h-[32rem] overflow-auto rounded border font-mono text-xs leading-5">
          {patch.split("\n").map((line, i) => (
            <div
              key={i}
              className={cn(
                "px-2 whitespace-pre",
                line.startsWith("+") && !line.startsWith("+++") && "bg-diff-add",
                line.startsWith("-") && !line.startsWith("---") && "bg-diff-del",
                /^(@@|\[|\*\*\*)/.test(line) && "bg-muted/60 text-muted-foreground",
              )}
            >
              {line || " "}
            </div>
          ))}
        </pre>
        {call.isError && call.result !== null && <Output text={call.result} error />}
      </Indent>
    </div>
  )
}

/** Thinking, as one dim line that opens to the whole thought. */
function Thinking({ text }: { text: string }) {
  const trimmed = text.trim()
  if (!trimmed) return null
  return (
    <details className="group/think text-muted-foreground text-xs">
      <summary className="flex cursor-pointer list-none items-center gap-2 select-none [&::-webkit-details-marker]:hidden">
        <span aria-hidden className="w-1.5 shrink-0 text-center">✻</span>
        <span className="italic">Thinking</span>
        <span className="text-text-subtle truncate">{trimmed.split("\n")[0]}</span>
        <ChevronRightIcon className="size-3 shrink-0 transition-transform group-open/think:rotate-90" />
      </summary>
      <p className="mt-1 ml-[0.1875rem] border-l pl-[1.0625rem] whitespace-pre-wrap">{trimmed}</p>
    </details>
  )
}

function countLines(text: string): number {
  return text.replace(/\n$/, "").split("\n").length
}
