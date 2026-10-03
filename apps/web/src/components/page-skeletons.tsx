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

/** Settings: a form's worth of fields. The pages themselves are sidebar rows. */
export function SettingsSkeleton() {
  return (
    <div className="flex flex-1 flex-col gap-4 overflow-auto p-4">
      <div className="w-full max-w-3xl">
        <div className="flex flex-col gap-6">
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

/**
 * Notes: the notes' own top bar, an empty page, and the tree column at the
 * right. The bar and the column are drawn at their real sizes -- 2.5rem and
 * 15rem -- so the live ones take their place without the page shifting.
 */
export function NotesSkeleton() {
  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="flex h-10 items-center gap-2 border-b pr-2 pl-4">
          <div className="flex flex-1 items-center gap-2">
            <Skeleton className="h-3 w-16" />
            <Skeleton className="h-3 w-3 opacity-50" />
            <Skeleton className="h-3 w-24" />
          </div>
          <Skeleton className="size-6 rounded-md" />
          <Skeleton className="size-6 rounded-md" />
        </div>
        <div className="min-h-0 flex-1 overflow-hidden">
          <div className="mx-auto w-full max-w-3xl px-8 py-12">
            <Skeleton className="mb-6 h-9 w-2/5" />
            <Skeleton className="mb-3 h-4 w-full" />
            <Skeleton className="mb-3 h-4 w-11/12" />
            <Skeleton className="h-4 w-3/5" />
          </div>
        </div>
      </div>
      <aside className="bg-sidebar/40 flex w-60 shrink-0 flex-col border-l">
        <div className="flex h-10 items-center justify-between border-b px-3">
          <Skeleton className="h-3 w-12" />
          <Skeleton className="size-6 rounded-md" />
        </div>
        <div className="flex flex-col gap-1 px-3 py-2">
          {Array.from({ length: 5 }, (_, i) => (
            <div key={i} className="flex items-center gap-2 py-1" style={{ paddingLeft: i === 0 ? 0 : 12 }}>
              <Skeleton className="size-3.5 rounded-sm" />
              <Skeleton className="h-3" style={{ width: `${45 + ((i * 23) % 40)}%` }} />
            </div>
          ))}
        </div>
      </aside>
    </div>
  )
}

/**
 * The Git view: the toolbar's two wide buttons, the changes column with its
 * tab strip and rows, and a diff on the right. Drawn at the real widths --
 * 3rem toolbar, 20rem column -- so the live view slots in without a jump.
 */
export function GitSkeleton() {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-12 items-stretch border-b">
        {[0, 1].map((i) => (
          <div key={i} className="flex w-44 items-center gap-3 border-r px-3">
            <Skeleton className="size-4 rounded-sm" />
            <div className="flex flex-1 flex-col gap-1.5">
              <Skeleton className="h-3" style={{ width: i === 0 ? "55%" : "70%" }} />
              <Skeleton className="h-2.5 opacity-60" style={{ width: i === 0 ? "80%" : "60%" }} />
            </div>
          </div>
        ))}
      </div>
      <div className="flex min-h-0 flex-1">
        <div className="flex w-72 shrink-0 flex-col border-r sm:w-80">
          <div className="grid h-9 grid-cols-2 border-b">
            <div className="flex items-center justify-center">
              <Skeleton className="h-3 w-16" />
            </div>
            <div className="flex items-center justify-center">
              <Skeleton className="h-3 w-14 opacity-60" />
            </div>
          </div>
          <div className="flex items-center gap-2 border-b px-3 py-2">
            <Skeleton className="size-3.5 rounded-sm" />
            <Skeleton className="h-3 w-24" />
          </div>
          <div className="flex flex-col gap-1 px-3 py-2">
            {Array.from({ length: 6 }, (_, i) => (
              <div key={i} className="flex items-center gap-2 py-1">
                <Skeleton className="size-3.5 rounded-sm" />
                <Skeleton className="size-3.5 rounded-sm" />
                <Skeleton className="h-3" style={{ width: `${45 + ((i * 23) % 40)}%` }} />
                <Skeleton className="ml-auto size-4 rounded-sm" />
              </div>
            ))}
          </div>
          <div className="mt-auto flex flex-col gap-2 border-t p-3">
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-7 w-full" />
          </div>
        </div>
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex h-8 items-center gap-2 border-b px-3">
            <Skeleton className="size-3.5 rounded-sm" />
            <Skeleton className="h-3 w-40" />
          </div>
          <div className="flex flex-col gap-1.5 p-3">
            {Array.from({ length: 12 }, (_, i) => (
              <div key={i} className="flex items-center gap-3">
                <Skeleton className="h-3 w-6 opacity-50" />
                <Skeleton className="h-3 w-6 opacity-50" />
                <Skeleton className="h-3" style={{ width: `${20 + ((i * 37) % 55)}%` }} />
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

/**
 * A database view: the tab strip across the top and a table of rows below
 * it. This is what a page under the database layout shows while it loads,
 * inside the shell the layout already drew.
 */
export function DatabaseViewSkeleton() {
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex h-10 items-center gap-4 border-b px-4">
        {[14, 8, 12, 12, 20].map((w, i) => (
          <Skeleton key={i} className="h-3" style={{ width: `${w * 4}px` }} />
        ))}
      </div>
      <div className="flex flex-col gap-3 p-4">
        <div className="flex items-center gap-2">
          <Skeleton className="h-8 w-40" />
          <Skeleton className="ml-auto h-8 w-24" />
        </div>
        <div className="rounded-lg border">
          {Array.from({ length: 6 }, (_, i) => (
            <div key={i} className="flex items-center gap-4 border-b px-3 py-2.5 last:border-b-0">
              <Skeleton className="h-3" style={{ width: `${20 + ((i * 17) % 30)}%` }} />
              <Skeleton className="h-3 w-12" />
              <Skeleton className="ml-auto h-3 w-16" />
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

/**
 * A database before its connection is known: the view, and the tables
 * column at the right at its real 16rem so the live one takes its place
 * without the page shifting.
 */
export function DatabaseSkeleton() {
  return (
    <div className="flex min-h-0 flex-1">
      <DatabaseViewSkeleton />
      <aside className="bg-sidebar/40 hidden w-64 shrink-0 flex-col border-l md:flex">
        <div className="flex h-10 items-center justify-between border-b px-3">
          <Skeleton className="h-3 w-20" />
          <Skeleton className="size-6 rounded-md" />
        </div>
        <div className="flex flex-col gap-1 px-3 py-2">
          {Array.from({ length: 7 }, (_, i) => (
            <div key={i} className="flex items-center gap-2 py-1">
              <Skeleton className="size-3.5 rounded-sm" />
              <Skeleton className="h-3" style={{ width: `${40 + ((i * 23) % 45)}%` }} />
            </div>
          ))}
        </div>
      </aside>
    </div>
  )
}

/**
 * The timeline before its tasks arrive: the toolbar, then rows of a name
 * beside a bar, each bar starting and ending somewhere different so it
 * reads as a chart rather than a table.
 */
export function TimelineSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b pr-2 pl-4">
        <Skeleton className="size-4 rounded-sm" />
        <Skeleton className="h-3 w-16" />
        <div className="flex-1" />
        <Skeleton className="h-7 w-36 rounded-lg" />
        <Skeleton className="h-7 w-20 rounded-lg" />
      </div>
      <div className="flex min-h-0 flex-1">
        <div className="w-64 shrink-0 border-r">
          <div className="h-11 border-b" />
          {Array.from({ length: rows }, (_, i) => (
            <div key={i} className="flex h-9 items-center gap-2 border-b px-3">
              <Skeleton className="size-2.5 rounded-full" />
              <Skeleton className="h-3" style={{ width: `${35 + ((i * 29) % 40)}%` }} />
            </div>
          ))}
        </div>
        <div className="min-w-0 flex-1">
          <div className="h-11 border-b" />
          {Array.from({ length: rows }, (_, i) => (
            <div key={i} className="flex h-9 items-center border-b">
              <Skeleton
                className="h-5 rounded-md"
                style={{ marginLeft: `${5 + ((i * 17) % 40)}%`, width: `${15 + ((i * 13) % 30)}%` }}
              />
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

/** A project's keys: the toolbar, then name, masked value, tags and URL per row. */
export function KeysSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b pr-2 pl-4">
        <Skeleton className="size-4 rounded-sm" />
        <Skeleton className="h-3 w-12" />
        <div className="flex-1" />
        <Skeleton className="h-7 w-20 rounded-lg" />
      </div>
      <div className="h-10 border-b" />
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex h-11 items-center gap-6 border-b px-4">
          <Skeleton className="h-3" style={{ width: `${10 + ((i * 7) % 8)}%` }} />
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-4 w-16 rounded-md" />
          <Skeleton className="h-3 w-32" />
        </div>
      ))}
    </div>
  )
}
