"use client"

import * as React from "react"
import { ChevronRightIcon, Loader2Icon } from "lucide-react"

import { Markdown, StreamingMarkdown } from "@/components/markdown"
import { SubagentCard } from "@/components/subagent-card"
import { ToolWidget } from "@/components/widget-frame"
import {
  formatDuration,
  isSubagentCall,
  splitThinking,
  type ChatMessage,
  type CompactionPart,
  type ToolPart,
} from "@/lib/chat-messages"
import type { FileDiff } from "@ucch/protocol"
import { highlightLines, type Token } from "@/lib/highlight-lines"
import { classifyTool, fileViews, inputViews, parseShellResult, type FileView } from "@/lib/tool-transcript"
import { cn } from "@/lib/utils"

/** How many lines show before "show all": of output and thought, of a diff, of what was read. */
const PREVIEW_LINES = 30
const DIFF_LINES = 40
const READ_LINES = 6
const PREVIEW_WIDTH = 200
/** Subagents inside subagents are drawn this deep. */
const MAX_DEPTH = 3

/**
 * An assistant turn the way a CLI prints it: everything the agent did, in the
 * order it did it, nothing folded away. Prose as Markdown, thinking as a dim
 * line, shell calls as the command with its output and exit code, edits as
 * diffs, subagents' own steps under their card, and what the turn changed
 * altogether at its end.
 */
export function TranscriptTurn({
  message,
  renderCompaction,
  caret,
  depth = 0,
}: {
  message: ChatMessage
  renderCompaction: (part: CompactionPart, key: string) => React.ReactNode
  /** Drawn after the last item while the turn is still working on something other than prose. */
  caret: React.ReactNode
  depth?: number
}) {
  const items: React.ReactNode[] = []

  let lastIsStreamingProse = false
  message.parts.forEach((part, i) => {
    lastIsStreamingProse = false
    if (part.kind === "compaction") {
      items.push(renderCompaction(part, `compaction-${i}`))
      return
    }
    if (part.kind === "thinking") {
      const live = message.streaming && part.streaming && i === message.parts.length - 1
      lastIsStreamingProse = live
      items.push(<Thinking key={`thinking-${i}`} text={part.text} live={live} />)
      return
    }
    if (part.kind === "tool") {
      items.push(
        <TranscriptTool key={part.id} call={part} harness={message.provider} renderCompaction={renderCompaction} depth={depth} />,
      )
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
      {message.turnDiff && message.turnDiff.files.length > 0 && <TurnDiff message={message} turnDiff={message.turnDiff} />}
    </div>
  )
}

function TranscriptTool({
  call,
  harness,
  renderCompaction,
  depth,
}: {
  call: ToolPart
  /** The turn's provider: what a subagent without one of its own runs inside. */
  harness?: string
  renderCompaction: (part: CompactionPart, key: string) => React.ReactNode
  depth: number
}) {
  // Deltas re-render the whole turn; a settled call's views stay as they were.
  const view = React.useMemo(() => classifyTool(call), [call.name, call.input])
  const files = React.useMemo(() => (call.diffs?.length ? fileViews(call.diffs) : inputViews(view)), [call.diffs, view])

  if (isSubagentCall(call.name) || call.subagents) {
    return (
      <div className="flex flex-col gap-2">
        <SubagentCard call={call} harness={harness} />
        {depth < MAX_DEPTH &&
          (call.subagents ?? [])
            .filter((run) => run.steps.length > 0)
            .map((run) => (
              <Indent key={run.id}>
                <TranscriptTurn
                  message={{
                    role: "assistant",
                    text: "",
                    parts: run.steps,
                    streaming: run.status === "running",
                    startedAt: null,
                    completedAt: null,
                    provider: run.provider ?? harness,
                  }}
                  renderCompaction={renderCompaction}
                  caret={null}
                  depth={depth + 1}
                />
              </Indent>
            ))}
      </div>
    )
  }
  if (files) return <EditCall call={call} files={files} verb={view.kind === "write" ? "Write" : view.kind === "delete" ? "Delete" : "Update"} />
  switch (view.kind) {
    case "widget":
      return <ToolWidget name={call.name} input={call.input} />
    case "shell":
      return <ShellCall call={call} command={view.command} />
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
    case "todo":
      return (
        <ToolLine call={call} verb="Plan" label={`${view.items.filter((t) => t.status === "done").length}/${view.items.length}`}>
          <ul className="text-xs leading-5">
            {view.items.map((item, i) => (
              <li
                key={i}
                className={cn(
                  item.status === "done" && "text-muted-foreground line-through",
                  item.status === "active" && "text-foreground font-medium",
                  item.status === "pending" && "text-muted-foreground",
                )}
              >
                <span aria-hidden>{item.status === "done" ? "☑" : item.status === "active" ? "▶" : "☐"}</span>{" "}
                <span className="sr-only">{item.status}: </span>
                {item.text}
              </li>
            ))}
          </ul>
        </ToolLine>
      )
    case "delete":
      return <ToolLine call={call} verb="Delete" label={view.path} />
    case "read":
      return <ToolLine call={call} verb={view.verb} label={view.label} showResult />
    default:
      return <GenericCall call={call} />
  }
}

/** A call with no drawing of its own: an MCP tool, say. Its input and its result. */
function GenericCall({ call }: { call: ToolPart }) {
  const input = React.useMemo(() => describeInput(call.input), [call.input])
  const inline = input.length <= 100 && !input.includes("\n")
  return (
    <div className="flex flex-col gap-1">
      <Header call={call} verb={call.name} label={inline ? input : ""} />
      <Indent>
        <div className="flex flex-col gap-1 empty:hidden">
          {!inline && <Output text={input} />}
          {call.result && <Output text={call.result} error={call.isError} />}
        </div>
      </Indent>
    </div>
  )
}

/** `name: value` lines for an object, strings as they read; JSON for what is deeper. */
function describeInput(input: unknown): string {
  if (input === null || input === undefined) return ""
  if (typeof input === "string") return input
  if (typeof input !== "object") return String(input)
  try {
    if (Array.isArray(input)) return JSON.stringify(input, null, 2)
    return Object.entries(input)
      .filter(([, value]) => value !== null && value !== undefined)
      .map(([key, value]) => `${key}: ${typeof value === "string" ? value : JSON.stringify(value, null, 2)}`)
      .join("\n")
  } catch {
    return String(input)
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
          <>
            <Elapsed since={call.startedAt} />
            <Loader2Icon className="size-3 animate-spin" />
          </>
        )
      ) : (
        duration && <span className="tabular-nums">{duration}</span>
      )}
    </span>
  )
}

/** How long a running call has been at it, told once it is worth telling. */
function Elapsed({ since }: { since?: number }) {
  const [now, setNow] = React.useState<number | null>(null)
  React.useEffect(() => {
    if (!since) return
    const tick = () => setNow(Date.now())
    const timer = setInterval(tick, 1000)
    return () => clearInterval(timer)
  }, [since])
  if (!since || now === null || now - since < 2000) return null
  return <span className="tabular-nums">{Math.floor((now - since) / 1000)}s</span>
}

function Header({ call, verb, label, tone, extra }: { call: ToolPart; verb: string; label: string; tone?: ReturnType<typeof toneOf>; extra?: React.ReactNode }) {
  return (
    <div className="flex min-w-0 items-start gap-2 text-sm">
      <Bullet tone={tone ?? toneOf(call)} />
      <span className="min-w-0 truncate font-mono text-xs leading-5">
        <span className="text-foreground font-semibold">{verb}</span>
        {label && (
          <>
            <span className="text-muted-foreground">(</span>
            <span className="text-foreground">{label}</span>
            <span className="text-muted-foreground">)</span>
          </>
        )}
      </span>
      <Status call={call} extra={extra} />
    </div>
  )
}

/** A one-line call, with the start of its result. Errors are always shown. */
function ToolLine({
  call,
  verb,
  label,
  showResult,
  children,
}: {
  call: ToolPart
  verb: string
  label: string
  showResult?: boolean
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
          showResult && call.result && <Output text={call.result.replace(/\s+$/, "")} preview={READ_LINES} />
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
function Output({ text, error, preview = PREVIEW_LINES }: { text: string; error?: boolean; preview?: number }) {
  const [all, setAll] = React.useState(false)
  const lines = text.split("\n")
  // A few very long lines are as much to read past as many short ones.
  const start = lines.slice(0, preview).join("\n").slice(0, preview * PREVIEW_WIDTH)
  const long = start.length < text.length
  const cut = !all && long
  return (
    <div className="flex flex-col gap-1">
      <pre
        className={cn(
          "bg-muted/40 max-h-[32rem] overflow-auto rounded px-2 py-1.5 font-mono text-xs leading-5 wrap-anywhere whitespace-pre-wrap",
          error ? "text-danger" : "text-muted-foreground",
        )}
      >
        {cut ? start : text}
      </pre>
      {long && (
        <button
          type="button"
          onClick={() => setAll((v) => !v)}
          className="text-muted-foreground hover:text-foreground self-start text-xs"
        >
          {all ? "Show less" : lines.length > preview ? `… ${lines.length - preview} more lines` : "… Show all"}
        </button>
      )}
    </div>
  )
}

function Counts({ added, removed }: { added: number; removed: number }) {
  return (
    <span className="font-mono tabular-nums">
      <span className="text-success">+{added}</span> <span className="text-danger">−{removed}</span>
    </span>
  )
}

function nameOf(file: FileView): string {
  return file.oldPath ? `${file.oldPath} → ${file.path}` : file.path
}

function EditCall({ call, files, verb }: { call: ToolPart; files: FileView[]; verb: string }) {
  const only = files.length === 1 ? files[0]! : null
  const added = files.reduce((n, f) => n + f.added, 0)
  const removed = files.reduce((n, f) => n + f.removed, 0)
  const told = only && call.diffs?.length ? (only.change === "added" ? "Create" : only.change === "deleted" ? "Delete" : "Update") : verb
  const failed = call.isError && call.result !== null
  return (
    <div className="flex flex-col gap-1">
      <Header
        call={call}
        verb={told}
        label={only ? nameOf(only) : `${files.length} files`}
        extra={
          <>
            {failed && <span className="text-danger">not applied</span>}
            <Counts added={added} removed={removed} />
          </>
        }
      />
      <Indent>
        <div className="flex flex-col gap-1">
          {files.map((file, i) => (
            <div key={i} className="flex min-w-0 flex-col gap-1">
              {!only && (
                <span className="flex gap-2 font-mono text-xs">
                  <span className="min-w-0 truncate">{nameOf(file)}</span>
                  <Counts added={file.added} removed={file.removed} />
                </span>
              )}
              <DiffBlock file={file} />
            </div>
          ))}
          {failed && <Output text={call.result!} error />}
        </div>
      </Indent>
    </div>
  )
}

/**
 * Everything the turn changed, from comparing its tree before and after. The
 * files no step above showed -- a command changed them -- are open.
 */
function TurnDiff({ message, turnDiff }: { message: ChatMessage; turnDiff: { files: FileDiff[]; shared: boolean; omittedFiles: number } }) {
  const files = React.useMemo(() => fileViews(turnDiff.files), [turnDiff])
  const shown = React.useMemo(() => shownPaths(message.parts), [message.parts])
  const added = files.reduce((n, f) => n + f.added, 0)
  const removed = files.reduce((n, f) => n + f.removed, 0)
  const count = files.length + turnDiff.omittedFiles
  return (
    <section className="flex flex-col gap-1.5 border-t pt-2.5" aria-label="Files changed this turn" data-testid="turn-diff">
      <div className="flex flex-wrap items-center gap-x-2 text-xs">
        <span className="font-medium">
          {count} {count === 1 ? "file" : "files"} changed this turn
        </span>
        <Counts added={added} removed={removed} />
        {turnDiff.shared && <span className="text-muted-foreground">may include changes made by others in this checkout</span>}
      </div>
      {files.map((file) => {
        // Shown by the steps only if they add up to it: a command may have
        // changed the same file besides.
        const steps = shown.get(file.path)
        const byCommand = !steps || steps.added !== file.added || steps.removed !== file.removed
        return (
          <details key={file.path} open={byCommand} className="group/file min-w-0">
            <summary className="flex cursor-pointer list-none items-center gap-2 font-mono text-xs select-none [&::-webkit-details-marker]:hidden">
              <ChevronRightIcon className="text-muted-foreground size-3 shrink-0 transition-transform group-open/file:rotate-90" />
              <span className="min-w-0 truncate">{nameOf(file)}</span>
              {file.change !== "modified" && <span className="text-muted-foreground">{file.change}</span>}
              {byCommand && <span className="text-muted-foreground font-sans">{steps ? "also changed outside the edits above" : "changed outside the edits above"}</span>}
              <span className="ml-auto shrink-0">
                <Counts added={file.added} removed={file.removed} />
              </span>
            </summary>
            <div className="mt-1">
              <DiffBlock file={file} />
            </div>
          </details>
        )
      })}
      {turnDiff.omittedFiles > 0 && <p className="text-muted-foreground text-xs">… {turnDiff.omittedFiles} more files</p>}
    </section>
  )
}

/** What the turn's own calls showed of each path, its subagents' with them. */
function shownPaths(parts: ChatMessage["parts"], into = new Map<string, { added: number; removed: number }>()) {
  for (const part of parts) {
    if (part.kind !== "tool") continue
    for (const diff of part.diffs ?? []) {
      const sum = into.get(diff.path) ?? { added: 0, removed: 0 }
      into.set(diff.path, { added: sum.added + diff.added, removed: sum.removed + diff.removed })
    }
    for (const run of part.subagents ?? []) shownPaths(run.steps, into)
  }
  return into
}

type Row = { kind: "gap" } | { kind: "line"; hunk: number; line: FileView["hunks"][number][number]; at: number }

/** A file's hunks with +/− and syntax colour, coloured per side so multi-line constructs read right. */
function DiffBlock({ file }: { file: FileView }) {
  const [all, setAll] = React.useState(false)
  const rows = React.useMemo(() => {
    const out: Row[] = []
    file.hunks.forEach((lines, hunk) => {
      if (hunk > 0) out.push({ kind: "gap" })
      let old = 0
      let neu = 0
      for (const line of lines) {
        out.push({ kind: "line", hunk, line, at: line.kind === "del" ? old : neu })
        if (line.kind !== "add") old++
        if (line.kind !== "del") neu++
      }
    })
    return out
  }, [file])
  const tokens = React.useMemo(
    () =>
      file.hunks.map((lines) => ({
        old: highlightLines(lines.filter((l) => l.kind !== "add").map((l) => l.text).join("\n"), file.path),
        new: highlightLines(lines.filter((l) => l.kind !== "del").map((l) => l.text).join("\n"), file.path),
      })),
    [file],
  )
  const shown = all ? rows : rows.slice(0, DIFF_LINES)

  const tokensFor = (row: Extract<Row, { kind: "line" }>): Token[] => {
    const side = tokens[row.hunk]!
    return (row.line.kind === "del" ? side.old : side.new)[row.at] ?? (row.line.text ? [{ text: row.line.text, cls: "" }] : [])
  }
  const number = "text-text-subtle w-8 min-w-8 px-1.5 text-right align-top select-none"

  if (rows.length === 0) {
    return (
      <p className="text-muted-foreground text-xs">
        {file.truncated ? "Too large to show." : file.oldPath ? "Moved, contents unchanged." : "No text to show: empty or binary."}
      </p>
    )
  }

  return (
    <div className="flex flex-col gap-1">
      <div className="overflow-x-auto rounded border">
        <table className="w-full border-collapse font-mono text-xs leading-5">
          <tbody>
            {shown.map((row, i) =>
              row.kind === "gap" ? (
                <tr key={i} className="bg-muted/60 text-muted-foreground">
                  <td colSpan={3} className="px-2 select-none">
                    ⋯
                  </td>
                </tr>
              ) : (
                <tr key={i} className={cn(row.line.kind === "add" && "bg-diff-add", row.line.kind === "del" && "bg-diff-del")}>
                  {file.numbered && (
                    <>
                      <td className={number}>{row.line.kind !== "add" && row.line.oldNo}</td>
                      <td className={cn(number, "border-r")}>{row.line.kind !== "del" && row.line.newNo}</td>
                    </>
                  )}
                  <td className="w-full px-2 whitespace-pre">
                    <span
                      className={cn(
                        "mr-2 inline-block w-3 select-none",
                        row.line.kind === "add" ? "text-success" : row.line.kind === "del" ? "text-danger" : "text-muted-foreground",
                      )}
                      aria-hidden
                    >
                      {row.line.kind === "add" ? "+" : row.line.kind === "del" ? "−" : " "}
                    </span>
                    {row.line.kind !== "context" && (
                      <span className="sr-only">{row.line.kind === "add" ? "Added: " : "Removed: "}</span>
                    )}
                    {tokensFor(row).map((token, t) => (
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
      {rows.length > DIFF_LINES && (
        <button
          type="button"
          onClick={() => setAll((v) => !v)}
          className="text-muted-foreground hover:text-foreground self-start text-xs"
        >
          {all ? "Show less" : `… ${rows.length - DIFF_LINES} more lines`}
        </button>
      )}
      {file.truncated && <p className="text-muted-foreground text-xs">Cut short: the rest of this change is not kept.</p>}
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

/** A thought, as it was thought; a very long one opens on request. */
function Thinking({ text, live }: { text: string; live?: boolean }) {
  const [all, setAll] = React.useState(false)
  const trimmed = text.trim()
  if (!trimmed) return null
  const lines = trimmed.split("\n")
  const long = !live && lines.length > PREVIEW_LINES
  const shown = long && !all ? lines.slice(0, PREVIEW_LINES).join("\n") : trimmed
  return (
    <div className="text-muted-foreground flex gap-2 text-xs" data-testid="transcript-thinking">
      <span aria-hidden className="w-1.5 shrink-0 text-center leading-5">
        ✻
      </span>
      <div className="min-w-0 flex-1 italic">
        <span className="sr-only">Thinking: </span>
        <Markdown className={cn("text-muted-foreground text-xs", live && "streaming-caret")}>{shown}</Markdown>
        {long && (
          <button type="button" onClick={() => setAll((v) => !v)} className="hover:text-foreground not-italic">
            {all ? "Show less" : `… ${lines.length - PREVIEW_LINES} more lines`}
          </button>
        )}
      </div>
    </div>
  )
}
