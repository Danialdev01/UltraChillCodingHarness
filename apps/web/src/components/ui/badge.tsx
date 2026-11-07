import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

/**
 * A short status label: a project's mode, an env var's tag, a column's key,
 * "Soon" on a feature not built yet. One shape everywhere, so a pill reads
 * the same on every page; the tone carries the meaning.
 */
const badgeVariants = cva(
  "inline-flex h-5 shrink-0 items-center gap-1 rounded-md border px-1.5 text-2xs font-medium whitespace-nowrap [&_svg]:pointer-events-none [&_svg]:size-3 [&_svg]:shrink-0",
  {
    variants: {
      tone: {
        neutral: "border-transparent bg-muted text-muted-foreground",
        active: "border-transparent bg-ucch-active-bg text-ucch-active",
        success: "border-transparent bg-success-soft text-success",
        warning: "border-transparent bg-warning-soft text-warning",
        danger: "border-transparent bg-danger-soft text-danger",
        outline: "border-border text-muted-foreground",
      },
    },
    defaultVariants: { tone: "neutral" },
  },
)

function Badge({
  className,
  tone,
  ...props
}: React.ComponentProps<"span"> & VariantProps<typeof badgeVariants>) {
  return <span data-slot="badge" className={cn(badgeVariants({ tone }), className)} {...props} />
}

/** The marker on anything whose feature has not landed yet. */
function SoonBadge({ className }: { className?: string }) {
  return (
    <Badge tone="outline" className={className}>
      Soon
    </Badge>
  )
}

export { Badge, SoonBadge, badgeVariants }
