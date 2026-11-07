import * as React from "react"

import { LogoMark } from "@/components/logo-mark"
import { cn } from "@/lib/utils"

/**
 * The frame of a page that stands outside the app: sign-in, an invite, the
 * offline fallback. One centred card, the mark above it, one h1 -- so every
 * door into the app looks like the same door.
 */
export function AuthCard({
  title,
  description,
  children,
  footer,
  className,
}: {
  title: React.ReactNode
  description?: React.ReactNode
  children?: React.ReactNode
  /** Small print under the card: a link back, a version. */
  footer?: React.ReactNode
  className?: string
}) {
  return (
    <div className="bg-background flex min-h-svh flex-col items-center justify-center px-4 py-12">
      <div className={cn("flex w-full max-w-sm flex-col gap-6", className)}>
        <div className="flex flex-col items-center gap-4 text-center">
          <LogoMark className="text-foreground size-9" />
          <div className="flex flex-col gap-1">
            <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
            {description && <p className="text-muted-foreground text-sm">{description}</p>}
          </div>
        </div>
        {children && (
          <div className="bg-card flex flex-col gap-4 rounded-xl border p-5 shadow-xs">{children}</div>
        )}
        {footer && <div className="text-muted-foreground text-center text-xs">{footer}</div>}
      </div>
    </div>
  )
}
