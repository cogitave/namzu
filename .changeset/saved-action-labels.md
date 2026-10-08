---
"@namzu/sdk": minor
"@namzu/cli": patch
---

`tool_completed` gains an optional `savedPresentation`: one label line (at most 200
characters) or a command's first line, never the output, journaled for every call that
has no diff, and for an external engine's tools from a name map. Nothing existing
changes: `presentation` keeps its diff and cancelled/declined shapes, and live hosts
that ignore the new field behave as before. A host that replays history can read
`presentation ?? savedPresentation` so a reopened conversation names its actions
instead of showing a placeholder. The desktop host does.
