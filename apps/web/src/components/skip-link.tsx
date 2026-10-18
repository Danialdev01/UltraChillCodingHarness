/**
 * The first thing a keyboard reaches: a jump past the sidebar and header to
 * the page itself. Hidden until focused, then shown in the top corner.
 *
 * The target is the page box, given `id={MAIN_CONTENT_ID}` and
 * `tabIndex={-1}` so focus actually lands there rather than only scrolling.
 */
export const MAIN_CONTENT_ID = "main-content"

export function SkipLink() {
  return (
    <a
      href={`#${MAIN_CONTENT_ID}`}
      className="bg-background text-foreground sr-only z-50 rounded-md border text-sm font-medium shadow-md focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:px-3 focus:py-2"
    >
      Skip to content
    </a>
  )
}
