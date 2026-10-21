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
  `next/navigation`. `router.refresh()` on the plain router is fine.
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
  The one exception is the boot screen (`components/boot-frame.tsx`).
- **The whole app loads at boot.** After sign-in (`components/boot-screen.tsx`),
  and on the first page of a browser session (`components/boot-gate.tsx`, gated
  by the `ucch_warm` cookie in `lib/boot-cookie.ts`), a boot screen covers the app
  for up to 6 s while `lib/preload.ts` fully prefetches every section, Settings
  page and page of every project (its open session included), fetches the lists
  those pages open on into the client cache, and loads the code-split editors.
  Whatever is left carries on behind the opened app. Later loads in the session
  do the same quietly, and `components/route-warmup.tsx` re-warms pages as the
  router expires them. What is loaded, and the memory budget that caps it, is
  `lib/warmup.ts`, built from `lib/sections.ts`, so pages registered there are
  covered automatically. A new top-level page outside `sections.ts`, a new
  per-project list (add it to `lib/queries/project-data.ts` and read it through
  that in the view), or a new large `dynamic()` import (`CHUNKS` in
  `lib/preload.ts`) should be added there. Do not warm modules that import
  global CSS.
- `next dev` does not prefetch, so judge speed on `npm run build && npm start`.
