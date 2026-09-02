---
"@namzu/cli": minor
---

Two composer prefixes that are not prompts. A line starting with `!` runs on the host as the operator's own command — no model call, no authorization gate, no sandbox, because the operator is not a tool call — with a transcript row, a pending glyph while it runs, a 60 s cap that kills the command's process group, and its output handed to the model on the next turn. A line starting with `#` is remembered, the way `/remember` is.
