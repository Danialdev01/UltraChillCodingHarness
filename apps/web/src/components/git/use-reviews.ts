"use client"

import * as React from "react"
import type { ReviewFinding, ReviewRecord, ReviewScope } from "@ucch/protocol"
import { useQuery, useQueryClient } from "@tanstack/react-query"

import { qk } from "@/lib/query-keys"
import { useProjectEvents, useRealtime } from "@/lib/realtime"
import { fetchReviews, findingsMessage } from "@/lib/review-api"
import { targetOf } from "@/lib/project-target"
import type { Project } from "@/lib/session"

export interface ReviewsState {
  reviews: ReviewRecord[]
  /** The first read has come back: until then the banner is a skeleton, never "no reviews". */
  loaded: boolean
  /** The review the banner shows and the diff draws: the one picked, else the latest. */
  active: ReviewRecord | null
  pick(id: string | null): void
  /** A review asked for and not yet back: the buttons wait. */
  running: boolean
  error: string | null
  clearError(): void
  run(scope: ReviewScope, ref?: string): Promise<void>
  /** Posts findings to the session's thread as a message; false when there is none, or it refused. */
  send(review: ReviewRecord, findings: readonly ReviewFinding[]): Promise<boolean>
  /** The session's thread, which reviews run for and findings go to; null on the checkout. */
  threadId: string | null
}

/**
 * The Git view's code reviews (solution §9.3, OM7.8).
 *
 * A query of the tree's reviews, read again whenever the project's stream
 * says one was asked for, finished or failed -- by this tab or another.
 * `review.run` goes over the socket; the row it makes is in the next read.
 *
 * `threadId` is the session the page is: its worktree is what is reviewed
 * when it has one (`worktree`), and its chat is where Send to agent posts.
 */
export function useReviews(project: Project, session: { id: string; worktree: boolean } | null): ReviewsState {
  const { client, toast } = useRealtime()
  const queryClient = useQueryClient()
  const projectHash = project.hash
  const sessionHash = project.sessionHash ?? null
  const target = React.useMemo(() => targetOf({ hash: projectHash, sessionHash }), [projectHash, sessionHash])
  const query = useQuery({
    queryKey: qk.reviews(projectHash, sessionHash),
    queryFn: () => fetchReviews(target),
    staleTime: Infinity,
    refetchOnMount: "always",
    refetchOnWindowFocus: false,
    retry: false,
  })
  const reviews = React.useMemo(() => query.data ?? [], [query.data])

  useProjectEvents(project.id, (event) => {
    if (event.type === "review.requested" || event.type === "review.completed" || event.type === "review.failed") {
      void queryClient.invalidateQueries({ queryKey: ["reviews", projectHash] })
    }
  })

  const [picked, setPicked] = React.useState<string | null>(null)
  const [asking, setAsking] = React.useState(false)
  const [localError, setLocalError] = React.useState<string | null>(null)
  const active = reviews.find((review) => review.id === picked) ?? reviews[0] ?? null
  const running = asking || reviews.some((review) => review.status === "running")
  const threadId = session?.id ?? null
  const reviewThread = session?.worktree ? session.id : null

  const run = React.useCallback(
    async (scope: ReviewScope, ref?: string) => {
      if (!client) return
      setLocalError(null)
      setAsking(true)
      try {
        await client.dispatch({
          type: "review.run",
          projectId: project.id,
          scope,
          ...(ref ? { ref } : {}),
          ...(reviewThread ? { threadId: reviewThread } : {}),
        })
        // The newest is what the banner follows from here.
        setPicked(null)
        await queryClient.invalidateQueries({ queryKey: qk.reviews(projectHash, sessionHash) })
      } catch (error) {
        setLocalError(error instanceof Error ? error.message : "Could not start the review.")
      } finally {
        setAsking(false)
      }
    },
    [client, project.id, queryClient, projectHash, sessionHash, reviewThread],
  )

  const send = React.useCallback(
    async (review: ReviewRecord, findings: readonly ReviewFinding[]) => {
      if (!client || !threadId || findings.length === 0) return false
      try {
        await client.dispatch({ type: "thread.send", threadId, text: findingsMessage(review, findings) })
        toast({ title: `Sent ${findings.length === 1 ? "the finding" : `${findings.length} findings`} to the agent` })
        return true
      } catch (error) {
        toast({ title: "Could not send the findings", description: error instanceof Error ? error.message : undefined, tone: "error" })
        return false
      }
    },
    [client, threadId, toast],
  )

  return {
    reviews,
    loaded: query.isFetched,
    active,
    pick: setPicked,
    running,
    error: localError ?? (query.error instanceof Error ? query.error.message : null),
    clearError: () => setLocalError(null),
    run,
    send,
    threadId,
  }
}
