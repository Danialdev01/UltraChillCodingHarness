// The one place a document's look is decided.
//
// The model writes content -- Markdown with `type:` in its front matter --
// and never margins, fonts or spacing. Every type below is a preset over the
// same tokens, so a report and a runbook look like they came from one house.
// Change the look here, re-render the golden documents, and look at them.

#let tokens = (
  body-font: ("Inter", "IBM Plex Sans", "Noto Sans", "DejaVu Sans"),
  heading-font: ("Inter", "IBM Plex Sans", "Noto Sans", "DejaVu Sans"),
  mono-font: ("JetBrains Mono", "IBM Plex Mono", "DejaVu Sans Mono"),
  size: 10.5pt,
  leading: 0.7em,
  ink: rgb("#1f2328"),
  muted: rgb("#59636e"),
  rule: rgb("#d1d9e0"),
  surface: rgb("#f6f8fa"),
  margin: (top: 2.4cm, bottom: 2.4cm, inside: 2.4cm, outside: 2.2cm),
)

#let presets = (
  report: (label: "Report", accent: rgb("#0b5cad"), cover: true, toc: true, numbering: "1.1"),
  spec: (label: "Specification", accent: rgb("#5a32a3"), cover: true, toc: true, numbering: "1.1.1"),
  api-reference: (label: "API Reference", accent: rgb("#1a7f37"), cover: false, toc: true, numbering: none),
  proposal: (label: "Proposal", accent: rgb("#bc4c00"), cover: true, toc: false, numbering: none),
  runbook: (label: "Runbook", accent: rgb("#cf222e"), cover: false, toc: true, numbering: "1."),
  memo: (label: "Memo", accent: rgb("#59636e"), cover: false, toc: false, numbering: none),
)

#let callout-styles = (
  note: (title: "Note", color: rgb("#0969da")),
  tip: (title: "Tip", color: rgb("#1a7f37")),
  important: (title: "Important", color: rgb("#8250df")),
  warning: (title: "Warning", color: rgb("#9a6700")),
  caution: (title: "Caution", color: rgb("#cf222e")),
)

// `::: warning` in the Markdown arrives here through filters.lua.
#let callout(kind: "note", body) = {
  let style = callout-styles.at(kind, default: callout-styles.note)
  block(
    width: 100%,
    inset: (left: 12pt, rest: 9pt),
    stroke: (left: 3pt + style.color),
    fill: style.color.lighten(93%),
    radius: (right: 3pt),
    breakable: true,
  )[
    #text(weight: "semibold", fill: style.color, size: 0.9em)[#upper(style.title)]
    #v(-0.3em)
    #body
  ]
}

#let horizontalrule = align(center, line(length: 40%, stroke: 0.5pt + tokens.rule))

#let plain(content) = {
  if content == none { "" }
  else if type(content) == str { content }
  else if content.has("text") { content.text }
  else if content.has("children") { content.children.map(plain).join("") }
  else if content.has("body") { plain(content.body) }
  else { " " }
}

#let cover-page(preset, title, subtitle, authors, date, version, status, abstract) = {
  set page(header: none, footer: none, margin: (x: 2.4cm, top: 3cm, bottom: 2.4cm))
  block(width: 100%, height: 6pt, fill: preset.accent)
  v(3.5cm)
  text(size: 0.95em, weight: "semibold", fill: preset.accent, tracking: 0.08em)[#upper(preset.label)]
  v(0.4em)
  text(font: tokens.heading-font, size: 2.5em, weight: "bold", fill: tokens.ink)[#title]
  if subtitle != none {
    v(0.2em)
    text(size: 1.35em, fill: tokens.muted)[#subtitle]
  }
  v(1.6cm)
  if abstract != none {
    block(width: 85%, text(size: 1.02em, fill: tokens.ink)[#abstract])
  }
  v(1fr)
  line(length: 100%, stroke: 0.5pt + tokens.rule)
  let facts = ()
  if authors.len() > 0 { facts.push(([Author], authors.join(", "))) }
  if date != none { facts.push(([Date], date)) }
  if version != none { facts.push(([Version], version)) }
  if status != none { facts.push(([Status], status)) }
  grid(
    columns: (auto, 1fr),
    column-gutter: 1.2em,
    row-gutter: 0.6em,
    ..facts.map(((k, v)) => (text(fill: tokens.muted, size: 0.9em)[#k], text(size: 0.9em)[#v])).flatten(),
  )
  pagebreak()
}

#let conf(
  doctype: "report",
  title: none,
  subtitle: none,
  authors: (),
  date: none,
  version: none,
  status: none,
  abstract: none,
  toc: auto,
  lang: "en",
  paper: "a4",
  doc,
) = {
  let preset = presets.at(doctype, default: presets.report)
  let accent = preset.accent
  let show-toc = if toc == auto { preset.toc } else { toc }

  set document(title: plain(title), author: authors.map(plain))
  set text(font: tokens.body-font, size: tokens.size, fill: tokens.ink, lang: lang, hyphenate: true)
  set par(justify: true, leading: tokens.leading, spacing: 1.05em)
  set page(
    paper: paper,
    margin: tokens.margin,
    header: context {
      if counter(page).get().first() > 1 {
        set text(size: 0.8em, fill: tokens.muted)
        grid(columns: (1fr, auto), preset.label, title)
        v(-0.5em)
        line(length: 100%, stroke: 0.4pt + tokens.rule)
      }
    },
    footer: context {
      set text(size: 0.8em, fill: tokens.muted)
      align(center)[#counter(page).display("1") / #counter(page).final().first()]
    },
  )

  set heading(numbering: preset.numbering)
  show heading: set text(font: tokens.heading-font, fill: tokens.ink)
  show heading.where(level: 1): it => {
    set text(size: 1.55em, weight: "bold", fill: accent)
    block(above: 1.8em, below: 0.9em, sticky: true, it)
  }
  show heading.where(level: 2): it => {
    set text(size: 1.22em, weight: "semibold")
    block(above: 1.5em, below: 0.7em, sticky: true, it)
  }
  show heading.where(level: 3): it => {
    set text(size: 1.05em, weight: "semibold")
    block(above: 1.3em, below: 0.6em, sticky: true, it)
  }

  show link: set text(fill: accent)
  show raw: set text(font: tokens.mono-font, size: 0.9em)
  show raw.where(block: true): it => block(
    width: 100%, fill: tokens.surface, inset: 9pt, radius: 3pt, stroke: 0.4pt + tokens.rule, it,
  )
  show quote.where(block: true): it => block(
    inset: (left: 12pt, y: 4pt), stroke: (left: 2pt + tokens.rule), text(fill: tokens.muted, it.body),
  )

  set table(
    inset: (x: 7pt, y: 5pt),
    stroke: (x, y) => if y == 0 { (bottom: 0.8pt + tokens.ink) } else { (bottom: 0.4pt + tokens.rule) },
    fill: (x, y) => if y == 0 { tokens.surface },
  )
  show table.cell.where(y: 0): set text(weight: "semibold")
  show table: set text(size: 0.92em)
  show table: set par(justify: false)

  show figure: set block(breakable: false, above: 1.4em, below: 1.4em)
  show figure.where(kind: table): set figure.caption(position: top)
  show figure.where(kind: table): set block(breakable: true)
  show figure.caption: set text(size: 0.88em, fill: tokens.muted)

  // An image never runs past the text block: scaled down to fit, never up.
  show image: it => layout(size => {
    let natural = measure(it)
    if natural.width > size.width and natural.width > 0pt {
      let f = size.width / natural.width * 100%
      scale(x: f, y: f, reflow: true, it)
    } else { it }
  })

  show terms: it => it.children.map(child => [
    #strong[#child.term]
    #block(inset: (left: 1.5em, top: -0.4em))[#child.description]
  ]).join()

  if preset.cover and title != none {
    cover-page(preset, title, subtitle, authors, date, version, status, abstract)
  } else if title != none {
    block(width: 100%, height: 4pt, fill: accent)
    v(0.6em)
    text(size: 0.85em, weight: "semibold", fill: accent, tracking: 0.08em)[#upper(preset.label)]
    v(0.1em)
    text(font: tokens.heading-font, size: 2em, weight: "bold")[#title]
    if subtitle != none { linebreak(); text(size: 1.2em, fill: tokens.muted)[#subtitle] }
    let meta = (authors.join(", "), date, version, status).filter(x => x != none and x != "" and x != [])
    if meta.len() > 0 { v(0.3em); text(size: 0.9em, fill: tokens.muted, meta.join("  ·  ")) }
    if abstract != none { v(0.8em); block(inset: (left: 10pt), stroke: (left: 2pt + accent), abstract) }
    v(1.2em)
  }

  if show-toc {
    show outline.entry.where(level: 1): set text(weight: "semibold")
    outline(title: [Contents], depth: 3, indent: auto)
    if preset.cover { pagebreak() } else { v(1.2em) }
  }

  doc
}
