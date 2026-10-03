"use client"

import * as React from "react"
import Link from "next/link"
import { usePathname, useRouter } from "next/navigation"

/**
 * Page changes as view transitions.
 *
 * React's own `<ViewTransition>` is not in the React that Next ships, so this
 * drives the browser API directly: `document.startViewTransition` snapshots
 * the page, the navigation runs inside its callback, and the transition is
 * released the moment the URL has changed and the new tree is on screen. Which
 * elements move and how is CSS -- see the `::view-transition-*` rules in
 * `globals.css`. The shell has no transition name and so stays put; only the
 * page area crossfades.
 *
 * Every navigation inside the app should go through here rather than
 * `next/link` or `useRouter` directly: the `<TransitionLink>` for anchors, and
 * `useTransitionRouter()` where a handler navigates. A browser without the API
 * gets the plain navigation.
 */

interface Navigator {
  /**
   * Runs `navigate` inside a view transition -- or plainly when the browser
   * has none, or when `href` is the page already on screen, where there is
   * nothing to transition to and the snapshot would only freeze the page.
   */
  transition: (navigate: () => void, href?: string) => void
}

const NavigatorContext = React.createContext<Navigator | null>(null)

/**
 * If the URL never changes -- a push to the page you are on, a navigation that
 * errors -- the transition would otherwise hold the page frozen with its
 * snapshot until the browser's own four-second timeout. This is long enough
 * for any streamed loading state to commit, and short enough to be a glitch
 * rather than a hang.
 */
const RELEASE_TIMEOUT_MS = 1500

export function ViewTransitionsProvider({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  const release = React.useRef<(() => void) | null>(null)
  // A ref so `transition` can stay stable while still comparing against the
  // page that is current at click time.
  const current = React.useRef(pathname)
  current.current = pathname

  // Layout effect rather than effect: the transition should end when the new
  // page is *painted*, and this runs after the commit but before the paint.
  React.useLayoutEffect(() => {
    release.current?.()
    release.current = null
  }, [pathname])

  const value = React.useMemo<Navigator>(
    () => ({
      transition(navigate, href) {
        if (
          typeof document === "undefined" ||
          typeof document.startViewTransition !== "function" ||
          window.matchMedia("(prefers-reduced-motion: reduce)").matches ||
          (href !== undefined && new URL(href, location.href).pathname === current.current)
        ) {
          navigate()
          return
        }
        // A second navigation before the first has painted -- two quick
        // clicks -- skips the running transition. That is what should
        // happen; the browser reports it as a rejected promise, which is
        // not an error to show anyone.
        release.current?.()
        release.current = null
        const started = document.startViewTransition(
          () =>
            new Promise<void>((resolve) => {
              const timer = setTimeout(resolve, RELEASE_TIMEOUT_MS)
              release.current = () => {
                clearTimeout(timer)
                resolve()
              }
              React.startTransition(navigate)
            }),
        )
        started.ready.catch(() => {})
        started.finished.catch(() => {})
        started.updateCallbackDone.catch(() => {})
      },
    }),
    [],
  )

  return <NavigatorContext.Provider value={value}>{children}</NavigatorContext.Provider>
}

function useNavigator(): Navigator {
  const context = React.useContext(NavigatorContext)
  if (!context) throw new Error("useTransitionRouter must be used inside <ViewTransitionsProvider>")
  return context
}

/**
 * `useRouter` whose `push` and `replace` are view transitions.
 *
 * `refresh` is passed through untouched: it re-renders in place, and a
 * crossfade over that would draw the eye to nothing.
 */
export function useTransitionRouter() {
  const router = useRouter()
  const { transition } = useNavigator()

  return React.useMemo(
    () => ({
      push: (href: string) => transition(() => router.push(href), href),
      replace: (href: string) => transition(() => router.replace(href), href),
      refresh: () => router.refresh(),
      back: () => transition(() => router.back()),
    }),
    [router, transition],
  )
}

/** Whether a click on a link should be left to the browser. */
function isPlainClick(event: React.MouseEvent<HTMLAnchorElement>) {
  return (
    event.button === 0 &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.shiftKey &&
    !event.altKey &&
    !event.defaultPrevented
  )
}

/**
 * `next/link` that navigates inside a view transition.
 *
 * A drop-in: prefetching, `href` objects and every other prop go straight
 * through. Modified clicks (new tab, download) and links marked `target` are
 * left to the browser, as they would be by `next/link` itself.
 */
export function TransitionLink({
  href,
  onClick,
  replace,
  scroll,
  target,
  ...props
}: React.ComponentProps<typeof Link>) {
  const router = useRouter()
  const { transition } = useNavigator()

  return (
    <Link
      href={href}
      replace={replace}
      scroll={scroll}
      target={target}
      {...props}
      onClick={(event) => {
        onClick?.(event)
        if (!isPlainClick(event) || (target && target !== "_self")) return
        // A hash on the current page is the browser's job: scrolling to an
        // anchor is not a page change and should not look like one. An href
        // object is rare enough here to be left to `next/link` as well.
        if (typeof href !== "string" || href.startsWith("#")) return
        event.preventDefault()
        transition(() => {
          if (replace) router.replace(href, { scroll })
          else router.push(href, { scroll })
        }, href)
      }}
    />
  )
}
