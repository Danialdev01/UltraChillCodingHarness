/**
 * The browser imports no zod it does not use. The `@ucch/protocol` barrel
 * builds every schema when it loads, so a value imported from it -- one
 * label, one limit -- puts all of zod in the shell's first load. Values come
 * from `@ucch/protocol/plain`; the few schemas a form validates with come
 * from `@ucch/protocol/database`, on the pages that have those forms; the
 * barrel is for types (`import type`), and for the development-only frame
 * check, which loads it dynamically.
 */
import { readdirSync, readFileSync } from "node:fs"
import { join, relative } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const SRC = fileURLToPath(new URL("..", import.meta.url))

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? walk(join(dir, entry.name))
      : /\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)
        ? [join(dir, entry.name)]
        : [],
  )
}

const sources = walk(SRC).map((path) => ({ path: relative(SRC, path), text: readFileSync(path, "utf8") }))

/** Static `import { … }` / `export { … }` from the barrel, other than `import type`. */
const VALUE_FROM_BARREL = /^(?:import|export)\s+(?!type\b)(?:\{[^}]*\}|\*(?:\s+as\s+\w+)?|\w+)\s+from\s+"@ucch\/protocol"/m

describe("protocol imports", () => {
  it("takes values from @ucch/protocol/plain, not the barrel", () => {
    const hits = sources.filter(({ text }) => VALUE_FROM_BARREL.test(text)).map(({ path }) => path)
    expect(hits, "import values from @ucch/protocol/plain; the barrel is for `import type`").toEqual([])
  })

  it("loads the schemas only where a form validates with them", () => {
    const hits = sources
      .filter(({ text }) => text.includes('from "@ucch/protocol/database"'))
      .map(({ path }) => path)
      .filter((path) => !path.startsWith("components/database/"))
    expect(hits).toEqual([])
  })

  it("catches a value import from the barrel", () => {
    expect(VALUE_FROM_BARREL.test(`import { TASK_STAGES } from "@ucch/protocol"`)).toBe(true)
    expect(VALUE_FROM_BARREL.test(`import {\n  TASK_STAGES,\n  type TaskStage,\n} from "@ucch/protocol"`)).toBe(true)
    expect(VALUE_FROM_BARREL.test(`export { estimateTokens } from "@ucch/protocol"`)).toBe(true)
    expect(VALUE_FROM_BARREL.test(`import type { TaskStage } from "@ucch/protocol"`)).toBe(false)
    expect(VALUE_FROM_BARREL.test(`import { TASK_STAGES } from "@ucch/protocol/plain"`)).toBe(false)
    expect(VALUE_FROM_BARREL.test(`import * as protocol from "@ucch/protocol"`)).toBe(true)
    expect(VALUE_FROM_BARREL.test(`import { cn } from "@/lib/utils"\nimport type { TaskStage } from "@ucch/protocol"`)).toBe(false)
  })
})
