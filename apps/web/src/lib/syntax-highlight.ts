import { HighlightStyle } from "@codemirror/language"
import { tags as t, tagHighlighter, type Tag } from "@lezer/highlight"

import type { SyntaxRole } from "./syntax-theme.js"

/**
 * Which of Lezer's tags belong to which of our roles.
 *
 * The mapping is the same one CodeMirror's default style makes, folded down
 * to the roles a person would actually want to colour separately. It is one
 * table used two ways: as the editor's highlight style, and as a class-name
 * highlighter for code shown outside an editor (the diff view), where a
 * `.syn-<role>` rule in `globals.css` supplies the same colour.
 */
export const SYNTAX_TAG_ROLES: ReadonlyArray<{ tags: Tag[]; role: SyntaxRole }> = [
  { tags: [t.keyword, t.modifier, t.controlKeyword, t.operatorKeyword, t.definitionKeyword, t.moduleKeyword], role: "keyword" },
  { tags: [t.string, t.special(t.string), t.character], role: "string" },
  { tags: [t.number, t.integer, t.float, t.bool, t.atom, t.null, t.literal, t.unit, t.color], role: "number" },
  { tags: [t.comment, t.lineComment, t.blockComment, t.docComment], role: "comment" },
  { tags: [t.function(t.variableName), t.function(t.propertyName), t.function(t.definition(t.variableName)), t.macroName], role: "function" },
  { tags: [t.variableName, t.definition(t.variableName), t.local(t.variableName), t.name, t.labelName, t.self], role: "variable" },
  { tags: [t.propertyName, t.definition(t.propertyName), t.special(t.variableName)], role: "property" },
  { tags: [t.typeName, t.className, t.namespace, t.annotation, t.standard(t.typeName)], role: "type" },
  { tags: [t.operator, t.arithmeticOperator, t.logicOperator, t.compareOperator, t.definitionOperator, t.updateOperator, t.derefOperator, t.bitwiseOperator], role: "operator" },
  { tags: [t.punctuation, t.bracket, t.paren, t.brace, t.squareBracket, t.angleBracket, t.separator, t.meta, t.processingInstruction], role: "punctuation" },
  { tags: [t.tagName, t.standard(t.tagName)], role: "tag" },
  { tags: [t.attributeName, t.attributeValue], role: "attribute" },
  { tags: [t.heading, t.heading1, t.heading2, t.heading3, t.heading4, t.heading5, t.heading6], role: "heading" },
  { tags: [t.link, t.url, t.regexp, t.escape, t.inserted], role: "link" },
  { tags: [t.invalid, t.deleted], role: "invalid" },
]

/**
 * The editor's highlight style, coloured entirely by `--syn-*` variables.
 *
 * Nothing here is a colour: each rule names a role, and the role's variable
 * is whatever the theme settings painted onto <html> -- or the stylesheet's
 * light/dark default when nothing was. That is what lets a change in the
 * settings show up in an open editor without rebuilding it.
 */
const roleColor = (role: SyntaxRole) => `var(--syn-${role})`

export const syntaxHighlightStyle = HighlightStyle.define([
  ...SYNTAX_TAG_ROLES.map(({ tags, role }) => ({
    tag: tags,
    color: roleColor(role),
    ...(role === "comment" ? { fontStyle: "italic" } : {}),
    ...(role === "heading" ? { fontWeight: "bold" } : {}),
  })),
  { tag: t.strong, fontWeight: "bold" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strikethrough, textDecoration: "line-through" },
  { tag: t.link, textDecoration: "underline" },
])

/** The same roles as class names, for code rendered as plain elements. */
export const syntaxTagHighlighter = tagHighlighter(
  SYNTAX_TAG_ROLES.map(({ tags, role }) => ({ tag: tags, class: `syn-${role}` })),
)
