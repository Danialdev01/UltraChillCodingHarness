/**
 * Rewrites the shipped palette in `src/app/globals.css` from the colour
 * engine, between the `@generated` markers. Run after changing the role
 * table, the default accent or the syntax defaults:
 *
 *   npx tsx apps/web/scripts/gen-theme-css.ts
 *
 * `color-engine.test.ts` fails if the stylesheet and the engine disagree.
 */
import { readFileSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { generatedCss, replaceGenerated } from "../src/lib/theme-css.js"

const path = fileURLToPath(new URL("../src/app/globals.css", import.meta.url))
const before = readFileSync(path, "utf8")
const after = replaceGenerated(before, generatedCss())
if (after === before) {
  console.log("globals.css already up to date")
} else {
  writeFileSync(path, after)
  console.log("globals.css updated")
}
