"use client"

import * as React from "react"

import { useTheme } from "@/components/theme-provider"

/**
 * The animated backdrop behind the sidebar's workspace header and command bar.
 *
 * Dark mode is a moon and starfield on one canvas: no DOM nodes per star, drifting,
 * twinkling and parallaxing with the pointer, with a shooting star now and
 * then. Light mode is an SVG sun peeking in from the top-right corner.
 *
 * Both are always in the markup, and CSS decides which one shows (the
 * `light:` variant). The server cannot know which mode a "system" theme
 * resolves to, so choosing in markup would not hydrate. The canvas loop
 * runs only while the canvas is shown, the tab is visible and the header is
 * on screen. Under reduced motion each scene is drawn once and stays still.
 *
 * Star colours come from the theme's tokens, read off the page. The accent
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
  const theme = useTheme()

  React.useEffect(() => {
    const canvas = canvasRef.current
    const host = canvas?.parentElement?.parentElement
    const ctx = canvas?.getContext("2d")
    if (!canvas || !host || !ctx) return

    const systemLight = window.matchMedia("(prefers-color-scheme: light)")
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
        s.x += 5 * s.z * speed * dt
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
        c.arc(x, y, s.r * (0.85 + 0.35 * wave), 0, Math.PI * 2)
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

      drawMoon(c, width - 22 + 1.5 * Math.sin(t * 0.22), 18 + 2 * Math.sin(t * 0.32))
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
    }
    function onPointerLeave() {
      target.x = 0
      target.y = 0
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
    systemLight.addEventListener("change", sync)
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
      systemLight.removeEventListener("change", sync)
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
      <CornerSun />
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

// Craters are placed on the illuminated side of the lunar disk.
const LUNAR_CRATERS = [
  [-9, -5, 2.8], [-5, -10, 1.3], [-13, 2, 1.4], [-8, 7, 2.2], [-2, 12, 1.5],
] as const

function drawMoon(c: CanvasRenderingContext2D, x: number, y: number) {
  c.save()
  c.translate(x, y)
  nebula(c, 0, 0, 36, [172, 196, 238], 0.23)
  const surface = c.createRadialGradient(-9, -7, 1, -3, -3, 22)
  surface.addColorStop(0, "#f2f4e9")
  surface.addColorStop(0.72, "#c6d2da")
  surface.addColorStop(1, "#94a5be")
  c.fillStyle = surface
  c.beginPath()
  c.arc(0, 0, 17, 0, Math.PI * 2)
  c.fill()
  c.clip()
  for (const [cx, cy, radius] of LUNAR_CRATERS) {
    c.beginPath()
    c.ellipse(cx, cy, radius * 0.8, radius, -0.4, 0, Math.PI * 2)
    c.fillStyle = "rgb(90 109 134 / 0.28)"
    c.fill()
  }
  const shadow = c.createRadialGradient(11, -5, 15, 11, -5, 20)
  shadow.addColorStop(0, "#354159")
  shadow.addColorStop(1, "rgb(53 65 89 / 0)")
  c.fillStyle = shadow
  c.fillRect(-17, -17, 34, 34)
  c.restore()
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

function CornerSun() {
  const id = React.useId()
  return (
    <svg className="ucch-sun hidden light:block" viewBox="0 0 180 180" aria-hidden focusable="false">
      <defs>
        <radialGradient id={`${id}-corona`}>
          <stop offset=".42" stopColor="#ffb34d" stopOpacity=".55" />
          <stop offset=".53" stopColor="#ffc56c" stopOpacity=".22" />
          <stop offset="1" stopColor="#ffda96" stopOpacity="0" />
        </radialGradient>
        <radialGradient id={`${id}-limb`}>
          <stop offset="0" stopColor="#fff2ab" stopOpacity=".55" />
          <stop offset=".72" stopColor="#ffdd85" stopOpacity=".14" />
          <stop offset=".95" stopColor="#df691c" stopOpacity=".34" />
          <stop offset="1" stopColor="#ffe398" stopOpacity=".9" />
        </radialGradient>
        <filter id={`${id}-granules`} colorInterpolationFilters="sRGB">
          <feTurbulence type="fractalNoise" baseFrequency=".18 .24" numOctaves="3" seed="14" />
          <feColorMatrix type="saturate" values="0" />
          <feComponentTransfer>
            <feFuncR type="table" tableValues=".63 .83 .99 1 1" />
            <feFuncG type="table" tableValues=".22 .38 .63 .83 .95" />
            <feFuncB type="table" tableValues=".05 .08 .18 .41 .70" />
            <feFuncA type="linear" slope="0" intercept="1" />
          </feComponentTransfer>
          <feComposite in2="SourceGraphic" operator="in" />
        </filter>
      </defs>
      <g transform="translate(168 12)">
        <circle r="96" fill={`url(#${id}-corona)`} />
        <g className="ucch-sun-flare" fill="#f8ad52">
          <path d="M-41 -4 C-47 1 -54 4 -51 11 C-49 17 -43 13 -38 22 L-36 18 C-41 10 -48 15 -49 9 C-51 5 -44 4 -40 1 Z" />
          <path d="M-43 3 Q-56 11 -45 14 Q-53 10 -43 5 Z" />
        </g>
        <g className="ucch-sun-flare ucch-sun-flare-low" fill="#ffbf64">
          <path d="M-24 32 C-25 44 -18 43 -17 51 C-13 44 -19 40 -11 37 L-13 35 C-21 39 -16 42 -18 45 Q-23 40 -21 34 Z" />
          <path d="M1 39 Q8 47 14 39 Q18 33 23 34 Q17 32 12 39 Q8 44 5 38 Z" />
        </g>
        <circle className="ucch-sun-surface" r="42" fill="#ffc067" filter={`url(#${id}-granules)`} />
        <circle r="42" fill={`url(#${id}-limb)`} />
      </g>
    </svg>
  )
}
