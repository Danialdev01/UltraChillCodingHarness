import { LogoMark } from "@/components/app-logo"

/**
 * The root page's whole content: the mark and the line under it. The
 * workspaces themselves are listed in the sidebar panel beside it.
 */
export function HomeHero() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-6 p-8 text-center">
      <LogoMark className="text-foreground size-16" />
      <h1 className="text-3xl font-semibold tracking-tight text-balance sm:text-4xl">
        Build the future together.
      </h1>
    </div>
  )
}
