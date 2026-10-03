"use client"

import dynamic from "next/dynamic"

import type { NoteReaderProps } from "@/components/public/note-reader-impl"
import { Skeleton } from "@/components/ui/skeleton"

/** The page reader, loaded on the client only -- see `NoteEditor` for why. */
export const NoteReader = dynamic<NoteReaderProps>(
  () => import("@/components/public/note-reader-impl").then((m) => m.NoteReaderImpl),
  {
    ssr: false,
    loading: () => (
      <div className="mx-auto w-full max-w-3xl px-8 py-12">
        <Skeleton className="mb-6 h-9 w-2/5" />
        <Skeleton className="mb-3 h-4 w-full" />
        <Skeleton className="h-4 w-3/5" />
      </div>
    ),
  },
)
