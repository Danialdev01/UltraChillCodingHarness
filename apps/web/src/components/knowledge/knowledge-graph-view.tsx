"use client"

import * as React from "react"
import { MaximizeIcon, MinusIcon, NetworkIcon, PlusIcon, SearchIcon } from "lucide-react"
import type { KnowledgeDocumentSummary, KnowledgeGraph, KnowledgeGraphNode } from "@ucch/protocol"

import { EmptyState } from "@/components/layout/empty-state"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"

/** The most nodes drawn at once: the best connected, so the picture stays legible. */
const MAX_NODES = 220

const PALETTE = ["var(--chart-1)", "var(--chart-2)", "var(--chart-3)", "var(--chart-4)", "var(--chart-5)", "var(--chart-6)"]

interface Placed {
  node: KnowledgeGraphNode
  x: number
  y: number
  r: number
}

/**
 * A force layout, run to rest up front rather than animated: the graph
 * arrives still, so reading it never means chasing a label. Repulsion
 * between every pair, springs along the edges, a pull to the centre;
 * deterministic, seeded on a spiral, so the same graph lays out the same way.
 */
export function layoutGraph(graph: KnowledgeGraph, width: number, height: number): Placed[] {
  const nodes = graph.nodes
  const index = new Map(nodes.map((n, i) => [n.id, i]))
  const edges = graph.edges
    .map((e) => [index.get(e.source), index.get(e.target)] as const)
    .filter((e): e is readonly [number, number] => e[0] !== undefined && e[1] !== undefined)
  const n = nodes.length
  const x = new Float64Array(n)
  const y = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    const angle = i * 2.399963
    const radius = 18 * Math.sqrt(i + 1)
    x[i] = width / 2 + radius * Math.cos(angle)
    y[i] = height / 2 + radius * Math.sin(angle)
  }
  const ideal = Math.max(40, Math.min(110, Math.sqrt((width * height) / Math.max(1, n)) * 0.75))
  const iterations = n > 150 ? 220 : 320
  for (let step = 0; step < iterations; step++) {
    const cooling = 1 - step / iterations
    const dx = new Float64Array(n)
    const dy = new Float64Array(n)
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        let ddx = x[i]! - x[j]!
        let ddy = y[i]! - y[j]!
        let d2 = ddx * ddx + ddy * ddy
        if (d2 < 0.01) {
          ddx = 0.1 * ((i % 3) - 1)
          ddy = 0.1
          d2 = 0.02
        }
        const force = (ideal * ideal) / d2
        dx[i]! += ddx * force * 0.05
        dy[i]! += ddy * force * 0.05
        dx[j]! -= ddx * force * 0.05
        dy[j]! -= ddy * force * 0.05
      }
    }
    for (const [a, b] of edges) {
      const ddx = x[b]! - x[a]!
      const ddy = y[b]! - y[a]!
      const d = Math.sqrt(ddx * ddx + ddy * ddy) || 0.01
      const pull = ((d - ideal) / d) * 0.08
      dx[a]! += ddx * pull
      dy[a]! += ddy * pull
      dx[b]! -= ddx * pull
      dy[b]! -= ddy * pull
    }
    const limit = 18 * cooling + 0.5
    for (let i = 0; i < n; i++) {
      dx[i]! += (width / 2 - x[i]!) * 0.01
      dy[i]! += (height / 2 - y[i]!) * 0.01
      const len = Math.sqrt(dx[i]! * dx[i]! + dy[i]! * dy[i]!)
      const scale = len > limit ? limit / len : 1
      x[i]! += dx[i]! * scale
      y[i]! += dy[i]! * scale
    }
  }
  return nodes.map((node, i) => ({ node, x: x[i]!, y: y[i]!, r: 5 + Math.min(10, Math.sqrt(node.degree) * 2.2) }))
}

/** The best connected nodes, and only the edges between them. */
function trimmed(graph: KnowledgeGraph): KnowledgeGraph {
  if (graph.nodes.length <= MAX_NODES) return graph
  const keep = new Set(
    [...graph.nodes].sort((a, b) => b.degree - a.degree || b.documentIds.length - a.documentIds.length).slice(0, MAX_NODES).map((n) => n.id),
  )
  return {
    nodes: graph.nodes.filter((n) => keep.has(n.id)),
    edges: graph.edges.filter((e) => keep.has(e.source) && keep.has(e.target)),
  }
}

const WIDTH = 1000
const HEIGHT = 640

/**
 * A base's knowledge graph: entities as dots sized by how connected they
 * are, coloured by type, relations as lines. Wheel or the buttons zoom, a
 * drag pans; picking an entity lights its neighbours and lists what the
 * graph knows about it beside the picture.
 */
export function KnowledgeGraphView({
  graph,
  documents,
}: {
  graph: KnowledgeGraph
  documents: readonly KnowledgeDocumentSummary[]
}) {
  const shown = React.useMemo(() => trimmed(graph), [graph])
  const placed = React.useMemo(() => layoutGraph(shown, WIDTH, HEIGHT), [shown])
  const byId = React.useMemo(() => new Map(placed.map((p) => [p.node.id, p])), [placed])
  const types = React.useMemo(() => {
    const counts = new Map<string, number>()
    for (const n of shown.nodes) counts.set(n.type, (counts.get(n.type) ?? 0) + 1)
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([t]) => t)
  }, [shown])
  const colorOf = (type: string) => {
    const i = types.indexOf(type)
    return i >= 0 && i < PALETTE.length ? PALETTE[i]! : "var(--muted-foreground)"
  }

  const [selected, setSelected] = React.useState<string | null>(null)
  const [query, setQuery] = React.useState("")
  const [view, setView] = React.useState({ x: 0, y: 0, k: 1 })
  const drag = React.useRef<{ x: number; y: number; vx: number; vy: number; moved: boolean } | null>(null)
  const svgRef = React.useRef<SVGSVGElement>(null)

  const neighbours = React.useMemo(() => {
    if (!selected) return null
    const set = new Set([selected])
    for (const e of shown.edges) {
      if (e.source === selected) set.add(e.target)
      if (e.target === selected) set.add(e.source)
    }
    return set
  }, [selected, shown])

  const matches = React.useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return null
    return new Set(shown.nodes.filter((n) => n.name.toLowerCase().includes(q)).map((n) => n.id))
  }, [query, shown])

  const lit = (id: string) => (neighbours ? neighbours.has(id) : matches ? matches.has(id) : true)

  // Wheel zoom about the pointer. A native listener: React's is passive and
  // cannot stop the page from scrolling under the graph.
  React.useEffect(() => {
    const svg = svgRef.current
    if (!svg) return
    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      const rect = svg.getBoundingClientRect()
      const px = ((event.clientX - rect.left) / rect.width) * WIDTH
      const py = ((event.clientY - rect.top) / rect.height) * HEIGHT
      setView((v) => {
        const k = Math.min(6, Math.max(0.3, v.k * (event.deltaY < 0 ? 1.12 : 1 / 1.12)))
        return { k, x: px - ((px - v.x) * k) / v.k, y: py - ((py - v.y) * k) / v.k }
      })
    }
    svg.addEventListener("wheel", onWheel, { passive: false })
    return () => svg.removeEventListener("wheel", onWheel)
  }, [])

  const zoom = (factor: number) =>
    setView((v) => {
      const k = Math.min(6, Math.max(0.3, v.k * factor))
      return { k, x: WIDTH / 2 - ((WIDTH / 2 - v.x) * k) / v.k, y: HEIGHT / 2 - ((HEIGHT / 2 - v.y) * k) / v.k }
    })

  if (graph.nodes.length === 0) {
    return (
      <EmptyState
        framed
        icon={NetworkIcon}
        title="No graph yet"
        description="The graph is built from the documents as they are read. Add a document, or wait for the ones being read to finish."
      />
    )
  }

  const focus = selected ? byId.get(selected)?.node : undefined
  const docName = new Map(documents.map((d) => [d.id, d.name]))
  const nameOf = (id: string) => byId.get(id)?.node.name ?? graph.nodes.find((n) => n.id === id)?.name ?? id
  const focusEdges = focus ? graph.edges.filter((e) => e.source === focus.id || e.target === focus.id) : []
  const labelAll = placed.length <= 60 || view.k >= 1.6

  return (
    <div className="flex flex-col gap-3 lg:flex-row">
      <div className="relative min-w-0 flex-1 overflow-hidden rounded-lg border">
        <div className="absolute top-2 left-2 z-10 flex items-center gap-1.5">
          <div className="relative">
            <SearchIcon className="text-muted-foreground pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Find an entity"
              aria-label="Find an entity"
              className="bg-background/90 h-7 w-44 pl-7 text-xs"
            />
          </div>
        </div>
        <div className="absolute top-2 right-2 z-10 flex items-center gap-1">
          <Button size="icon-sm" variant="outline" onClick={() => zoom(1.25)} aria-label="Zoom in">
            <PlusIcon />
          </Button>
          <Button size="icon-sm" variant="outline" onClick={() => zoom(0.8)} aria-label="Zoom out">
            <MinusIcon />
          </Button>
          <Button size="icon-sm" variant="outline" onClick={() => setView({ x: 0, y: 0, k: 1 })} aria-label="Fit">
            <MaximizeIcon />
          </Button>
        </div>
        <svg
          ref={svgRef}
          viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
          className="bg-muted/20 block h-[min(64vh,640px)] w-full cursor-grab touch-none select-none active:cursor-grabbing"
          role="img"
          aria-label={`Knowledge graph: ${graph.nodes.length} entities, ${graph.edges.length} relations`}
          onPointerDown={(e) => {
            ;(e.target as Element).setPointerCapture?.(e.pointerId)
            drag.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y, moved: false }
          }}
          onPointerMove={(e) => {
            const d = drag.current
            if (!d) return
            const rect = svgRef.current!.getBoundingClientRect()
            const mx = ((e.clientX - d.x) / rect.width) * WIDTH
            const my = ((e.clientY - d.y) / rect.height) * HEIGHT
            if (Math.abs(mx) + Math.abs(my) > 3) d.moved = true
            setView((v) => ({ ...v, x: d.vx + mx, y: d.vy + my }))
          }}
          onPointerUp={(e) => {
            const d = drag.current
            drag.current = null
            if (d && !d.moved) {
              const id = (e.target as Element).closest("[data-node]")?.getAttribute("data-node") ?? null
              setSelected((current) => (id === current ? null : id))
            }
          }}
        >
          <g transform={`translate(${view.x} ${view.y}) scale(${view.k})`}>
            {shown.edges.map((edge) => {
              const a = byId.get(edge.source)
              const b = byId.get(edge.target)
              if (!a || !b) return null
              const on = lit(edge.source) && lit(edge.target) && (!neighbours || edge.source === selected || edge.target === selected)
              return (
                <line
                  key={`${edge.source}\u0000${edge.relation}\u0000${edge.target}`}
                  x1={a.x}
                  y1={a.y}
                  x2={b.x}
                  y2={b.y}
                  stroke="var(--muted-foreground)"
                  strokeOpacity={on ? 0.45 : 0.08}
                  strokeWidth={Math.min(3, 0.8 + edge.weight * 0.4) / view.k}
                >
                  <title>{`${a.node.name} — ${edge.relation} → ${b.node.name}`}</title>
                </line>
              )
            })}
            {placed.map((p) => {
              const on = lit(p.node.id)
              const isFocus = p.node.id === selected
              return (
                <g key={p.node.id} data-node={p.node.id} className="cursor-pointer" opacity={on ? 1 : 0.18}>
                  <circle
                    cx={p.x}
                    cy={p.y}
                    r={p.r / Math.sqrt(view.k)}
                    fill={colorOf(p.node.type)}
                    stroke={isFocus ? "var(--foreground)" : "var(--background)"}
                    strokeWidth={(isFocus ? 2.5 : 1.2) / view.k}
                  >
                    <title>{`${p.node.name} (${p.node.type})`}</title>
                  </circle>
                  {(labelAll || isFocus || (neighbours?.has(p.node.id) ?? false) || (matches?.has(p.node.id) ?? false) || p.node.degree >= 4) && (
                    <text
                      x={p.x}
                      y={p.y - p.r / Math.sqrt(view.k) - 4 / view.k}
                      textAnchor="middle"
                      fontSize={11 / view.k}
                      fill="var(--foreground)"
                      stroke="var(--background)"
                      strokeWidth={3 / view.k}
                      paintOrder="stroke"
                      className="pointer-events-none"
                    >
                      {p.node.name.length > 28 ? `${p.node.name.slice(0, 27)}…` : p.node.name}
                    </text>
                  )}
                </g>
              )
            })}
          </g>
        </svg>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t px-3 py-2 text-xs">
          {types.slice(0, PALETTE.length).map((type) => (
            <span key={type} className="text-muted-foreground flex items-center gap-1.5">
              <span className="size-2.5 rounded-full" style={{ background: colorOf(type) }} aria-hidden />
              {type}
            </span>
          ))}
          <span className="text-muted-foreground ml-auto tabular-nums">
            {graph.nodes.length} entities · {graph.edges.length} relations
            {graph.nodes.length > shown.nodes.length && ` · showing the ${shown.nodes.length} best connected`}
          </span>
        </div>
      </div>

      <aside className="flex w-full shrink-0 flex-col gap-3 rounded-lg border p-4 lg:w-72">
        {focus ? (
          <>
            <div>
              <div className="flex items-center gap-2">
                <span className="size-2.5 shrink-0 rounded-full" style={{ background: colorOf(focus.type) }} aria-hidden />
                <h3 className="truncate text-sm font-semibold">{focus.name}</h3>
              </div>
              <p className="text-muted-foreground mt-0.5 text-xs">{focus.type}</p>
            </div>
            {focus.description && <p className="text-sm">{focus.description}</p>}
            <div>
              <h4 className="text-muted-foreground mb-1 text-xs font-medium">Relations</h4>
              {focusEdges.length === 0 ? (
                <p className="text-muted-foreground text-xs">None recorded.</p>
              ) : (
                <ul className="flex max-h-56 flex-col gap-1 overflow-y-auto text-xs">
                  {focusEdges.map((e) => {
                    const other = e.source === focus.id ? e.target : e.source
                    return (
                      <li key={`${e.source}\u0000${e.relation}\u0000${e.target}`}>
                        <button
                          type="button"
                          onClick={() => setSelected(other)}
                          className={cn("hover:text-foreground text-left", "text-muted-foreground")}
                        >
                          {e.source === focus.id ? (
                            <>
                              <span className="italic">{e.relation}</span> → <span className="text-foreground">{nameOf(e.target)}</span>
                            </>
                          ) : (
                            <>
                              <span className="text-foreground">{nameOf(e.source)}</span> → <span className="italic">{e.relation}</span>
                            </>
                          )}
                        </button>
                      </li>
                    )
                  })}
                </ul>
              )}
            </div>
            <div>
              <h4 className="text-muted-foreground mb-1 text-xs font-medium">Mentioned in</h4>
              <ul className="flex flex-col gap-0.5 text-xs">
                {focus.documentIds.map((id) => (
                  <li key={id} className="truncate">
                    {docName.get(id) ?? "A removed document"}
                  </li>
                ))}
              </ul>
            </div>
          </>
        ) : (
          <div className="text-muted-foreground flex flex-col gap-2 text-sm">
            <p>Pick an entity to see what the documents say about it and what it is connected to.</p>
            <p className="text-xs">Drag to pan, scroll or use the buttons to zoom.</p>
          </div>
        )}
      </aside>
    </div>
  )
}
