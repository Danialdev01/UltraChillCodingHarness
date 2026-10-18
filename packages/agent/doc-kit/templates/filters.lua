-- Pandoc filter for the Typst path.
--
-- `::: note` (or tip, important, warning, caution) becomes the template's
-- callout box. Everything else is left to pandoc's own Typst writer.

local kinds = { note = true, tip = true, important = true, warning = true, caution = true }

function Div(el)
  if FORMAT ~= "typst" then
    return nil
  end
  for _, class in ipairs(el.classes) do
    if kinds[class] then
      local blocks = { pandoc.RawBlock("typst", '#callout(kind: "' .. class .. '")[') }
      for _, block in ipairs(el.content) do
        table.insert(blocks, block)
      end
      table.insert(blocks, pandoc.RawBlock("typst", "]"))
      return blocks
    end
  end
  return nil
end
