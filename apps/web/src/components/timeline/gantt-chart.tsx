"use client"

import * as React from "react"

import {
  barGeometry,
  daysFromDelta,
  dependencyPath,
  headerTicks,
  rangeWidth,
  resizeTask,
  shiftTask,
  todayX,
  weekendBands,
  type DayRange,
  type Zoom,
} from "@/lib/gantt"
import type { TimelineTask } from "@/lib/timeline-api"

/** Shared with the task list beside the chart, so the rows line up. */
export const ROW_HEIGHT = 36
/** The two header rows: months above, days or weeks below. */
export const HEADER_HEIGHT = 44

const BAR_INSET = 8
/** The progress strip along the bottom of each bar. */
const PROGRESS_HEIGHT = 4
const HANDLE_WIDTH = 8

/** A bar being dragged: which task, by which part, and how far so far. */
interface Drag {
  taskId: string
  edge: "start" | "end" | "body"
  originX: number
  days: number
  pointerId: number
}

/**
 * The chart itself: one SVG, as wide as the range at this zoom.
 *
 * Bars are dragged with pointer events on the SVG rather than the browser's
 * drag-and-drop, which cannot follow a pointer by the pixel. The drag is
 * previewed here, in local state, and handed up as whole days only when the
 * pointer is released -- a bar that had been let go where it was picked up
 * is a click, and opens the task instead.
 */
export function GanttChart({
  tasks,
  range,
  zoom,
  pxPerDay,
  today,
  onOpen,
  onCommit,
}: {
  tasks: readonly TimelineTask[]
  range: DayRange
  zoom: Zoom
  pxPerDay: number
  today: string
  onOpen: (task: TimelineTask) => void
  onCommit: (task: TimelineTask, dates: { startsOn: string; endsOn: string }) => void
}) {
  const [drag, setDrag] = React.useState<Drag | null>(null)

  const width = rangeWidth(range, pxPerDay)
  const height = HEADER_HEIGHT + tasks.length * ROW_HEIGHT
  const { major, minor } = headerTicks(range, zoom, pxPerDay)
  const weekends = weekendBands(range, pxPerDay)
  const now = todayX(today, range, pxPerDay)

  // Bars as they are drawn: the dragged one where the pointer has it, the
  // rest where the data says. Arrows follow the same boxes, so they move too.
  const boxes = tasks.map((task, row) => {
    const dates =
      drag?.taskId === task.id && drag.days !== 0
        ? drag.edge === "body"
          ? shiftTask(task, drag.days)
          : resizeTask(task, drag.edge, drag.days)
        : task
    return { task, row, ...barGeometry(dates, range, pxPerDay) }
  })
  const byId = new Map(boxes.map((b) => [b.task.id, b]))

  function begin(event: React.PointerEvent<SVGElement>, task: TimelineTask, edge: Drag["edge"]) {
    if (event.button !== 0) return
    event.currentTarget.setPointerCapture(event.pointerId)
    setDrag({ taskId: task.id, edge, originX: event.clientX, days: 0, pointerId: event.pointerId })
  }

  function move(event: React.PointerEvent<SVGElement>) {
    if (!drag || event.pointerId !== drag.pointerId) return
    const days = daysFromDelta(event.clientX - drag.originX, pxPerDay)
    if (days !== drag.days) setDrag({ ...drag, days })
  }

  function end(event: React.PointerEvent<SVGElement>, task: TimelineTask) {
    if (!drag || event.pointerId !== drag.pointerId) return
    setDrag(null)
    if (drag.days === 0) {
      onOpen(task)
      return
    }
    onCommit(
      task,
      drag.edge === "body" ? shiftTask(task, drag.days) : resizeTask(task, drag.edge, drag.days),
    )
  }

  return (
    <svg
      width={width}
      height={height}
      className="block select-none text-xs"
      style={{ touchAction: "none" }}
      role="img"
      aria-label="Gantt chart"
    >
      <defs>
        <marker
          id="gantt-arrow"
          viewBox="0 0 8 8"
          refX="7"
          refY="4"
          markerWidth="6"
          markerHeight="6"
          orient="auto"
        >
          <path d="M 0 0 L 8 4 L 0 8 z" fill="var(--muted-foreground)" />
        </marker>
      </defs>

      {/* Weekends, under everything. */}
      {weekends.map((band) => (
        <rect
          key={band.x}
          x={band.x}
          y={HEADER_HEIGHT}
          width={band.width}
          height={height - HEADER_HEIGHT}
          fill="var(--muted)"
          opacity={0.5}
        />
      ))}

      {/* Column lines: one per minor tick, or per month when there are none. */}
      {(minor.length > 0 ? minor : major).map((tick) => (
        <line
          key={tick.x}
          x1={tick.x}
          x2={tick.x}
          y1={HEADER_HEIGHT}
          y2={height}
          stroke="var(--border)"
          strokeWidth={1}
        />
      ))}

      {/* Row lines. */}
      {tasks.map((task, row) => (
        <line
          key={task.id}
          x1={0}
          x2={width}
          y1={HEADER_HEIGHT + (row + 1) * ROW_HEIGHT}
          y2={HEADER_HEIGHT + (row + 1) * ROW_HEIGHT}
          stroke="var(--border)"
          strokeWidth={1}
        />
      ))}

      {/* The header: months, then the finer row beneath. */}
      <rect x={0} y={0} width={width} height={HEADER_HEIGHT} fill="var(--background)" />
      {major.map((tick) => (
        <g key={`m${tick.x}`}>
          <line
            x1={tick.x}
            x2={tick.x}
            y1={0}
            y2={HEADER_HEIGHT}
            stroke="var(--border)"
            strokeWidth={1}
          />
          <text
            x={tick.x + 6}
            y={15}
            fill="var(--foreground)"
            fontWeight={500}
          >
            {tick.width > 40 ? tick.label : ""}
          </text>
        </g>
      ))}
      {minor.map((tick) => (
        <text
          key={`n${tick.x}`}
          x={tick.x + tick.width / 2}
          y={HEADER_HEIGHT - 8}
          textAnchor="middle"
          fill="var(--muted-foreground)"
        >
          {tick.width >= 14 ? tick.label : ""}
        </text>
      ))}
      <line
        x1={0}
        x2={width}
        y1={HEADER_HEIGHT}
        y2={HEADER_HEIGHT}
        stroke="var(--border)"
        strokeWidth={1}
      />

      {/* Arrows, under the bars they connect so a bar's edge stays crisp. */}
      {boxes.map((box) => {
        const from = box.task.dependsOnId ? byId.get(box.task.dependsOnId) : null
        if (!from) return null
        return (
          <path
            key={`dep-${box.task.id}`}
            d={dependencyPath(from, box, ROW_HEIGHT)}
            transform={`translate(0 ${HEADER_HEIGHT})`}
            fill="none"
            stroke="var(--muted-foreground)"
            strokeWidth={1.5}
            markerEnd="url(#gantt-arrow)"
          />
        )
      })}

      {/* Today. */}
      {now !== null && (
        <line
          x1={now}
          x2={now}
          y1={HEADER_HEIGHT - 4}
          y2={height}
          stroke="var(--ucch-active)"
          strokeWidth={1.5}
          strokeDasharray="4 3"
        />
      )}

      {/* The bars. */}
      {boxes.map(({ task, row, x, width: barWidth }) => {
        const y = HEADER_HEIGHT + row * ROW_HEIGHT + BAR_INSET
        const barHeight = ROW_HEIGHT - BAR_INSET * 2
        const fill = `var(--ucch-note-${task.colour})`
        const dragging = drag?.taskId === task.id
        return (
          <g key={task.id} className={dragging ? "cursor-grabbing" : "cursor-grab"}>
            <clipPath id={`bar-${task.id}`}>
              <rect x={x} y={y} width={barWidth} height={barHeight} rx={4} />
            </clipPath>
            <rect
              x={x}
              y={y}
              width={barWidth}
              height={barHeight}
              rx={4}
              fill={fill}
              opacity={0.3}
              onPointerDown={(e) => begin(e, task, "body")}
              onPointerMove={move}
              onPointerUp={(e) => end(e, task)}
            />
            {/* Progress as a strip along the bottom rather than a fill under
                the title: a solid fill put the label on a mid-tone it could
                not reach 4.5:1 against. */}
            <rect
              x={x}
              y={y + barHeight - PROGRESS_HEIGHT}
              width={(barWidth * task.progress) / 100}
              height={PROGRESS_HEIGHT}
              fill={fill}
              clipPath={`url(#bar-${task.id})`}
              pointerEvents="none"
            />
            <text
              x={x + 6}
              y={y + barHeight / 2 + 4}
              fill="var(--foreground)"
              clipPath={`url(#bar-${task.id})`}
              pointerEvents="none"
            >
              {barWidth > 24 ? task.title : ""}
            </text>
            {/* Edge handles, invisible but wide enough to catch. */}
            <rect
              x={x - HANDLE_WIDTH / 2}
              y={y}
              width={HANDLE_WIDTH}
              height={barHeight}
              fill="transparent"
              className="cursor-ew-resize"
              onPointerDown={(e) => begin(e, task, "start")}
              onPointerMove={move}
              onPointerUp={(e) => end(e, task)}
            />
            <rect
              x={x + barWidth - HANDLE_WIDTH / 2}
              y={y}
              width={HANDLE_WIDTH}
              height={barHeight}
              fill="transparent"
              className="cursor-ew-resize"
              onPointerDown={(e) => begin(e, task, "end")}
              onPointerMove={move}
              onPointerUp={(e) => end(e, task)}
            />
          </g>
        )
      })}
    </svg>
  )
}
