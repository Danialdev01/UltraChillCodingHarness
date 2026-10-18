import { notFound } from "next/navigation"
import { ThemeGrid } from "./theme-grid"

/**
 * Fifty random seeds in both modes, side by side, for looking at.
 *
 * Passing contrast does not make a palette look good; the 10,000-seed test
 * proves the first and this page is where the second gets judged (doc §3.5).
 * Development only.
 */
export default function ThemesPreviewPage() {
  if (process.env.NODE_ENV === "production") notFound()
  return <ThemeGrid />
}
