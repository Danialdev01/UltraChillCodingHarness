# The agents' shared browser

Every agent, on every harness, can drive a real browser. It can open pages, click and type, take screenshots, scrape content, and capture a design to copy or compare against. Agents work alone or together in one browser session. People watch any tab live in the **Browser** view and can take control of it.

Everything runs on the server's own headless Chromium through `playwright-core`. No browser is downloaded and no paid service is called.

## Pieces

| Where | What |
|---|---|
| `packages/browser` | `BrowserManager` (one Chromium, sessions, tabs, locks, network policy, persistence, live view), the operations (`ops.ts`), the in-page scripts (`page-scripts.ts`), and the tool specs (`tools.ts`, imported by the other packages as `@ucch/browser/tools`) |
| `packages/agent/src/tools/browser.ts` | The native loop's tools. They forward to `ToolContext.browser`. The registry offers them only when `RegistryOptions.browser` is set. |
| `packages/omp-bridge/src/tools/browser.ts` | The same tools for Claude Code and Codex, as MCP tools (`UCCH_BROWSER=1`). Each call goes over the scheduler socket (`{"type":"browser"}`, see `bridge-leases.ts`) and screenshots come back as MCP image content. |
| OMP | The browser tools are host tools (`HOST_TOOLS`). OMP's own `browser` tool stays off, so every agent shares one Chromium, one set of sessions and one live view. |
| `apps/server/src/browser.ts` | The network policy, the Browser view's routes (`/api/projects/:hash/browser…`) and the live socket (`/browser-ws`) |
| `apps/web/src/components/browser-view.tsx` | The Browser view |

## Tools

| Tool | What it does |
|---|---|
| `browser_open` | Opens or joins a session, optionally at a URL. Returns an accessibility snapshot with `[ref=eN]` marks. |
| `browser_navigate` | Goes to a URL, or back, forward or reload |
| `browser_snapshot` | Returns the accessibility tree with refs (Playwright's `ariaSnapshot({ mode: "ai" })`) |
| `browser_act` | Click, type, fill, press, select, hover, check, scroll, drag, upload or wait, by ref or selector |
| `browser_screenshot` | Captures the viewport, the full page (at most 8000 px tall) or one element, at a viewport preset |
| `browser_extract` | Returns markdown, text, links, tables, meta or html |
| `browser_design` | Captures the palette, fonts, type scale, spacing, radii, shadows, CSS variables, breakpoints and the layout tree (boxes and flex/grid settings). Optionally writes a standalone HTML copy with computed styles inlined. |
| `browser_compare` | Pixel diff (YIQ, as pixelmatch measures it) of two PNGs, or of a PNG against the tab now. Returns the differing share, where the differences are, and a diff image. |
| `browser_eval` | Runs JavaScript in the page (`exec` permission) |
| `browser_tabs` | Lists sessions and tabs, switches the current tab, or closes a tab |
| `browser_logs` | Returns console messages, page errors, and failed or erroring requests after a cursor |
| `browser_close` | Closes a tab, or all of your tabs in a session |
| `browser_motion` | Studies motion: `inspect` lists CSS animations, transitions and Web Animations (keyframes, timing, easing, scroll/view timelines) and JS-driven motion (inline-style churn, rAF rate, GSAP/Lenis/Framer/Lottie/three.js, canvases, videos); `frames` makes a contact sheet over time; `scroll` steps the scroll position and reports what changed at each step. Optional hover/focus/reload trigger and reduced-motion emulation. |

`viewport` takes a preset or an exact `{ width, height }` (240–3840 by 240–2400), for checking a layout at a breakpoint's edge.

## On demand

A thread that has never used the browser is offered `browser_open` alone. Its description says when a browser is the right tool: a site's design or animations, content that only renders with JavaScript, a redesign or the dev server, a layout at a given width. It also says when `web_search`/`web_fetch` are the cheaper choice. Once `browser_open` succeeds, the other twelve tools are offered for the rest of the thread. Chromium itself still starts only on the first call and exits when idle.

| Harness | Before the first open | After |
|---|---|---|
| Native loop | `browser_open` only (`RegistryOptions.browser: "entry"`) | The loop switches to `"full"` within the same turn. The tools sit at the end of the list, so the cached prefix holds up to them. |
| Codex | The bridge registers every tool but lists only `browser_open` (`UCCH_BROWSER=entry`) | It enables the rest and sends `tools/list_changed`; the next turn's bridge starts on `full` |
| Claude Code | All tools, which Claude Code already keeps behind ToolSearch until asked for | — |
| OMP | All tools (host tools are set once per turn) | — |

The server decides per turn: a thread with any `browser_*` tool use in its log, or a browser call over the bridge, gets the full set (`#browserToolset` in `apps/server/src/agent.ts`).

## Motion

- **inspect** watches for `duration_ms` (1.5 s by default). Short-lived transitions are caught because it polls `getAnimations()` every 40 ms, not only once at the end. Inline-style changes (what GSAP, Framer Motion and most JS animation set) are counted with a MutationObserver. The rAF rate misses a library that saved `requestAnimationFrame` before watching began.
- **frames** with `timing: seek` pauses every CSS/Web Animation on the document timeline and sets `currentTime` for each frame, so the frames land at exact times. With no duration given, they cover the animations' own length (one iteration for infinite ones). Script, canvas and video motion cannot be seeked, so `auto` captures those in real time; the labels give the real times. A ref or selector crops each frame to the element, with room for it to grow.
- **scroll** scrolls with the mouse wheel, not `scrollTo`, so smooth-scroll libraries and scroll listeners react. It settles longer when Lenis or Locomotive is present. With a ref or selector, the range is where that element crosses the viewport.
- Each capture is saved as numbered PNGs plus `sheet.png` under `.agent/browser/motion/<host>-<mode>-<time>/`. The sheet is the image the model sees, as a JPEG when the PNG is over 3 MB.

Screenshots and captures are saved under the agent's worktree in `.agent/browser/shots/`, `.agent/browser/designs/` and `.agent/browser/motion/`, so an agent can commit them or put them in a PR.

A model that can see (`supportsImages`) gets each picture in a user message that follows the tool results. Only the two most recent of those messages keep their images; older ones are replaced by their captions. A model that cannot see is told the image was saved and pointed at `browser_snapshot` and `browser_design`.

## Sessions

- **Private.** A tool call with `session: null` uses the agent's own browser context, `private-<thread>`. No other agent can open it.
- **Shared.** Any agent in the project that names a session, for example `"checkout"`, joins it: same cookies, storage and tabs. Each agent works in its own tab by default. `browser_tabs` shows the other agents' tabs and lets an agent switch to one.
- **Locks.** One call at a time per tab. A second call waits (for up to a minute) instead of interleaving with the first.
- **Persistence.** On close and on idle, a session's cookies and storage are saved to `CREDS_ROOT/browser/<project>/<name>.json` and restored when the session is next opened. Logins survive restarts.
- **Limits.**
  - `BROWSER_MAX_CONTEXTS` (default 8) caps open sessions across the server; the least recently used idle session makes room.
  - `BROWSER_MAX_TABS_PER_AGENT` (default 6) caps each agent's tabs in a session.
  - `BROWSER_IDLE_MS` (default 15 min) closes unwatched idle sessions. Chromium itself exits when no session is left.

## People in the loop

The Browser view lists every session of the project, private ones included, because privacy is between agents, not from the people they work for. The selected tab streams over `/browser-ws` as CDP screencast JPEGs, and only while someone watches.

**Take control** gives the person the tab. Mouse, keys, paste and the address bar reach the page. Agents' actions on that tab are refused with "a person is controlling this tab" until the person hands it back or closes the view; agents can still read it. Typical uses are logging in for an agent, or showing it something.

Driving needs the `exec` scope. Watching needs only access to the project.

## Network policy

Pages may load http(s) from the public internet and from loopback. Loopback is allowed so an agent can open the dev server it started; the exception is the harness's own API port. Other private, link-local and metadata addresses are refused for every address a name resolves to, as `web_fetch` refuses them. A refused navigation shows "Blocked by the harness: …". `BROWSER_ALLOW_PRIVATE=true` lifts the private-network rule.

## Settings

| Where | Setting |
|---|---|
| Workspace | `agentSettings.browser.enabled`, on by default |
| Server | `BROWSER_ENABLED` (default on) and `BROWSER_EXECUTABLE`. When neither is set, the server probes the usual Chromium/Chrome paths; the image ships `chromium`. |

Claude Code and Codex sessions keep the tool list they started with: a session from before the browser existed gets it in its next session.

Approvals follow each tool's permission, as for native tools: reads never ask, `browser_act` is a write, and `browser_eval` is `exec`.
