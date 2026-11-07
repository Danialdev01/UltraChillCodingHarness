"use client"

import * as React from "react"
import { AlertCircleIcon, RotateCwIcon, XIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

/**
 * Something went wrong loading or saving what is on this page: what failed,
 * and -- when it can be tried again -- a retry. One look for every error that
 * is not a toast, so a failure reads the same on every page.
 */
export function InlineError({
  title,
  children,
  onRetry,
  onDismiss,
  className,
  tone = "danger",
}: {
  title?: React.ReactNode
  children?: React.ReactNode
  onRetry?: () => void
  onDismiss?: () => void
  className?: string
  tone?: "danger" | "warning" | "neutral"
}) {
  return (
    <div
      role={tone === "neutral" ? "status" : "alert"}
      className={cn(
        "flex items-start gap-2.5 rounded-lg border px-3 py-2 text-sm",
        tone === "danger" && "border-danger/25 bg-danger-soft text-danger",
        tone === "warning" && "border-warning/25 bg-warning-soft text-warning",
        tone === "neutral" && "bg-muted/50 text-foreground",
        className,
      )}
    >
      <AlertCircleIcon className="mt-0.5 size-4 shrink-0" aria-hidden />
      <div className="min-w-0 flex-1">
        {title && <p className="font-medium">{title}</p>}
        {children && <div className={cn(title && "mt-0.5", "text-foreground break-words")}>{children}</div>}
      </div>
      {onRetry && (
        <Button variant="ghost" size="xs" onClick={onRetry} className="-my-0.5 shrink-0">
          <RotateCwIcon data-icon="inline-start" />
          Retry
        </Button>
      )}
      {onDismiss && (
        <Button variant="ghost" size="icon-xs" onClick={onDismiss} aria-label="Dismiss" className="-my-0.5 shrink-0">
          <XIcon />
        </Button>
      )}
    </div>
  )
}
