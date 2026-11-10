---
'@namzu/sdk': patch
---

A tool's own `maxOutputChars` now also bounds its result when another tool calls it through `dispatchTool` and the model-visible text when it differs from the host text. Before, only the main result honoured it and these two paths used the turn cap, so a tool capped at 30,000 characters could show up to 40,000.
