"use client"

import * as React from "react"
import { AlertTriangleIcon, CheckIcon, CodeIcon, RotateCcwIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { useTheme } from "@/components/theme-provider"
import {
  defaultSyntaxTheme,
  SYNTAX_ROLES,
  type SyntaxRole,
  type SyntaxTheme,
} from "@/lib/syntax-theme"
import type { SelectionColors } from "@/lib/selection-color"
import { contrast, isValidHex, normalizeHex } from "@/lib/theme"

/**
 * A sample of code, one span per token, coloured by the same variables the
 * editor reads. It is the preview: changing a colour below recolours the
 * matching tokens here at once, and the editor behind the settings page the
 * same way.
 */
const SAMPLE: ReadonlyArray<ReadonlyArray<[SyntaxRole | null, string]>> = [
  [["comment", "// Fetch a project and count its open threads"]],
  [
    ["keyword", "import"], [null, " { "], ["variable", "client"], [null, " } "], ["keyword", "from"],
    [null, " "], ["string", '"@/lib/client"'], ["punctuation", ";"],
  ],
  [],
  [
    ["keyword", "export"], [null, " "], ["keyword", "async function"], [null, " "],
    ["function", "openThreads"], ["punctuation", "("], ["variable", "hash"], ["punctuation", ": "],
    ["type", "string"], ["punctuation", ")"], ["punctuation", ": "], ["type", "Promise"],
    ["punctuation", "<"], ["type", "number"], ["punctuation", "> {"],
  ],
  [
    [null, "  "], ["keyword", "const"], [null, " "], ["variable", "project"], [null, " "],
    ["operator", "="], [null, " "], ["keyword", "await"], [null, " "], ["variable", "client"],
    ["punctuation", "."], ["function", "get"], ["punctuation", "("], ["string", "`/api/projects/${"],
    ["variable", "hash"], ["string", "}`"], ["punctuation", ");"],
  ],
  [
    [null, "  "], ["keyword", "if"], [null, " "], ["punctuation", "("], ["operator", "!"],
    ["variable", "project"], ["punctuation", ") "], ["keyword", "return"], [null, " "],
    ["number", "0"], ["punctuation", ";"],
  ],
  [
    [null, "  "], ["keyword", "return"], [null, " "], ["variable", "project"], ["punctuation", "."],
    ["property", "threads"], ["punctuation", "."], ["function", "filter"], ["punctuation", "("],
    ["variable", "t"], [null, " "], ["operator", "=>"], [null, " "], ["variable", "t"],
    ["punctuation", "."], ["property", "status"], [null, " "], ["operator", "!=="], [null, " "],
    ["string", '"closed"'], ["punctuation", ")."], ["property", "length"], ["punctuation", ";"],
  ],
  [["punctuation", "}"]],
  [],
  [
    ["punctuation", "<"], ["tag", "Button"], [null, " "], ["attribute", "variant"], ["operator", "="],
    ["string", '"ghost"'], [null, " "], ["attribute", "disabled"], ["operator", "="],
    ["punctuation", "{"], ["number", "true"], ["punctuation", "}>"], [null, "Open"],
    ["punctuation", "</"], ["tag", "Button"], ["punctuation", ">"],
  ],
  [["heading", "# Notes"], [null, "  "], ["link", "https://example.com"], [null, "  "], ["invalid", "<<<"]],
]

/**
 * Where the file view's colours are chosen.
 *
 * One colour per kind of token rather than a fixed scheme: this is the one
 * place in the app where the 60-30-10 palette does not reach, because three
 * colours cannot say how a keyword differs from a string. Until something is
 * changed, the colours follow the light/dark defaults; the first edit copies
 * those defaults into a custom set so the other roles stay as they were.
 */
export function SyntaxSettings() {
  const { syntax, setSyntax, resolvedMode, tokens, selection } = useTheme()
  const dark = resolvedMode === "dark"
  const effective: SyntaxTheme = syntax ?? defaultSyntaxTheme(dark)

  // Drafts so a half-typed hex is not normalised out from under the cursor;
  // resynced whenever the colours change from anywhere else.
  const [drafts, setDrafts] = React.useState<SyntaxTheme>({ ...effective })
  React.useEffect(() => setDrafts({ ...effective }), [syntax, dark]) // eslint-disable-line react-hooks/exhaustive-deps

  function update(key: SyntaxRole, value: string) {
    setSyntax({ ...effective, [key]: normalizeHex(value, effective[key]) })
  }

  return (
    <section className="rounded-lg border p-6">
      <h2 className="flex items-center gap-2 text-sm font-medium">
        <CodeIcon className="text-muted-foreground size-4" />
        Code colours
      </h2>
      <p className="text-muted-foreground mt-2 max-w-prose text-sm">
        The syntax highlighting in the file view, one colour per kind of token. Edits apply to
        the sample below and to any open file at once. Saved in this browser.
      </p>

      <pre
        aria-label="Sample code"
        className="bg-card border-border mt-5 max-w-xl overflow-x-auto rounded-md border p-3 font-mono text-xs leading-relaxed"
      >
        {SAMPLE.map((line, i) => (
          <React.Fragment key={i}>
            {line.map(([role, text], j) =>
              role ? (
                <span key={j} style={{ color: effective[role] }}>
                  {text}
                </span>
              ) : (
                <span key={j}>{text}</span>
              ),
            )}
            {"\n"}
          </React.Fragment>
        ))}
      </pre>

      <SelectionPreview selection={selection} syntax={effective} background={tokens.background!} />

      <div className="mt-5 grid max-w-xl gap-3">
        {SYNTAX_ROLES.map((role) => (
          <div key={role.key} className="flex flex-wrap items-center gap-3">
            <label
              className="border-border relative size-8 shrink-0 overflow-hidden rounded-md border"
              style={{ backgroundColor: effective[role.key] }}
            >
              <span className="sr-only">{role.label} colour</span>
              <input
                type="color"
                value={effective[role.key]}
                onChange={(e) => update(role.key, e.target.value)}
                className="absolute inset-0 size-full cursor-pointer opacity-0"
              />
            </label>

            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium" style={{ color: effective[role.key] }}>
                {role.label}
              </p>
              <p className="text-muted-foreground truncate text-xs">{role.hint}</p>
            </div>

            <ContrastBadge color={effective[role.key]} surfaces={[tokens.background!, tokens.card!, tokens.muted!]} />

            <Input
              value={drafts[role.key]}
              onChange={(e) => {
                const next = e.target.value
                setDrafts((d) => ({ ...d, [role.key]: next }))
                if (isValidHex(next)) update(role.key, next)
              }}
              onBlur={() => setDrafts((d) => ({ ...d, [role.key]: effective[role.key] }))}
              spellCheck={false}
              autoComplete="off"
              aria-label={`${role.label} hex`}
              aria-invalid={!isValidHex(drafts[role.key])}
              className="w-28 font-mono text-sm"
            />
          </div>
        ))}
      </div>

      <div className="mt-5 flex flex-wrap items-center gap-2">
        <Button variant="ghost" onClick={() => setSyntax(null)} disabled={!syntax}>
          <RotateCcwIcon />
          Reset to defaults
        </Button>
        <span className="text-muted-foreground text-sm">
          {syntax
            ? "Using custom colours."
            : `Using the default ${dark ? "dark" : "light"} colours, which follow the palette.`}
        </span>
      </div>
    </section>
  )
}

/** One selected line: a comment, then a keyword and plain text. */
const SELECTED_SAMPLE: ReadonlyArray<ReadonlyArray<[SyntaxRole | null, string]>> = [
  [["comment", "%% Write the schema here"]],
  [["keyword", "PK"], [null, " "], ["type", "uuid"], [null, " id "], ["string", '"project"']],
]

/**
 * Selected text as the editor paints it, focused and unfocused, on the
 * editor's own background. The selection is derived from the accent rather
 * than used as picked (see `selection-color.ts`); when it had to move for a
 * token to stay readable, this says so -- the pick itself is left alone.
 */
function SelectionPreview({
  selection,
  syntax,
  background,
}: {
  selection: SelectionColors
  syntax: SyntaxTheme
  background: string
}) {
  const states = [
    ["Focused", selection.focused],
    ["Unfocused", selection.unfocused],
  ] as const
  return (
    <div className="mt-5 max-w-xl">
      <h3 className="text-sm font-medium">Selected text</h3>
      <div
        aria-label="Selected text sample"
        className="border-border mt-2 grid gap-2 rounded-md border p-3 font-mono text-xs leading-relaxed"
        style={{ backgroundColor: background }}
      >
        {states.map(([label, state]) => (
          <div key={label} className="flex items-start gap-3">
            <span className="text-muted-foreground w-20 shrink-0 font-sans">{label}</span>
            <pre className="m-0">
              {SELECTED_SAMPLE.map((line, i) => (
                <React.Fragment key={i}>
                  <span style={{ backgroundColor: state.background }}>
                    {line.map(([role, text], j) => (
                      <span key={j} style={{ color: state.text ?? (role ? syntax[role] : undefined) }}>
                        {text}
                      </span>
                    ))}
                  </span>
                  {"\n"}
                </React.Fragment>
              ))}
            </pre>
          </div>
        ))}
      </div>
      {selection.focused.adjusted && (
        <p className="text-muted-foreground mt-2 text-xs">
          Adjusted for readability: the selection is shifted from your accent so every code
          colour stays readable on it
          {selection.focused.text ? ", and selected text is shown in a single colour" : ""}.
        </p>
      )}
    </div>
  )
}

/**
 * A colour's contrast against the editor's surfaces, live. Code colours are
 * the user's to choose, but a comment you cannot read is still a bug: below
 * 4.5:1 this says so, with an icon as well as colour.
 */
function ContrastBadge({ color, surfaces }: { color: string; surfaces: string[] }) {
  const ratio = Math.min(...surfaces.map((s) => contrast(color, s)))
  const ok = ratio >= 4.5
  return (
    <span
      className={"inline-flex w-20 items-center gap-1 font-mono text-xs " + (ok ? "text-muted-foreground" : "text-warning")}
      title={ok ? "Readable (WCAG AA)" : "Below 4.5:1 on the editor background"}
    >
      {ok ? <CheckIcon className="size-3" aria-hidden /> : <AlertTriangleIcon className="size-3" aria-hidden />}
      {ratio.toFixed(1)}:1
      <span className="sr-only">{ok ? "contrast passes" : "contrast too low"}</span>
    </span>
  )
}
