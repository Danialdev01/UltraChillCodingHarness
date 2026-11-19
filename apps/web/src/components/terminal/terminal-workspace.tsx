"use client"

import dynamic from "next/dynamic"

import { TerminalWorkspaceSkeleton } from "@/components/page-skeletons"

/**
 * The Terminal page, split off: xterm and the panels are only loaded by
 * someone who opens it.
 */
export const TerminalWorkspace = dynamic(
  () => import("@/components/terminal/remote-terminal-workspace").then((m) => m.RemoteTerminalWorkspace),
  { ssr: false, loading: () => <TerminalWorkspaceSkeleton /> },
)
