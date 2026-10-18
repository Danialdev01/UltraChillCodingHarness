---
name: chart
description: Choosing a chart type and writing a themed Vega-Lite spec plus data table for doc_chart or a vega-lite fence. Load before putting any data chart in a document.
---

# Data charts

Write a Vega-Lite spec and the data. Never write drawing code. The house theme is applied automatically, so don't set colours, fonts or the background yourself.

Inline in the Markdown:

````markdown
```vega-lite {caption="p95 latency by region, October" #fig-latency}
{"data": {"values": [{"region": "eu", "ms": 120}, {"region": "us", "ms": 95}]},
 "mark": "bar",
 "encoding": {"x": {"field": "region", "type": "nominal", "sort": "-y"},
              "y": {"field": "ms", "type": "quantitative", "title": "p95 (ms)"}}}
```
````

Or standalone: `doc_chart(spec, data, out)`, where `data` is the path of a CSV or JSON table in the workspace.

## Which chart

| question | chart |
|---|---|
| compare categories | bar, sorted by value (`"sort": "-y"`) |
| change over time | line (with `"type": "temporal"` on x) |
| part of a whole, 2–4 parts | stacked bar; a pie only if asked |
| distribution | histogram (`"bin": true`) |
| two measures together | scatter (`point`) |

## Rules

- Each chart answers one question, and the caption states that question's answer: "EU latency is 25 % above US".
- Give axes a title with units. Start the y axis at zero for bars.
- Use 8 series at most. When there are more, show the top 7 plus "other".
- Every number comes from a source in the fact sheet. Never invent data to fill a chart.
- The default size is 460×260. Set `width` only for a deliberately wide chart.
