"use client"

import * as React from "react"
import {
  CircleIcon,
  Loader2Icon,
  MessageSquarePlusIcon,
  MousePointer2Icon,
  MoveUpRightIcon,
  PencilIcon,
  RadioIcon,
  RatioIcon,
  Redo2Icon,
  RefreshCwIcon,
  RotateCwSquareIcon,
  SquareIcon,
  Trash2Icon,
  TypeIcon,
  Undo2Icon,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Segmented } from "@/components/ui/segmented"
import { ratioLabel, VIEWPORT_PRESETS, viewportFits } from "@/lib/browser-annotate"
import { PEN_COLORS } from "@/lib/image-annotate"
import { cn } from "@/lib/utils"

export type BrowserTool = "live" | "element" | "pen" | "arrow" | "rect" | "ellipse" | "text"

const icon = (Icon: React.ComponentType<{ className?: string }>, title: string) => (
  <span title={title}>
    <Icon className="size-3.5" />
  </span>
)

const TOOLS = [
  { value: "live", label: "Live", ariaLabel: "Live page", icon: RadioIcon },
  { value: "element", label: icon(MousePointer2Icon, "Pick an element"), ariaLabel: "Pick an element" },
  { value: "pen", label: icon(PencilIcon, "Draw"), ariaLabel: "Draw" },
  { value: "arrow", label: icon(MoveUpRightIcon, "Arrow"), ariaLabel: "Arrow" },
  { value: "rect", label: icon(SquareIcon, "Box"), ariaLabel: "Box" },
  { value: "ellipse", label: icon(CircleIcon, "Ellipse"), ariaLabel: "Ellipse" },
  { value: "text", label: icon(TypeIcon, "Note"), ariaLabel: "Note" },
] as const

/** The bar over the page: what the pointer does, how marks look, the page's size, and sending it all to the chat. */
export function BrowserToolbar({
  tool,
  onTool,
  color,
  onColor,
  widthIndex,
  onWidthIndex,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  onClear,
  onRetake,
  viewport,
  onResize,
  connected,
  busy,
  onSend,
  sending,
}: {
  tool: BrowserTool
  onTool: (tool: BrowserTool) => void
  color: string
  onColor: (color: string) => void
  widthIndex: "0" | "1" | "2"
  onWidthIndex: (index: "0" | "1" | "2") => void
  canUndo: boolean
  canRedo: boolean
  onUndo: () => void
  onRedo: () => void
  onClear: () => void
  onRetake: () => void
  viewport: { width: number; height: number }
  onResize: (width: number, height: number) => void
  connected: boolean
  /** A capture is being taken. */
  busy: boolean
  onSend: () => void
  sending: boolean
}) {
  const annotating = tool !== "live"
  return (
    <div
      role="toolbar"
      aria-label="Page tools"
      className="flex h-10 shrink-0 items-center gap-2 overflow-x-auto border-b px-2 [scrollbar-width:none] [&>*]:shrink-0"
    >
      <Segmented aria-label="Tool" size="sm" options={TOOLS} value={tool} onChange={onTool} disabled={busy || sending} />
      <div role="radiogroup" aria-label="Colour" className="flex items-center gap-1 px-0.5">
        {PEN_COLORS.map((c) => (
          <button
            key={c.value}
            type="button"
            role="radio"
            aria-checked={color === c.value}
            aria-label={c.label}
            title={c.label}
            onClick={() => onColor(c.value)}
            style={{ backgroundColor: c.value }}
            className={cn(
              "ring-offset-background size-4 rounded-full border outline-none focus-visible:ring-2 focus-visible:ring-ring",
              color === c.value && "ring-foreground ring-2 ring-offset-2",
            )}
          />
        ))}
      </div>
      <Segmented
        aria-label="Stroke width"
        size="sm"
        options={(["0", "1", "2"] as const).map((value, i) => ({
          value,
          ariaLabel: ["Thin", "Medium", "Thick"][i],
          label: <span className="bg-foreground inline-block w-3 rounded-full" style={{ height: 1 + i * 2 }} />,
        }))}
        value={widthIndex}
        onChange={onWidthIndex}
      />
      <div className="flex items-center">
        <Button variant="ghost" size="icon-sm" title="Undo (Ctrl+Z)" aria-label="Undo" disabled={!canUndo} onClick={onUndo}>
          <Undo2Icon />
        </Button>
        <Button variant="ghost" size="icon-sm" title="Redo (Ctrl+Shift+Z)" aria-label="Redo" disabled={!canRedo} onClick={onRedo}>
          <Redo2Icon />
        </Button>
        <Button variant="ghost" size="icon-sm" title="Clear the marks (Redo brings them back)" aria-label="Clear the marks" disabled={!canUndo} onClick={onClear}>
          <Trash2Icon />
        </Button>
        <Button variant="ghost" size="icon-sm" title="Capture the page again" aria-label="Capture the page again" disabled={!annotating || busy || sending} onClick={onRetake}>
          {busy ? <Loader2Icon className="animate-spin" /> : <RefreshCwIcon />}
        </Button>
      </div>
      <div className="ml-auto flex items-center gap-1.5">
        <RatioMenu viewport={viewport} onResize={onResize} disabled={annotating || !connected} annotating={annotating} />
        <Button size="sm" disabled={!annotating || !canUndo || busy || sending} onClick={onSend}>
          {sending ? <Loader2Icon className="animate-spin" /> : <MessageSquarePlusIcon />}
          Add to chat
        </Button>
      </div>
    </div>
  )
}

function RatioMenu({
  viewport,
  onResize,
  disabled,
  annotating,
}: {
  viewport: { width: number; height: number }
  onResize: (width: number, height: number) => void
  disabled: boolean
  annotating: boolean
}) {
  const [open, setOpen] = React.useState(false)
  const [width, setWidth] = React.useState("")
  const [height, setHeight] = React.useState("")
  const choose = (w: number, h: number) => {
    onResize(w, h)
    setOpen(false)
  }
  const custom = viewportFits(Number(width), Number(height))
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) return
        setWidth(String(viewport.width))
        setHeight(String(viewport.height))
      }}
    >
      <PopoverTrigger
        render={
          <Button
            variant="outline"
            size="sm"
            disabled={disabled}
            aria-label={`Aspect ratio: ${viewport.width} by ${viewport.height}`}
            title={annotating ? "Go back to Live to change the aspect ratio" : "Aspect ratio"}
          />
        }
      >
        <RatioIcon />
        <span className="tabular-nums">{ratioLabel(viewport.width, viewport.height)}</span>
        <span className="text-muted-foreground text-xs tabular-nums">
          {viewport.width}×{viewport.height}
        </span>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-64 gap-1 p-1.5">
        {VIEWPORT_PRESETS.map((p) => (
          <button
            key={p.label}
            type="button"
            aria-pressed={p.width === viewport.width && p.height === viewport.height}
            onClick={() => choose(p.width, p.height)}
            className="hover:bg-muted aria-pressed:bg-accent aria-pressed:text-accent-foreground focus-visible:ring-ring flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-sm outline-none focus-visible:ring-2"
          >
            <span>{p.label}</span>
            <span className="text-muted-foreground ml-auto text-xs tabular-nums">
              {ratioLabel(p.width, p.height)} · {p.width}×{p.height}
            </span>
          </button>
        ))}
        <form
          className="flex items-center gap-1 border-t px-1 pt-2 pb-1"
          onSubmit={(event) => {
            event.preventDefault()
            if (custom) choose(Number(width), Number(height))
          }}
        >
          <Input aria-label="Width" type="number" min={240} max={3840} value={width} onChange={(e) => setWidth(e.target.value)} className="h-7 text-xs" />
          <span className="text-muted-foreground text-xs">×</span>
          <Input aria-label="Height" type="number" min={240} max={2400} value={height} onChange={(e) => setHeight(e.target.value)} className="h-7 text-xs" />
          <Button type="submit" size="sm" variant="outline" disabled={!custom}>
            Set
          </Button>
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            title="Rotate"
            aria-label="Rotate"
            disabled={!viewportFits(viewport.height, viewport.width)}
            onClick={() => choose(viewport.height, viewport.width)}
          >
            <RotateCwSquareIcon />
          </Button>
        </form>
      </PopoverContent>
    </Popover>
  )
}
