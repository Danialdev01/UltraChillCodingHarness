import { HighlightStyle } from "@codemirror/language"
import { tags as t } from "@lezer/highlight"

import type { SyntaxRole } from "./syntax-theme.js"

/**
 * The editor's highlight style, coloured entirely by `--syn-*` variables.
 *
 * Nothing here is a colour: each rule names a role, and the role's variable
 * is whatever the theme settings painted onto <html> -- or the stylesheet's
 * light/dark default when nothing was. That is what lets a change in the
 * settings show up in an open editor without rebuilding it.
 *
 * The mapping from Lezer's tags is the same one CodeMirror's default style
 * makes, folded down to the roles a person would actually want to colour
 * separately.
 */
const roleColor = (role: SyntaxRole) => `var(--syn-${role})`

export const syntaxHighlightStyle = HighlightStyle.define([
  { tag: [t.keyword, t.modifier, t.controlKeyword, t.operatorKeyword, t.definitionKeyword, t.moduleKeyword], color: roleColor("keyword") },
  { tag: [t.string, t.special(t.string), t.character], color: roleColor("string") },
  { tag: [t.number, t.integer, t.float, t.bool, t.atom, t.null, t.literal, t.unit, t.color], color: roleColor("number") },
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: roleColor("comment"), fontStyle: "italic" },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.function(t.definition(t.variableName)), t.macroName], color: roleColor("function") },
  { tag: [t.variableName, t.definition(t.variableName), t.local(t.variableName), t.name, t.labelName, t.self], color: roleColor("variable") },
  { tag: [t.propertyName, t.definition(t.propertyName), t.special(t.variableName)], color: roleColor("property") },
  { tag: [t.typeName, t.className, t.namespace, t.annotation, t.standard(t.typeName)], color: roleColor("type") },
  { tag: [t.operator, t.arithmeticOperator, t.logicOperator, t.compareOperator, t.definitionOperator, t.updateOperator, t.derefOperator, t.bitwiseOperator], color: roleColor("operator") },
  { tag: [t.punctuation, t.bracket, t.paren, t.brace, t.squareBracket, t.angleBracket, t.separator, t.meta, t.processingInstruction], color: roleColor("punctuation") },
  { tag: [t.tagName, t.standard(t.tagName)], color: roleColor("tag") },
  { tag: [t.attributeName, t.attributeValue], color: roleColor("attribute") },
  { tag: [t.heading, t.heading1, t.heading2, t.heading3, t.heading4, t.heading5, t.heading6], color: roleColor("heading"), fontWeight: "bold" },
  { tag: t.strong, fontWeight: "bold" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strikethrough, textDecoration: "line-through" },
  { tag: [t.link, t.url, t.regexp, t.escape, t.inserted], color: roleColor("link") },
  { tag: t.link, textDecoration: "underline" },
  { tag: [t.invalid, t.deleted], color: roleColor("invalid") },
])
