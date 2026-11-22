"use client"

import * as React from "react"

import { useTheme } from "@/components/theme-provider"

/**
 * The animated backdrop behind the sidebar's workspace header and command bar.
 *
 * Dark mode is a starfield on one canvas: no DOM nodes per star, drifting,
 * twinkling and parallaxing with the pointer, with a shooting star now and
 * then. Light mode is an SVG sun peeking in from the top-right corner.
 *
 * Both are always in the markup, and CSS decides which one shows (the
 * `light:` variant). The server cannot know which mode a "system" theme
 * resolves to, so choosing in markup would not hydrate. The canvas loop
 * runs only while the canvas is shown, the tab is visible and the header is
 * on screen. Under reduced motion each scene is drawn once and stays still.
 *
 * Every colour comes from the theme's tokens, read off the page. The accent
 * is `--sidebar-primary`, so a palette chosen in Settings -> Theme recolours
 * the stars along with everything else.
 */
export function SkyBackdrop({
  density = 7,
  speed = 1,
  shooting = true,
}: {
  /** Stars per 10,000 px². */
  density?: number
  /** Drift multiplier; 0 holds the stars still. */
  speed?: number
  shooting?: boolean
}) {
  const canvasRef = React.useRef<HTMLCanvasElement>(null)
  const sunRef = React.useRef<SVGSVGElement>(null)
  const theme = useTheme()

  React.useEffect(() => {
    const canvas = canvasRef.current
    const host = canvas?.parentElement?.parentElement
    const ctx = canvas?.getContext("2d")
    if (!canvas || !host || !ctx) return

    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)")
    let width = 0
    let height = 0
    let stars: Star[] = []
    let accent: RGB = [122, 161, 255]
    let ink: RGB = [231, 235, 244]
    let frame = 0
    let last = 0
    let t = 0
    let onScreen = true
    // Parallax: where the pointer pulls the stars, and where they are now.
    const target = { x: 0, y: 0 }
    const offset = { x: 0, y: 0 }
    let shot: Shot | null = null
    let nextShot = 3 + Math.random() * 5

    const shown = () => getComputedStyle(canvas).display !== "none"

    function readColours() {
      accent = resolveColour(host!, "--sidebar-primary") ?? accent
      ink = resolveColour(host!, "--sidebar-foreground") ?? ink
    }

    function resize() {
      const rect = host!.getBoundingClientRect()
      width = Math.max(1, Math.round(rect.width))
      height = Math.max(1, Math.round(rect.height))
      const dpr = Math.min(2, window.devicePixelRatio || 1)
      canvas!.width = Math.round(width * dpr)
      canvas!.height = Math.round(height * dpr)
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0)
      const count = Math.round(((width * height) / 10_000) * density)
      stars = Array.from({ length: count }, () => makeStar(width, height))
      draw(0)
    }

    function draw(dt: number) {
      const c = ctx!
      t += dt
      c.clearRect(0, 0, width, height)

      // Nebula: two soft accent glows that breathe, drifting against the stars.
      const breath = 0.85 + 0.15 * Math.sin((t / 4) * Math.PI * 2)
      nebula(c, width - offset.x * 0.5, -offset.y * 0.5, width * 0.6, accent, 0.16 * breath)
      nebula(c, -offset.x * 0.5, height - offset.y * 0.5, width * 0.45, accent, 0.07 * breath)

      for (const s of stars) {
        s.x += 4 * s.z * speed * dt
        s.y -= 1.2 * s.z * speed * dt
        if (s.x > width) s.x -= width
        if (s.y < 0) s.y += height
        const x = wrap(s.x + offset.x * s.z, width)
        const y = wrap(s.y + offset.y * s.z, height)
        const wave = 0.5 + 0.5 * Math.sin(s.phase + t * s.rate)
        const alpha = (0.35 + 0.65 * wave) * s.z
        const [r, g, b] = s.tint ? accent : ink
        c.fillStyle = `rgb(${r} ${g} ${b} / ${alpha})`
        c.beginPath()
        c.arc(x, y, s.r, 0, Math.PI * 2)
        c.fill()
        // The nearest stars flare into a small cross at their brightest.
        if (s.z > 0.85 && wave > 0.92) {
          c.strokeStyle = `rgb(${r} ${g} ${b} / ${alpha * (wave - 0.92) * 12})`
          c.lineWidth = 0.5
          c.beginPath()
          c.moveTo(x - 3, y)
          c.lineTo(x + 3, y)
          c.moveTo(x, y - 3)
          c.lineTo(x, y + 3)
          c.stroke()
        }
      }

      if (shooting && dt > 0) {
        nextShot -= dt
        if (!shot && nextShot <= 0) {
          shot = {
            x: Math.random() * width * 0.6,
            y: Math.random() * height * 0.4,
            vx: 180 + Math.random() * 80,
            vy: 55 + Math.random() * 30,
            age: 0,
          }
          nextShot = 6 + Math.random() * 8
        }
        if (shot) {
          shot.age += dt
          const life = shot.age / SHOT_LIFE
          if (life >= 1) shot = null
          else drawShot(c, shot, ink, life)
        }
      }
    }

    function loop(now: number) {
      // Clamped, so coming back to the tab does not make the stars jump.
      const dt = last ? Math.min(0.05, (now - last) / 1000) : 0
      last = now
      offset.x += (target.x - offset.x) * 0.06
      offset.y += (target.y - offset.y) * 0.06
      draw(dt)
      frame = requestAnimationFrame(loop)
    }

    function sync() {
      const run = onScreen && !document.hidden && !reduced.matches && shown()
      if (run && !frame) {
        last = 0
        frame = requestAnimationFrame(loop)
      } else if (!run && frame) {
        cancelAnimationFrame(frame)
        frame = 0
      }
      if (!run && shown()) draw(0)
    }

    function onPointerMove(event: PointerEvent) {
      if (reduced.matches) return
      const rect = host!.getBoundingClientRect()
      const nx = ((event.clientX - rect.left) / rect.width) * 2 - 1
      const ny = ((event.clientY - rect.top) / rect.height) * 2 - 1
      target.x = nx * 8
      target.y = ny * 5
      sunRef.current?.style.setProperty("--sun-x", `${(nx * 4).toFixed(1)}px`)
      sunRef.current?.style.setProperty("--sun-y", `${(ny * 3).toFixed(1)}px`)
    }
    function onPointerLeave() {
      target.x = 0
      target.y = 0
      sunRef.current?.style.removeProperty("--sun-x")
      sunRef.current?.style.removeProperty("--sun-y")
    }

    readColours()
    resize()
    const resizeObserver = new ResizeObserver(resize)
    resizeObserver.observe(host)
    const intersection = new IntersectionObserver(([entry]) => {
      onScreen = entry?.isIntersecting ?? true
      sync()
    })
    intersection.observe(host)
    document.addEventListener("visibilitychange", sync)
    reduced.addEventListener("change", sync)
    host.addEventListener("pointermove", onPointerMove)
    host.addEventListener("pointerleave", onPointerLeave)
    // The theme provider paints its variables in its own effect, after this
    // one, so the new colours are read on the next frame.
    const repaint = requestAnimationFrame(() => {
      readColours()
      sync()
    })
    sync()

    return () => {
      cancelAnimationFrame(frame)
      cancelAnimationFrame(repaint)
      resizeObserver.disconnect()
      intersection.disconnect()
      document.removeEventListener("visibilitychange", sync)
      reduced.removeEventListener("change", sync)
      host.removeEventListener("pointermove", onPointerMove)
      host.removeEventListener("pointerleave", onPointerLeave)
    }
    // The theme value changes with the mode and the palette: both change
    // which scene shows and what colour it is drawn in.
  }, [density, speed, shooting, theme])

  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden>
      <canvas ref={canvasRef} className="ucch-sky-canvas light:hidden" />
      <CornerSun ref={sunRef} />
      <span className="ucch-sky-hairline" />
    </div>
  )
}

type RGB = [number, number, number]

interface Star {
  x: number
  y: number
  /** Depth, 0.25 (far) to 1 (near): size, brightness, speed and parallax. */
  z: number
  r: number
  phase: number
  /** Twinkle rate, radians per second. */
  rate: number
  /** Drawn in the accent rather than the ink. */
  tint: boolean
}

interface Shot {
  x: number
  y: number
  vx: number
  vy: number
  age: number
}

const SHOT_LIFE = 0.9

function makeStar(width: number, height: number): Star {
  const z = 0.25 + Math.random() * 0.75
  return {
    x: Math.random() * width,
    y: Math.random() * height,
    z,
    r: 0.35 + z * 0.9,
    phase: Math.random() * Math.PI * 2,
    rate: 0.6 + Math.random() * 1.8,
    tint: Math.random() < 0.18,
  }
}

function wrap(value: number, size: number): number {
  return ((value % size) + size) % size
}

function nebula(c: CanvasRenderingContext2D, x: number, y: number, radius: number, [r, g, b]: RGB, alpha: number) {
  const gradient = c.createRadialGradient(x, y, 0, x, y, radius)
  gradient.addColorStop(0, `rgb(${r} ${g} ${b} / ${alpha})`)
  gradient.addColorStop(1, `rgb(${r} ${g} ${b} / 0)`)
  c.fillStyle = gradient
  c.fillRect(x - radius, y - radius, radius * 2, radius * 2)
}

function drawShot(c: CanvasRenderingContext2D, shot: Shot, [r, g, b]: RGB, life: number) {
  const x = shot.x + shot.vx * shot.age
  const y = shot.y + shot.vy * shot.age
  const tailX = x - shot.vx * 0.18
  const tailY = y - shot.vy * 0.18
  const fade = life < 0.2 ? life / 0.2 : 1 - (life - 0.2) / 0.8
  const gradient = c.createLinearGradient(tailX, tailY, x, y)
  gradient.addColorStop(0, `rgb(${r} ${g} ${b} / 0)`)
  gradient.addColorStop(1, `rgb(${r} ${g} ${b} / ${0.9 * fade})`)
  c.strokeStyle = gradient
  c.lineWidth = 1.2
  c.lineCap = "round"
  c.beginPath()
  c.moveTo(tailX, tailY)
  c.lineTo(x, y)
  c.stroke()
}

/**
 * A custom property's colour as RGB. The tokens are `light-dark()` values,
 * which only a property that takes a colour resolves. So the colour is set on
 * an element's `color`, and the computed result goes through a 1px canvas,
 * which turns whatever colour syntax the browser returns into bytes.
 */
function resolveColour(from: Element, variable: string): RGB | null {
  const probe = document.createElement("span")
  probe.style.color = `var(${variable})`
  probe.style.display = "none"
  from.appendChild(probe)
  const computed = getComputedStyle(probe).color
  probe.remove()
  const pixel = document.createElement("canvas").getContext("2d", { willReadFrequently: true })
  if (!pixel || !computed) return null
  pixel.fillStyle = computed
  pixel.fillRect(0, 0, 1, 1)
  const [r, g, b] = pixel.getImageData(0, 0, 1, 1).data
  return [r ?? 0, g ?? 0, b ?? 0]
}

// -- The light-mode sun --------------------------------------------------------

const CX = 168
const CY = 12

/** One tapered ray along `angle` with a rounded tip, as a path. */
function rayPath(angle: number, length: number, base: number): string {
  const ux = Math.cos(angle)
  const uy = Math.sin(angle)
  const px = -uy
  const py = ux
  const at = (r: number, side: number) =>
    `${(CX + ux * r + px * side).toFixed(2)} ${(CY + uy * r + py * side).toFixed(2)}`
  const r0 = 44
  const r1 = r0 + length
  return `M${at(r0, base / 2)} L${at(r1 - 2, 0.9)} Q${at(r1 + 1.5, 0)} ${at(r1 - 2, -0.9)} L${at(r0, -base / 2)} Z`
}

/** A four-pointed star of curved diamond sides. */
function sparklePath(x: number, y: number, s: number): string {
  return `M${x} ${y - s} Q${x} ${y} ${x + s} ${y} Q${x} ${y} ${x} ${y + s} Q${x} ${y} ${x - s} ${y} Q${x} ${y} ${x} ${y - s} Z`
}

// Computed once, at module load, so the server and client render the same paths.
const RAYS = Array.from({ length: 16 }, (_, i) => {
  const long = i % 2 === 0
  return { d: rayPath((i * 22.5 * Math.PI) / 180, long ? 26 : 15, long ? 8.4 : 6), long }
})

const SPARKLES = [
  { d: sparklePath(104, 30, 4.5), delay: "0s" },
  { d: sparklePath(128, 78, 3.2), delay: "1.1s" },
  { d: sparklePath(84, 62, 2.6), delay: "2s" },
  { d: sparklePath(146, 104, 3.6), delay: "0.6s" },
]

const stop = (offset: number, colour: string, opacity: number) => (
  <stop offset={offset} style={{ stopColor: `var(${colour})`, stopOpacity: opacity }} />
)

function CornerSun({ ref }: { ref: React.Ref<SVGSVGElement> }) {
  const id = React.useId().replace(/[^a-zA-Z0-9_-]/g, "")
  return (
    <svg ref={ref} className="ucch-sun hidden light:block" viewBox="0 0 180 180" aria-hidden focusable="false">
      <defs>
        <radialGradient id={`${id}-glow`} gradientUnits="userSpaceOnUse" cx={CX} cy={CY} r={150}>
          {stop(0, "--sun-glow", 0.75)}
          {stop(0.3, "--sun-glow", 0.32)}
          {stop(0.65, "--sun-core", 0.1)}
          {stop(1, "--sun-core", 0)}
        </radialGradient>
        <radialGradient id={`${id}-ray`} gradientUnits="userSpaceOnUse" cx={CX} cy={CY} r={74}>
          {stop(0.59, "--sun-ray", 0.95)}
          {stop(1, "--sun-ray", 0.15)}
        </radialGradient>
        <radialGradient id={`${id}-body`} gradientUnits="userSpaceOnUse" cx={CX} cy={CY} fx={CX - 14} fy={CY + 14} r={34}>
          {stop(0, "--sun-core", 1)}
          {stop(0.35, "--sun-mid", 1)}
          {stop(0.8, "--sun-body", 1)}
          {stop(1, "--sun-edge", 1)}
        </radialGradient>
      </defs>

      <circle className="ucch-sun-pivot ucch-sun-glow" cx={CX} cy={CY} r={150} fill={`url(#${id}-glow)`} />
      <g className="ucch-sun-pivot ucch-sun-halo" fill="none" style={{ stroke: "var(--sun-edge)" }}>
        <circle cx={CX} cy={CY} r={78} strokeOpacity={0.45} strokeWidth={1.6} strokeDasharray="0.1 7" strokeLinecap="round" />
        <circle cx={CX} cy={CY} r={92} strokeOpacity={0.2} strokeWidth={1} strokeDasharray="10 14" />
      </g>
      <g className="ucch-sun-pivot ucch-sun-rays" fill={`url(#${id}-ray)`}>
        {RAYS.map((ray, i) => (
          <path key={i} d={ray.d} opacity={ray.long ? 1 : 0.7} />
        ))}
      </g>
      <circle cx={CX} cy={CY} r={39} style={{ fill: "var(--sun-ray)" }} fillOpacity={0.35} />
      <circle cx={CX} cy={CY} r={34} fill={`url(#${id}-body)`} />
      <circle cx={CX} cy={CY} r={33.5} fill="none" style={{ stroke: "var(--sun-edge)" }} strokeOpacity={0.35} />
      <g style={{ fill: "var(--sun-edge)" }}>
        {SPARKLES.map((s) => (
          <path
            key={s.delay}
            className="ucch-sun-sparkle"
            d={s.d}
            style={{ "--d": s.delay } as React.CSSProperties}
          />
        ))}
      </g>
    </svg>
  )
}
