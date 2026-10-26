# apps/web

## Page changes are instant; loading is a skeleton

Every click that changes the page paints the new page in the same frame. Anything
still on its way shows a skeleton shaped like what will arrive, never a frozen old
page, a blank area, a spinner, or "Loading…" text. `src/app/navigation.test.ts`
enforces the mechanical parts.

- **Every route gets a `loading.tsx`** that renders a skeleton from
  `src/components/page-skeletons.tsx` matching the page's real layout (same
  padding, toolbar height, column widths). The router prefetches a dynamic route
  only down to its first loading boundary. Without one, a click waits on the
  server. Pages with nothing to wait for can render the page itself as their
  loading state (see `todo/loading.tsx`).
- **Layouts await nothing.** A `loading.tsx` wraps a segment's children, not its
  layout, so a lookup awaited in a layout holds the old page on screen. Do the
  lookup in a child under `<Suspense fallback={<…Skeleton />}>` (see
  `documentation/layout.tsx` and `database/[connectionId]/[db]/layout.tsx`).
- **Navigate only with `TransitionLink` / `useTransitionRouter`** from
  `src/lib/view-transitions.tsx`. Never use `next/link`, or `useRouter().push` from
  `next/navigation`. Don't `router.refresh()` after changing data: invalidate
  the queries that show it (`useInvalidate` from `src/lib/use-invalidate.ts`).
  Refresh only where the shell itself changes (the allowlist in
  `navigation.test.ts`).
- **Link to the final URL, not a redirect stub.** A server `redirect()` costs a
  second round trip. Keep redirect pages for old bookmarks, and give them a
  `loading.tsx` that renders the *destination's* skeleton.
- **Client components waiting on their first fetch render a skeleton.** Track
  "loaded" separately from "empty", so the empty state ("No tasks yet") never
  flashes before the data arrives. Reuse the pieces in `page-skeletons.tsx`
  (`TreeRowsSkeleton`, `ListRowsSkeleton`, `CodeLinesSkeleton`,
  `TableRowsSkeleton`, …) or `ui/skeleton`. A route's `loading.tsx` and the
  component's own pending state should draw the same skeleton.
- **Spinners are for actions in flight only:** save/submit buttons, a search
  query running, refreshing data that is already on screen, the agent's turn.
- **Every click paints a skeleton in the same frame** (viewport prefetch to
  `loading.tsx`). Content is instant for the recent projects whose data the
  persisted cache holds; others show their skeleton until their data arrives.
  Never pre-render pages in the background. What is loaded ahead is data:
  `lib/warmup.ts` plans it within a small budget (the recent projects' lists,
  their sessions lists, one file tree), `lib/preload.ts` fetches it once the
  shell is idle (`components/route-warmup.tsx`) along with the code-split
  editors (`CHUNKS`), and hovering a project in the sidebar fetches that
  project's lists. A new per-project list belongs in
  `lib/queries/project-data.ts`, read through that in the view; a new large
  `dynamic()` import belongs in `CHUNKS`. Do not warm modules that import
  global CSS.
- `next dev` does not prefetch, so judge speed on `npm run build && npm start`.
