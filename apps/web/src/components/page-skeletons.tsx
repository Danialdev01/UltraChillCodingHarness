import { Skeleton } from "@/components/ui/skeleton"

/**
 * What each page looks like before its data arrives.
 *
 * Every `loading.tsx` under `(app)` renders one of these. They match the
 * page's real layout -- the same padding, the same card and table outlines,
 * the same composer at the foot of a project -- so the page settles into
 * place rather than jumping, and the reader can tell what is coming before it
 * has. The shell around them is already there: they only fill the page box.
 *
 * Widths inside a row are deliberately uneven. A column of identical bars
 * reads as a pattern; bars of different lengths read as text that is on its
 * way.
 */

/** The projects table: a header row, then a handful of rows. */
export function ProjectsTableSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div className="rounded-lg border">
      <div className="flex items-center gap-4 border-b px-4 py-3">
        <Skeleton className="h-3 w-16" />
        <Skeleton className="h-3 w-10" />
        <Skeleton className="h-3 w-16" />
        <Skeleton className="ml-auto h-3 w-12" />
        <Skeleton className="h-3 w-16" />
      </div>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex items-center gap-4 border-b px-4 py-3 last:border-b-0">
          <div className="flex w-56 flex-col gap-1.5">
            <Skeleton className="h-3.5" style={{ width: `${60 + ((i * 17) % 35)}%` }} />
            <Skeleton className="h-3 w-4/5 opacity-70" />
          </div>
          <Skeleton className="h-3 w-12" />
          <div className="flex items-center gap-2">
            <Skeleton className="size-2 rounded-full" />
            <Skeleton className="h-3 w-14" />
          </div>
          <Skeleton className="ml-auto h-3 w-6" />
          <Skeleton className="h-3 w-20" />
        </div>
      ))}
    </div>
  )
}

/** Code: just the table. */
export function CodeSkeleton() {
  return (
    <div className="flex flex-1 flex-col gap-4 p-4">
      <ProjectsTableSkeleton />
    </div>
  )
}

/** Dashboard: the four stat cards, then the table. */
export function DashboardSkeleton() {
  return (
    <div className="flex flex-1 flex-col gap-4 p-4">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className="flex flex-col rounded-lg border p-4">
            <div className="flex items-center gap-2">
              <Skeleton className="size-4 rounded-sm" />
              <Skeleton className="h-3 w-16" />
            </div>
            <Skeleton className="mt-3 h-8 w-14" />
            <Skeleton className="mt-2 h-3.5 w-28" />
            <Skeleton className="mt-3 h-3 w-20 opacity-70" />
          </div>
        ))}
      </div>
      <ProjectsTableSkeleton />
    </div>
  )
}

/** Settings: the tab strip, then a form's worth of fields. */
export function SettingsSkeleton() {
  return (
    <div className="flex flex-1 flex-col gap-4 overflow-auto p-4">
      <div className="w-full max-w-3xl">
        <div className="flex gap-1 border-b pb-2">
          <Skeleton className="h-7 w-20" />
          <Skeleton className="h-7 w-24" />
          <Skeleton className="h-7 w-16" />
          <Skeleton className="h-7 w-20" />
        </div>
        <div className="mt-6 flex flex-col gap-6">
          {Array.from({ length: 3 }, (_, i) => (
            <div key={i} className="flex flex-col gap-2">
              <Skeleton className="h-3.5 w-24" />
              <Skeleton className="h-9 w-full max-w-md" />
              <Skeleton className="h-3 w-56 opacity-70" />
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

/**
 * A project: an empty conversation above a composer.
 *
 * The composer is drawn at its real height so the page does not jump when the
 * live one takes its place -- it is the one thing on this page the eye is
 * already looking for.
 */
export function ProjectSkeleton() {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-hidden p-3 md:p-4">
        <div className="mx-auto flex max-w-3xl flex-col gap-4">
          <div className="flex justify-end">
            <Skeleton className="h-9 w-2/5 rounded-lg" />
          </div>
          <div className="flex flex-col gap-2">
            <Skeleton className="h-3.5 w-full" />
            <Skeleton className="h-3.5 w-11/12" />
            <Skeleton className="h-3.5 w-3/5" />
          </div>
          <div className="flex justify-end">
            <Skeleton className="h-9 w-1/4 rounded-lg" />
          </div>
          <div className="flex flex-col gap-2">
            <Skeleton className="h-3.5 w-10/12" />
            <Skeleton className="h-3.5 w-1/2" />
          </div>
        </div>
      </div>
      <div className="shrink-0 border-t p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] md:p-4 md:pb-[max(26px,env(safe-area-inset-bottom))]">
        <div className="mx-auto flex w-full max-w-[57.6rem] flex-col gap-2">
          <div className="border-input bg-background flex flex-col rounded-xl border">
            <Skeleton className="mx-3 mt-3 mb-1 h-5 w-40 opacity-60" />
            <div className="flex items-center gap-1 px-2 pb-2">
              <Skeleton className="size-8 rounded-full" />
              <Skeleton className="ml-auto size-8 rounded-full" />
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Skeleton className="h-7 w-36 rounded-lg" />
            <Skeleton className="h-7 w-24 rounded-lg" />
            <Skeleton className="ml-auto h-7 w-20 rounded-lg" />
          </div>
        </div>
      </div>
    </div>
  )
}
