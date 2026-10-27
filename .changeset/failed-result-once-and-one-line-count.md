---
'@namzu/sdk': patch
'@namzu/cli': patch
---

A failed tool result no longer ends with a second, generic "Error: Tool execution failed" when the tool already explained itself in its output, so the model and the terminal see the message once. A `read` of a file that ends with a newline now reports the same line count in its header data, its partial-view note and its past-end warning, and no longer returns an empty numbered row after the last line.
